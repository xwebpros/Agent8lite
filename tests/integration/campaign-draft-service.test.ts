import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CampaignDraftService,
  type CampaignMutation,
  type CampaignWrite,
} from "../../apps/api/src/marketing";
import { appendCampaignDraftEvent } from "../../apps/api/src/marketing/events";
import { dispatchOutbox } from "../../apps/worker/src/outbox";
import eventSchema from "../../packages/contracts/internal/native-campaign-draft-event-v1.schema.json";
import { fixtures } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import {
  withTenantTransaction,
  type TenantContext,
  type VerifiedIdentityContext,
} from "../../packages/db/tenant-transaction";
import { ApiSession, apiOrigin, assertContract, assertProblem, type Schemas } from "../helpers/api";

for (const variable of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL", "TEST_WORKER_DATABASE_URL"]) {
  const url = new URL(process.env[variable] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Campaign service acceptance requires the owned disposable isolated batch runner.");
}
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const worker = new Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 1 });
let ownerHttp: ApiSession;
let agentHttp: ApiSession;
const ownerA = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const ownerB = { userId: fixtures.ownerUser, organizationId: fixtures.orgB };
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateEvent = ajv.compile(eventSchema);
type Actor = VerifiedIdentityContext & { memberId: string; roleId: string };

const input = (): CampaignWrite => ({
  name: "PRIVATE_SYNTHETIC_CAMPAIGN_" + randomUUID(),
  category: "PRIVATE_SYNTHETIC_CATEGORY",
});
async function use<T>(
  identity: VerifiedIdentityContext,
  operation: (service: CampaignDraftService, client: PoolClient, context: TenantContext) => Promise<T>,
) {
  return withTenantTransaction(runtime, identity, (client, context) =>
    operation(new CampaignDraftService(client, context, randomUUID()), client, context),
  );
}
async function create(identity: VerifiedIdentityContext = ownerA, body = input(), key = randomUUID()) {
  const response = await use(identity, (service) => service.create(body, { key }));
  expect(response.status).toBe(201);
  assertContract("Campaign", response.body);
  expect(response.etag).toBe('"' + response.body.version + '"');
  return { response, body, key };
}
async function actor(
  read: "own" | "team" | "organization" | null = "organization",
  write: "own" | "team" | "organization" | null = "organization",
): Promise<Actor> {
  const userId = randomUUID(),
    memberId = randomUUID(),
    roleId = randomUUID();
  const grants = [
    ...(read ? [{ code: "campaigns.read", scope: read }] : []),
    ...(write ? [{ code: "campaigns.write", scope: write }] : []),
  ];
  await admin.query(
    "INSERT INTO app.user_identity(id,issuer,subject,display_name,email_verified)VALUES($1,'urn:estate:synthetic',$2,'Synthetic campaign test actor',true)",
    [userId, randomUUID()],
  );
  await admin.query(
    "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants)VALUES($1,$2,$3,$4)",
    [fixtures.orgA, roleId, "Synthetic campaign role " + randomUUID(), JSON.stringify(grants)],
  );
  await admin.query(
    "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active','Synthetic campaign member')",
    [fixtures.orgA, memberId, userId, roleId],
  );
  return { userId, organizationId: fixtures.orgA, memberId, roleId };
}
async function references(id: string) {
  return (
    await admin.query(
      "SELECT (SELECT count(*)::int FROM app.campaign WHERE id=$1::uuid)AS campaigns,(SELECT count(*)::int FROM app.idempotency_record WHERE response_body->>'id'=$1::text AND route_key LIKE 'marketing:draft:%')AS receipts,(SELECT count(*)::int FROM app.audit_event WHERE resource_type='campaign'AND resource_id=$1::text)AS audits,(SELECT count(*)::int FROM app.outbox WHERE aggregate_id=$1::text AND event_type='campaign.draft_metadata_changed')AS events",
      [id],
    )
  ).rows[0];
}
async function waitForExpiredLock(pid: number, queryPart: string) {
  let observed = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = (
      await admin.query(
        "SELECT a.wait_event_type,a.query,(SELECT effective_until<=clock_timestamp()FROM app.entitlement WHERE tenant_id=$1 AND feature='marketing')AS expired FROM pg_stat_activity a WHERE pid=$2",
        [fixtures.orgA, pid],
      )
    ).rows[0];
    if (row?.wait_event_type === "Lock" && row.query.includes(queryPart)) {
      observed = true;
      if (row.expired) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    observed
      ? "The locked marketing capability did not expire."
      : "The expected genuine runtime lock wait was not observed.",
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  await assertRuntimeRole(runtime);
  await assertRuntimeRole(worker);
  expect(
    (await admin.query("SELECT name FROM public.estate_migration WHERE name LIKE '0016-%'")).rowCount,
  ).toBe(1);
  // Marketing remains unconfigured in ordinary seed data; only this guarded disposable fixture enables it.
  expect((await admin.query("SELECT id FROM app.entitlement WHERE feature='marketing'")).rowCount).toBe(0);
  for (const tenant of [fixtures.orgA, fixtures.orgB])
    await admin.query(
      "INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'marketing','enabled')",
      [tenant],
    );
  ownerHttp = await new ApiSession().signIn("owner");
  agentHttp = await new ApiSession().signIn("agent");
});
afterAll(async () => {
  await Promise.all([runtime.end(), worker.end(), admin.end()]);
});

const campaignPath = (session = ownerHttp) => `/v1/orgs/${session.orgId}/campaigns`;
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-trace-id")).toBeTruthy();
}
async function campaignHttp(response: Response, status: 200 | 201 = 200) {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  privateResponse(response);
  assertContract("Campaign", body);
  expect(response.headers.get("etag")).toBe('"' + body.version + '"');
  return { body, etag: response.headers.get("etag")! };
}
async function campaignProblem(response: Response, status: number) {
  privateResponse(response);
  expect(response.headers.get("etag")).toBeNull();
  return assertProblem(response, status);
}
function rawHttp(path: string, init: RequestInit = {}, session: ApiSession | null = ownerHttp) {
  const headers = new Headers(init.headers);
  if (session?.cookie) headers.set("cookie", session.cookie);
  return fetch(apiOrigin + path, { ...init, headers });
}

describe("registered synthetic campaign draft HTTP boundary", () => {
  it("exposes the four frozen metadata routes with private pages and preserved historical strong ETags", async () => {
    const body = input(),
      createKey = randomUUID();
    const first = await campaignHttp(await ownerHttp.command(campaignPath(), body, { key: createKey }), 201);
    expect(first.body.state).toBe("draft");
    const detailPath = `${campaignPath()}/${first.body.id}`;
    const read = await campaignHttp(await ownerHttp.request(detailPath));
    expect(read).toEqual(first);
    const conditional = await campaignHttp(
      await ownerHttp.request(detailPath, { headers: { "if-none-match": first.etag } }),
    );
    expect(conditional).toEqual(first);
    const page = await ownerHttp.request(campaignPath() + "?limit=1");
    expect(page.status).toBe(200);
    privateResponse(page);
    expect(page.headers.get("etag")).toBeNull();
    assertContract("PageCampaign", await page.json());
    const secondBody = input(),
      secondKey = randomUUID();
    const second = await campaignHttp(
      await ownerHttp.command(detailPath, secondBody, {
        method: "PATCH",
        key: secondKey,
        revision: first.etag,
      }),
    );
    expect(second.etag).toBe('"2"');
    const third = await campaignHttp(
      await ownerHttp.command(detailPath, input(), { method: "PATCH", revision: second.etag }),
    );
    expect(third.etag).toBe('"3"');
    expect(
      await campaignHttp(await ownerHttp.command(campaignPath(), body, { key: createKey }), 201),
    ).toEqual(first);
    expect(
      await campaignHttp(
        await ownerHttp.command(detailPath, secondBody, {
          method: "PATCH",
          key: secondKey,
          revision: first.etag,
        }),
      ),
    ).toEqual(second);
    expect(
      (
        await campaignProblem(
          await ownerHttp.command(detailPath, secondBody, { method: "PATCH", revision: first.etag }),
          412,
        )
      ).code,
    ).toBe("revision_stale");
    expect(
      (
        await campaignProblem(
          await ownerHttp.command(campaignPath(), { ...body, category: "changed" }, { key: createKey }),
          409,
        )
      ).code,
    ).toBe("idempotency_conflict");
    expect((await campaignHttp(await ownerHttp.request(detailPath))).body).toEqual(third.body);
    expect(await references(first.body.id)).toEqual({ campaigns: 1, receipts: 3, audits: 3, events: 3 });
  });

  it("enforces CSRF origin idempotency revision and bounded closed JSON without leaking private request values", async () => {
    const fixture = await create(),
      path = `${campaignPath()}/${fixture.response.body.id}`,
      marker = "PRIVATE_SYNTHETIC_REJECTED_" + randomUUID();
    const writes: { path: string; init: RequestInit; status: number; code?: string }[] = [
      {
        path: campaignPath(),
        init: {
          method: "POST",
          headers: {
            origin: process.env.TEST_WEB_ORIGIN!,
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({ name: marker, category: "test" }),
        },
        status: 403,
        code: "csrf_invalid",
      },
      {
        path: campaignPath(),
        init: {
          method: "POST",
          headers: {
            origin: "https://attacker.invalid",
            "content-type": "application/json",
            "x-csrf-token": ownerHttp.csrf,
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({ name: marker, category: "test" }),
        },
        status: 403,
        code: "origin_denied",
      },
      {
        path: campaignPath(),
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": ownerHttp.csrf,
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({ name: marker, category: "test" }),
        },
        status: 403,
        code: "origin_denied",
      },
      {
        path: campaignPath(),
        init: {
          method: "POST",
          headers: {
            origin: process.env.TEST_WEB_ORIGIN!,
            "content-type": "application/json",
            "x-csrf-token": ownerHttp.csrf,
          },
          body: JSON.stringify({ name: marker, category: "test" }),
        },
        status: 400,
        code: "idempotency_required",
      },
    ];
    for (const command of writes) {
      const problem = await campaignProblem(await rawHttp(command.path, command.init), command.status);
      if (command.code) expect(problem.code).toBe(command.code);
      expect(JSON.stringify(problem)).not.toContain(marker);
    }
    await campaignProblem(await ownerHttp.command(campaignPath(), input(), { key: "with space" }), 400);
    for (const revision of [undefined, "1", 'W/"1"', '"9007199254740992"'])
      await campaignProblem(await ownerHttp.command(path, input(), { method: "PATCH", revision }), 400);
    for (const body of [
      { name: marker, category: "test", state: "active" },
      { name: " ", category: "test" },
      {},
      { name: "x".repeat(121), category: "test" },
    ])
      expect(
        JSON.stringify(await campaignProblem(await ownerHttp.command(campaignPath(), body), 422)),
      ).not.toContain(marker);
    for (const [body, status] of [
      ['{"name":"' + marker + '",', 400],
      [JSON.stringify({ name: marker, category: "x".repeat(256 * 1024) }), 413],
    ] as const) {
      const response = await rawHttp(campaignPath(), {
        method: "POST",
        headers: {
          origin: process.env.TEST_WEB_ORIGIN!,
          "content-type": "application/json",
          "x-csrf-token": ownerHttp.csrf,
          "idempotency-key": randomUUID(),
        },
        body,
      });
      expect(JSON.stringify(await campaignProblem(response, status))).not.toContain(marker);
    }
    expect(await references(fixture.response.body.id)).toEqual({
      campaigns: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
    expect((await admin.query("SELECT id FROM app.campaign WHERE name=$1", [marker])).rows).toEqual([]);
  });

  it("validates registered scalar query parameters and denies duplicate values instead of ignoring filters", async () => {
    for (const query of [
      "?limit=1&limit=2",
      "?cursor=a&cursor=b",
      "?limit=01",
      "?limit=101",
      "?limit=false",
      "?filter=%7B%7D",
      "?cursor=",
    ])
      await campaignProblem(await ownerHttp.request(campaignPath() + query), 422);
    await campaignProblem(await ownerHttp.request(campaignPath() + "/not-a-uuid"), 422);
  });

  it("uses verified session organization membership and permissions instead of supplied member or tenant identifiers", async () => {
    const fixture = await create(),
      detailPath = `${campaignPath()}/${fixture.response.body.id}`;
    await campaignProblem(await rawHttp(detailPath, {}, null), 401);
    await campaignProblem(
      await ownerHttp.request(`/v1/orgs/${fixtures.orgB}/campaigns/${fixture.response.body.id}`),
      403,
    );
    await campaignProblem(
      await agentHttp.request(detailPath, { headers: { "x-member-id": ownerHttp.memberId } }),
      403,
    );
    expect(
      (
        await campaignHttp(
          await ownerHttp.request(detailPath, { headers: { "x-member-id": agentHttp.memberId } }),
        )
      ).body.id,
    ).toBe(fixture.response.body.id);
    const otherOrg = await new ApiSession().signIn("owner");
    expect((await otherOrg.switchOrganization(fixtures.orgB)).status).toBe(200);
    await campaignProblem(
      await otherOrg.request(`${campaignPath(otherOrg)}/${fixture.response.body.id}`),
      404,
    );
    await campaignProblem(
      await otherOrg.command(`${campaignPath(otherOrg)}/${fixture.response.body.id}`, input(), {
        method: "PATCH",
        revision: '"1"',
      }),
      404,
    );
  });

  it("revokes registered API reads and cached writes with current role and membership changes", async () => {
    const permitted = await actor(),
      fixture = await create();
    const member = (
      await admin.query("SELECT role_id,status FROM app.membership WHERE id=$1", [fixtures.agentMemberA])
    ).rows[0];
    try {
      await admin.query("UPDATE app.membership SET role_id=$2 WHERE id=$1", [
        fixtures.agentMemberA,
        permitted.roleId,
      ]);
      const detailPath = `${campaignPath()}/${fixture.response.body.id}`;
      expect((await campaignHttp(await agentHttp.request(detailPath))).body.id).toBe(
        fixture.response.body.id,
      );
      const body = input(),
        key = randomUUID();
      const created = await campaignHttp(await agentHttp.command(campaignPath(), body, { key }), 201);
      await admin.query("UPDATE app.role_definition SET permission_grants='[]' WHERE id=$1", [
        permitted.roleId,
      ]);
      await campaignProblem(await agentHttp.request(detailPath), 403);
      await campaignProblem(await agentHttp.command(campaignPath(), body, { key }), 403);
      await admin.query("UPDATE app.role_definition SET permission_grants=$2::jsonb WHERE id=$1", [
        permitted.roleId,
        JSON.stringify([
          { code: "campaigns.read", scope: "organization" },
          { code: "campaigns.write", scope: "organization" },
        ]),
      ]);
      await admin.query("UPDATE app.membership SET status='disabled' WHERE id=$1", [fixtures.agentMemberA]);
      await campaignProblem(await agentHttp.request(detailPath), 403);
      await campaignProblem(await agentHttp.command(campaignPath(), body, { key }), 403);
      expect(await references(created.body.id)).toEqual({ campaigns: 1, receipts: 1, audits: 1, events: 1 });
    } finally {
      await admin.query("UPDATE app.membership SET role_id=$2,status=$3 WHERE id=$1", [
        fixtures.agentMemberA,
        member.role_id,
        member.status,
      ]);
    }
  });

  it("checks current marketing capability and draft lifecycle before registered historical replay", async () => {
    const body = input(),
      key = randomUUID();
    const fixture = await campaignHttp(await ownerHttp.command(campaignPath(), body, { key }), 201);
    const detailPath = `${campaignPath()}/${fixture.body.id}`;
    try {
      for (const change of [
        "state='disabled'",
        "state='enabled',effective_until=clock_timestamp()-interval '1 second'",
      ]) {
        await admin.query(`UPDATE app.entitlement SET ${change} WHERE tenant_id=$1 AND feature='marketing'`, [
          fixtures.orgA,
        ]);
        expect((await campaignProblem(await ownerHttp.request(detailPath), 403)).code).toBe(
          "entitlement_disabled",
        );
        await campaignProblem(await ownerHttp.command(campaignPath(), body, { key }), 403);
        await campaignProblem(
          await ownerHttp.command(detailPath, input(), { method: "PATCH", revision: fixture.etag }),
          403,
        );
      }
    } finally {
      await admin.query(
        "UPDATE app.entitlement SET state='enabled',effective_until=NULL WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
    }
    await admin.query("UPDATE app.campaign SET state='archived' WHERE id=$1", [fixture.body.id]);
    await campaignProblem(await ownerHttp.request(detailPath), 404);
    await campaignProblem(await ownerHttp.command(campaignPath(), body, { key }), 404);
    await campaignProblem(
      await ownerHttp.command(detailPath, input(), { method: "PATCH", revision: fixture.etag }),
      404,
    );
    expect(await references(fixture.body.id)).toEqual({ campaigns: 1, receipts: 1, audits: 1, events: 1 });
  });

  it("denies synthetic non-loopback forwarded clients and mixed staff/member identities before any campaign command", async () => {
    const fixture = await create(),
      detailPath = `${campaignPath()}/${fixture.response.body.id}`;
    for (const forwarded of ["198.51.100.1", "127.0.0.1, 198.51.100.1"]) {
      expect(
        (
          await campaignProblem(
            await ownerHttp.request(detailPath, { headers: { "x-forwarded-for": forwarded } }),
            403,
          )
        ).code,
      ).toBe("loopback_required");
      await campaignProblem(
        await ownerHttp.request(campaignPath(), {
          method: "POST",
          headers: {
            "x-forwarded-for": forwarded,
            "x-csrf-token": ownerHttp.csrf,
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify(input()),
        }),
        403,
      );
    }
    const mixed = await rawHttp(
      detailPath,
      { headers: { cookie: ownerHttp.cookie + "; estate_staff_session=" + "a".repeat(64) } },
      null,
    );
    expect((await campaignProblem(mixed, 403)).code).toBe("identity_context_ambiguous");
    expect(await references(fixture.response.body.id)).toEqual({
      campaigns: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
  });

  it("keeps publication enrollments broadcast and archive commands unavailable with no lifecycle or delivery effects", async () => {
    const fixture = await create(),
      id = fixture.response.body.id;
    const paths: { path: string; method: string; body?: unknown }[] = [
      { path: `${campaignPath()}/${id}/publish`, method: "POST", body: {} },
      { path: `${campaignPath()}/${id}/archive`, method: "POST", body: {} },
      {
        path: `/v1/orgs/${ownerHttp.orgId}/campaign-versions/${randomUUID()}/publish`,
        method: "POST",
        body: {},
      },
      {
        path: `/v1/orgs/${ownerHttp.orgId}/enrollments`,
        method: "POST",
        body: {
          leadId: fixtures.leadA,
          campaignVersionId: randomUUID(),
        } satisfies Schemas["EnrollmentWrite"],
      },
      {
        path: `/v1/orgs/${ownerHttp.orgId}/broadcast-previews`,
        method: "POST",
        body: {
          messageDesignId: randomUUID(),
          filter: {},
          timezone: "UTC",
        } satisfies Schemas["BroadcastRequest"],
      },
      {
        path: `/v1/orgs/${ownerHttp.orgId}/broadcast-confirmations`,
        method: "POST",
        body: {
          previewId: randomUUID(),
          acceptedTermsVersion: "synthetic-never-send",
        } satisfies Schemas["PreviewConfirm"],
      },
      { path: `/public/campaigns/${id}`, method: "GET" },
    ];
    const versionIndex = await ownerHttp.request(`${campaignPath()}/${id}/versions`);
    expect(versionIndex.status).toBe(200);
    const versionPage = await versionIndex.json();
    assertContract("PageCampaignVersion", versionPage);
    expect(versionPage).toEqual({ items: [], hasMore: false, nextCursor: null });
    for (const command of paths) {
      const response =
        command.method === "GET"
          ? await ownerHttp.request(command.path)
          : await ownerHttp.command(command.path, command.body, { revision: '"1"' });
      expect([404, 503]).toContain(response.status);
      const problem = await campaignProblem(response, response.status);
      expect(["route_unavailable", "resource_unavailable", "feature_not_implemented"]).toContain(
        problem.code,
      );
    }
    expect((await campaignHttp(await ownerHttp.request(`${campaignPath()}/${id}`))).body.state).toBe("draft");
    expect(await references(id)).toEqual({ campaigns: 1, receipts: 1, audits: 1, events: 1 });
    for (const table of [
      "campaign_version",
      "campaign_step",
      "enrollment",
      "scheduled_action",
      "delivery_attempt",
    ])
      expect((await admin.query(`SELECT count(*)::int AS count FROM app.${table}`)).rows[0].count).toBe(0);
  });
});

describe("actual0016 native campaign draft service", () => {
  it("returns generated draft metadata and explicit revision headers without workflow or delivery side effects", async () => {
    const raw = { name: "  " + input().name + "  ", category: "  synthetic-test  " };
    const first = await create(ownerA, raw);
    expect(first.response.body).toMatchObject({
      name: raw.name.trim(),
      category: "synthetic-test",
      state: "draft",
      version: 1,
    });
    const current = await use(ownerA, (service) => service.get(first.response.body.id));
    expect(current).toEqual(first.response.body);
    const page = await use(ownerA, (service) => service.list());
    assertContract("PageCampaign", page);
    expect(page.items.map((campaign) => campaign.id)).toContain(current.id);
    expect(page.items.every((campaign) => campaign.state === "draft")).toBe(true);
    const changed = await use(ownerA, (service) =>
      service.update(
        current.id,
        { name: raw.name.trim(), category: "changed" },
        { key: randomUUID(), ifMatch: first.response.etag },
      ),
    );
    expect(changed).toMatchObject({
      status: 200,
      etag: '"2"',
      body: { version: 2, state: "draft", category: "changed" },
    });
    assertContract("Campaign", changed.body);
    expect(await references(current.id)).toEqual({ campaigns: 1, receipts: 2, audits: 2, events: 2 });
    for (const table of [
      "campaign_version",
      "campaign_step",
      "enrollment",
      "scheduled_action",
      "delivery_attempt",
    ])
      expect((await admin.query(`SELECT count(*)::int AS count FROM app.${table}`)).rows[0].count).toBe(0);
  });

  it.each(["own", "team"] as const)(
    "denies stored %s campaign grants and forged organization-scoped typed grants",
    async (scope) => {
      const member = await actor(scope, scope);
      const fixture = await create();
      await expect(use(member, (service) => service.get(fixture.response.body.id))).rejects.toMatchObject({
        status: 403,
        code: "permission_denied",
      });
      await expect(
        use(member, (service) => service.create(input(), { key: randomUUID() })),
      ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
      await expect(
        withTenantTransaction(runtime, member, (client, context) =>
          new CampaignDraftService(
            client,
            { ...context, permissions: [{ code: "campaigns.write", scope: "organization" }] },
            randomUUID(),
          ).create(input(), { key: randomUUID() }),
        ),
      ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
    },
  );

  it("separates organization read and write permissions", async () => {
    const readOnly = await actor("organization", null);
    const writeOnly = await actor(null, "organization");
    const fixture = await create();
    expect((await use(readOnly, (service) => service.get(fixture.response.body.id))).id).toBe(
      fixture.response.body.id,
    );
    await expect(
      use(readOnly, (service) =>
        service.update(fixture.response.body.id, input(), { key: randomUUID(), ifMatch: '"1"' }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const written = await create(writeOnly);
    await expect(use(writeOnly, (service) => service.get(written.response.body.id))).rejects.toMatchObject({
      status: 403,
    });
    await expect(use(writeOnly, (service) => service.list())).rejects.toMatchObject({ status: 403 });
  });

  it("reauthorizes current role grants before a cached replay and ignores forged retained grants", async () => {
    const member = await actor();
    const fixture = await create(member);
    await admin.query("UPDATE app.role_definition SET permission_grants='[]'WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      member.roleId,
    ]);
    await expect(
      use(member, (service) => service.create(fixture.body, { key: fixture.key })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      withTenantTransaction(runtime, member, (client, context) =>
        new CampaignDraftService(
          client,
          {
            ...context,
            permissions: [
              { code: "campaigns.read", scope: "organization" },
              { code: "campaigns.write", scope: "organization" },
            ],
          },
          randomUUID(),
        ).get(fixture.response.body.id),
      ),
    ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
    expect(await references(fixture.response.body.id)).toEqual({
      campaigns: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
  });

  it("requires current membership and rejects a foreign organization identity before invoking the service", async () => {
    const member = await actor();
    const fixture = await create(member);
    await expect(
      use({ ...member, organizationId: fixtures.orgB }, (service) => service.list()),
    ).rejects.toMatchObject({ status: 403, code: "membership_required" });
    await admin.query("UPDATE app.membership SET status='disabled'WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      member.memberId,
    ]);
    let invoked = false;
    await expect(
      use(member, async (service) => {
        invoked = true;
        return service.create(fixture.body, { key: fixture.key });
      }),
    ).rejects.toMatchObject({ status: 403, code: "membership_required" });
    expect(invoked).toBe(false);
  });

  it("denies disabled and expired marketing capability for reads writes and cached replay", async () => {
    const fixture = await create();
    try {
      for (const clause of [
        "state='disabled'",
        "state='enabled',effective_until=clock_timestamp()-interval '1 second'",
      ]) {
        await admin.query(`UPDATE app.entitlement SET ${clause} WHERE tenant_id=$1 AND feature='marketing'`, [
          fixtures.orgA,
        ]);
        await expect(use(ownerA, (service) => service.get(fixture.response.body.id))).rejects.toMatchObject({
          status: 403,
          code: "entitlement_disabled",
        });
        await expect(
          use(ownerA, (service) => service.create(fixture.body, { key: fixture.key })),
        ).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
        await expect(
          use(ownerA, (service) =>
            service.update(fixture.response.body.id, input(), { key: randomUUID(), ifMatch: '"1"' }),
          ),
        ).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
      }
    } finally {
      await admin.query(
        "UPDATE app.entitlement SET state='enabled',effective_until=NULL WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
    }
    expect(await references(fixture.response.body.id)).toEqual({
      campaigns: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
  });

  it("denies retained typed authority with missing transaction context or forged tenant/member values", async () => {
    const fixture = await create();
    const retained = await withTenantTransaction(runtime, ownerA, async (_client, context) => context);
    const client = await runtime.connect();
    try {
      await expect(
        new CampaignDraftService(client, retained, randomUUID()).get(fixture.response.body.id),
      ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
      expect((await client.query("SELECT count(*)::int AS count FROM app.campaign")).rows[0].count).toBe(0);
    } finally {
      client.release();
    }
    for (const override of [{ organizationId: fixtures.orgB }, { memberId: fixtures.ownerMemberB }])
      await expect(
        withTenantTransaction(runtime, ownerA, (current, context) =>
          new CampaignDraftService(current, { ...context, ...override }, randomUUID()).get(
            fixture.response.body.id,
          ),
        ),
      ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
  });

  it("isolates resource and command keys across tenants", async () => {
    const key = randomUUID(),
      body = input();
    const a = await create(ownerA, body, key),
      b = await create(ownerB, body, key);
    expect(a.response.body.id).not.toBe(b.response.body.id);
    await expect(use(ownerA, (service) => service.get(b.response.body.id))).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      use(ownerB, (service) =>
        service.update(a.response.body.id, input(), { key: randomUUID(), ifMatch: '"1"' }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("concurrent identical creates commit one campaign receipt audit and safe reference event", async () => {
    const body = input(),
      key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => use(ownerA, (service) => service.create(body, { key }))),
    );
    for (const response of responses) expect(response).toEqual(responses[0]);
    expect(responses[0]).toMatchObject({ status: 201, etag: '"1"', body: { state: "draft", version: 1 } });
    const id = responses[0].body.id;
    expect(await references(id)).toEqual({ campaigns: 1, receipts: 1, audits: 1, events: 1 });
    const event = (await admin.query("SELECT * FROM app.outbox WHERE aggregate_id=$1", [id])).rows[0];
    expect(validateEvent(event.payload), JSON.stringify(validateEvent.errors)).toBe(true);
    expect(event).toMatchObject({
      tenant_id: fixtures.orgA,
      initiating_actor_id: fixtures.ownerUser,
      event_type: "campaign.draft_metadata_changed",
      aggregate_id: id,
      published_at: null,
    });
    expect(event.payload).toMatchObject({
      eventId: event.id,
      tenantId: fixtures.orgA,
      aggregateId: id,
      payload: { campaignId: id, metadataRevision: 1, operation: "create" },
    });
    expect(event.payload.occurredAt).toBe(event.payload.ingestedAt);
    const audit = (
      await admin.query(
        "SELECT safe_diff FROM app.audit_event WHERE resource_id=$1 AND resource_type='campaign'",
        [id],
      )
    ).rows[0];
    expect(audit.safe_diff).toEqual({ resourceVersion: 1 });
    expect(JSON.stringify({ event: event.payload, audit: audit.safe_diff })).not.toContain(body.name);
    expect(JSON.stringify(event.payload)).not.toContain(body.category);
    await expect(
      use(ownerA, (service) => service.create({ ...body, name: "Changed input" }, { key })),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
  });

  it("keeps infinite receipts and replays historical body and ETag after later metadata edits", async () => {
    const first = await create();
    const id = first.response.body.id,
      updateKey = randomUUID(),
      secondBody = input();
    const second = await use(ownerA, (service) =>
      service.update(id, secondBody, { key: updateKey, ifMatch: '"1"' }),
    );
    const third = await use(ownerA, (service) =>
      service.update(id, input(), { key: randomUUID(), ifMatch: '"2"' }),
    );
    expect(
      (
        await admin.query(
          "SELECT expires_at::text AS expiry FROM app.idempotency_record WHERE response_body->>'id'=$1",
          [id],
        )
      ).rows.every((row) => row.expiry === "infinity"),
    ).toBe(true);
    await admin.query(
      "UPDATE app.idempotency_record SET created_at=created_at-interval '1 year'WHERE response_body->>'id'=$1",
      [id],
    );
    expect(await use(ownerA, (service) => service.create(first.body, { key: first.key }))).toEqual(
      first.response,
    );
    expect(
      await use(ownerA, (service) => service.update(id, secondBody, { key: updateKey, ifMatch: '"1"' })),
    ).toEqual(second);
    await expect(
      use(ownerA, (service) => service.update(id, secondBody, { key: updateKey, ifMatch: '"2"' })),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    await expect(
      use(ownerA, (service) => service.update(id, secondBody, { key: randomUUID(), ifMatch: '"1"' })),
    ).rejects.toMatchObject({ status: 412 });
    expect(await use(ownerA, (service) => service.get(id))).toEqual(third.body);
    expect(await references(id)).toEqual({ campaigns: 1, receipts: 3, audits: 3, events: 3 });
  });

  it("cannot use cached metadata responses once the current source becomes non-draft", async () => {
    for (const state of ["active", "paused", "archived"]) {
      const fixture = await create();
      await admin.query("UPDATE app.campaign SET state=$2 WHERE id=$1", [fixture.response.body.id, state]);
      await expect(use(ownerA, (service) => service.get(fixture.response.body.id))).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        use(ownerA, (service) => service.create(fixture.body, { key: fixture.key })),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        use(ownerA, (service) =>
          service.update(fixture.response.body.id, input(), { key: randomUUID(), ifMatch: '"1"' }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        (await use(ownerA, (service) => service.list({ limit: "100" }))).items.map((item) => item.id),
      ).not.toContain(fixture.response.body.id);
    }
  });

  it("two independent update keys on one revision yield one success and one stale precondition", async () => {
    const fixture = await create();
    const outcomes = await Promise.all(
      [input(), input()].map((body) =>
        use(ownerA, (service) =>
          service.update(fixture.response.body.id, body, { key: randomUUID(), ifMatch: '"1"' }),
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
      ),
    );
    const succeeded = outcomes.filter(
      (outcome): outcome is { value: CampaignMutation } => "value" in outcome,
    );
    const rejected = outcomes.filter((outcome): outcome is { error: unknown } => "error" in outcome);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].error).toMatchObject({ status: 412, code: "revision_stale" });
    expect(succeeded[0].value).toMatchObject({ status: 200, etag: '"2"' });
    expect(await references(fixture.response.body.id)).toEqual({
      campaigns: 1,
      receipts: 2,
      audits: 2,
      events: 2,
    });
  });

  it("rejects missing weak malformed and unsafe revision headers without writing", async () => {
    const fixture = await create();
    for (const ifMatch of [
      undefined,
      "",
      "1",
      'W/"1"',
      '"0"',
      '"01"',
      '"1',
      '1"',
      '"1,2"',
      '"9007199254740992"',
    ])
      await expect(
        use(ownerA, (service) =>
          service.update(fixture.response.body.id, input(), { key: randomUUID(), ifMatch }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      use(ownerA, (service) =>
        service.update(fixture.response.body.id, input(), { key: randomUUID(), ifMatch: '"99"' }),
      ),
    ).rejects.toMatchObject({ status: 412 });
    expect(await references(fixture.response.body.id)).toEqual({
      campaigns: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
  });

  it("rejects nonclosed draft inputs keys and non-scalar queries", async () => {
    for (const body of [
      null,
      [],
      {},
      { name: " ", category: "test" },
      { name: "test", category: " " },
      { name: "n", category: "c", state: "active" },
      { name: "x".repeat(121), category: "test" },
      { name: "n", category: "x".repeat(81) },
    ])
      await expect(
        use(ownerA, (service) => service.create(body as CampaignWrite, { key: randomUUID() })),
      ).rejects.toMatchObject({ status: 422 });
    for (const key of [undefined, "", "with space", "\n", "x".repeat(101)])
      await expect(use(ownerA, (service) => service.create(input(), { key }))).rejects.toMatchObject({
        status: 400,
      });
    for (const query of [
      { limit: 0 },
      { limit: "01" },
      { limit: false },
      { limit: ["1", "2"] },
      { cursor: ["a"] },
      { cursor: "" },
      { filter: "{}" },
    ])
      await expect(use(ownerA, (service) => service.list(query))).rejects.toMatchObject({ status: 422 });
  });

  it("binds signed cursors to tenant actor limit and current grants", async () => {
    await create();
    await create();
    const first = await use(ownerA, (service) => service.list({ limit: "1" }));
    expect(first.hasMore).toBe(true);
    const cursor = first.nextCursor!;
    expect((await use(ownerA, (service) => service.list({ limit: "1", cursor }))).items[0].id).not.toBe(
      first.items[0].id,
    );
    const other = await actor();
    await expect(use(other, (service) => service.list({ limit: "1", cursor }))).rejects.toMatchObject({
      status: 422,
      code: "cursor_invalid",
    });
    await expect(use(ownerB, (service) => service.list({ limit: "1", cursor }))).rejects.toMatchObject({
      status: 422,
      code: "cursor_invalid",
    });
    await expect(use(ownerA, (service) => service.list({ limit: "2", cursor }))).rejects.toMatchObject({
      status: 422,
    });
    const signatureStart = cursor.lastIndexOf(".") + 1;
    expect(signatureStart).toBeGreaterThan(0);
    const modified =
      cursor.slice(0, signatureStart) +
      (cursor[signatureStart] === "A" ? "B" : "A") +
      cursor.slice(signatureStart + 1);
    await expect(
      use(ownerA, (service) => service.list({ limit: "1", cursor: modified })),
    ).rejects.toMatchObject({ status: 422 });
    const custom = await use(other, (service) => service.list({ limit: "1" }));
    await admin.query(
      "UPDATE app.role_definition SET permission_grants=permission_grants||$3::jsonb WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, other.roleId, JSON.stringify([{ code: "crm.contacts.read", scope: "own" }])],
    );
    await expect(
      use(other, (service) => service.list({ limit: "1", cursor: custom.nextCursor! })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it.each(["advisory", "campaign"] as const)(
    "rechecks DB-clock capability expiry after an observed %s lock wait",
    async (lock) => {
      const fixture = await create(),
        id = fixture.response.body.id,
        key = randomUUID();
      const blocker = await admin.connect(),
        started = deferred<number>();
      let held = false;
      let pending: Promise<{ value: CampaignMutation } | { error: unknown }> | undefined;
      try {
        await blocker.query("BEGIN");
        held = true;
        if (lock === "advisory")
          await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `${fixtures.orgA}:${fixtures.ownerUser}:marketing:draft:update:${id}:${key}`,
          ]);
        else await blocker.query("SELECT id FROM app.campaign WHERE id=$1 FOR UPDATE", [id]);
        await admin.query(
          "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '1 second'WHERE tenant_id=$1 AND feature='marketing'",
          [fixtures.orgA],
        );
        pending = use(ownerA, async (service, client) => {
          started.resolve((await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid);
          return service.update(id, input(), { key, ifMatch: '"1"' });
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const pid = await Promise.race([
          started.promise,
          pending.then(() => {
            throw new Error("Runtime command ended before entering the observed lock-wait fixture.");
          }),
        ]);
        await waitForExpiredLock(pid, lock === "advisory" ? "pg_advisory_xact_lock" : "FROM app.campaign");
        await blocker.query("COMMIT");
        held = false;
        const outcome = await pending;
        expect(outcome).toHaveProperty("error");
        if ("error" in outcome)
          expect(outcome.error).toMatchObject({ status: 403, code: "entitlement_disabled" });
        expect(await references(id)).toEqual({ campaigns: 1, receipts: 1, audits: 1, events: 1 });
        expect(
          (await admin.query("SELECT name,row_version FROM app.campaign WHERE id=$1", [id])).rows[0],
        ).toEqual({ name: fixture.body.name, row_version: "1" });
      } finally {
        if (held) await blocker.query("ROLLBACK");
        if (pending) await pending;
        blocker.release();
        await admin.query(
          "UPDATE app.entitlement SET effective_until=NULL WHERE tenant_id=$1 AND feature='marketing'",
          [fixtures.orgA],
        );
      }
    },
    15_000,
  );

  it("caller rollback removes campaign metadata audit event and both command receipts atomically", async () => {
    const rollback = new Error("Synthetic campaign caller rollback");
    let id = "";
    await expect(
      use(ownerA, async (service) => {
        const first = await service.create(input(), { key: randomUUID() });
        id = first.body.id;
        await service.update(id, input(), { key: randomUUID(), ifMatch: '"1"' });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(id).not.toBe("");
    expect(await references(id)).toEqual({ campaigns: 0, receipts: 0, audits: 0, events: 0 });
  });

  it("the private event producer cannot append forged tenant actor draft revision or lifecycle references", async () => {
    const fixture = await create();
    for (const variant of ["tenant", "actor", "revision", "state", "missing"])
      await expect(
        withTenantTransaction(runtime, ownerA, (client, context) =>
          appendCampaignDraftEvent(
            client,
            {
              ...context,
              ...(variant === "tenant" ? { organizationId: fixtures.orgB } : {}),
              ...(variant === "actor" ? { userId: fixtures.agentUser } : {}),
            },
            randomUUID(),
            {
              ...fixture.response.body,
              ...(variant === "revision" ? { version: 2 } : {}),
              ...(variant === "state" ? { state: "active" as const } : {}),
              ...(variant === "missing" ? { id: randomUUID() } : {}),
            },
            "update",
          ),
        ),
      ).rejects.toMatchObject({ status: 403, code: "campaign_context_unavailable" });
    expect(await references(fixture.response.body.id)).toEqual({
      campaigns: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
  });

  it("the real lead-only dispatcher leaves the unsupported campaign family untouched without acknowledgments or delivery", async () => {
    const events = (
      await admin.query(
        "SELECT id FROM app.outbox WHERE tenant_id=$1 AND initiating_actor_id=$2 AND event_type='campaign.draft_metadata_changed'AND published_at IS NULL",
        [fixtures.orgA, fixtures.ownerUser],
      )
    ).rows.map((row) => row.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(100);
    expect(await dispatchOutbox(worker, ownerA, 100)).toEqual({ dispatched: 0, deferred: 0 });
    const rows = (
      await admin.query(
        "SELECT published_at,attempt_count,lease_until FROM app.outbox WHERE id=ANY($1::uuid[])",
        [events],
      )
    ).rows;
    for (const row of rows) expect(row).toEqual({ published_at: null, attempt_count: 0, lease_until: null });
    expect(
      (
        await admin.query("SELECT event_id FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])", [
          events,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query(
          "SELECT id FROM app.audit_event WHERE resource_type='outbox'AND resource_id=ANY($1::text[])",
          [events],
        )
      ).rows,
    ).toEqual([]);
    expect(await dispatchOutbox(worker, ownerA, 100)).toEqual({ dispatched: 0, deferred: 0 });
    const clients = await Promise.all(Array.from({ length: 8 }, () => runtime.connect()));
    try {
      for (const client of clients)
        expect(
          (
            await client.query(
              "SELECT nullif(current_setting('app.tenant_id',true),'')AS tenant,nullif(current_setting('app.actor_id',true),'')AS actor,(SELECT count(*)::int FROM app.campaign)AS visible",
            )
          ).rows[0],
        ).toEqual({ tenant: null, actor: null, visible: 0 });
    } finally {
      for (const client of clients) client.release();
    }
  });
});
