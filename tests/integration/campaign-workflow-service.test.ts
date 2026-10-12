import { createHash, randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CampaignDraftService, CampaignWorkflowService } from "../../apps/api/src/marketing";
import { appendCampaignWorkflowEvent } from "../../apps/api/src/marketing/workflow-events";
import { dispatchOutbox } from "../../apps/worker/src/outbox";
import {
  definitionOutline,
  outlineDefinition,
  type Outline,
} from "../../apps/web/components/campaign-workflow-outline";
import workflowEventSchema from "../../packages/contracts/internal/native-campaign-workflow-event-v1.schema.json";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import {
  withTenantTransaction,
  type PermissionGrant,
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
    throw new Error("Workflow acceptance requires the owned disposable isolated batch runner.");
}

const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const worker = new Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 1 });
const ownerA = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const ownerB = { userId: fixtures.ownerUser, organizationId: fixtures.orgB };
type Definition = Schemas["CampaignVersionWrite"];
type Version = Schemas["CampaignVersion"];
type Mutation = Awaited<ReturnType<CampaignWorkflowService["create"]>>;
type Actor = VerifiedIdentityContext & { memberId: string; roleId: string };
const campaignGrants: PermissionGrant[] = [
  { code: "campaigns.read", scope: "organization" },
  { code: "campaigns.write", scope: "organization" },
];
const referenceGrants: PermissionGrant[] = [
  { code: "crm.leads.read", scope: "organization" },
  { code: "crm.pipeline.read", scope: "organization" },
  { code: "crm.sources.read", scope: "organization" },
  { code: "crm.tags.read", scope: "organization" },
  { code: "members.read", scope: "organization" },
];
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateEvent = ajv.compile(workflowEventSchema);
let ownerHttp: ApiSession;
let agentHttp: ApiSession;

function definition(title = "PRIVATE_SYNTHETIC_TASK_" + randomUUID()): Definition {
  return {
    nodes: [
      { key: "wait", kind: "wait", delaySeconds: 3600 },
      { key: "task", kind: "task", taskTitle: title },
    ],
    edges: [{ from: "wait", to: "task", branch: "always" }],
    timezone: "Asia/Bangkok",
    quietHours: { start: "21:00", end: "08:00" },
  };
}

function condition(filter: Schemas["LeadFilter"]): Definition {
  return {
    nodes: [
      { key: "match", kind: "condition", condition: filter },
      { key: "yes", kind: "wait", delaySeconds: 0 },
      { key: "no", kind: "wait", delaySeconds: 1 },
    ],
    edges: [
      { from: "match", to: "yes", branch: "true" },
      { from: "match", to: "no", branch: "false" },
    ],
    timezone: "UTC",
  };
}

function message(id: string, kind: "email" | "sms" = "sms"): Definition {
  return { nodes: [{ key: "message", kind, messageDesignId: id }], edges: [], timezone: "UTC" };
}

async function use<T>(
  identity: VerifiedIdentityContext,
  operation: (service: CampaignWorkflowService, client: PoolClient, context: TenantContext) => Promise<T>,
) {
  return withTenantTransaction(runtime, identity, (client, context) =>
    operation(new CampaignWorkflowService(client, context, randomUUID()), client, context),
  );
}

async function parent(identity: VerifiedIdentityContext = ownerA) {
  return withTenantTransaction(runtime, identity, (client, context) =>
    new CampaignDraftService(client, context, randomUUID()).create(
      { name: "Synthetic workflow parent " + randomUUID(), category: "synthetic-only" },
      { key: randomUUID() },
    ),
  );
}

async function create(
  campaignId: string,
  body = definition(),
  key = randomUUID(),
  identity: VerifiedIdentityContext = ownerA,
) {
  const response = await use(identity, (service) => service.create(campaignId, body, { key }));
  expect(response.status).toBe(201);
  assertContract("CampaignVersion", response.body);
  expect(response.etag).toBe('"' + response.body.version + '"');
  return { response, body, key };
}

async function actor(grants = campaignGrants): Promise<Actor> {
  const userId = randomUUID(),
    memberId = randomUUID(),
    roleId = randomUUID();
  await admin.query(
    "INSERT INTO app.user_identity(id,issuer,subject,display_name,email_verified)VALUES($1,'urn:estate:synthetic',$2,'Synthetic workflow actor',true)",
    [userId, randomUUID()],
  );
  await admin.query(
    "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants)VALUES($1,$2,$3,$4)",
    [fixtures.orgA, roleId, "Synthetic workflow role " + randomUUID(), JSON.stringify(grants)],
  );
  await admin.query(
    "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active','Synthetic workflow member')",
    [fixtures.orgA, memberId, userId, roleId],
  );
  return { userId, organizationId: fixtures.orgA, memberId, roleId };
}

async function references(id: string) {
  return (
    await admin.query(
      "SELECT (SELECT count(*)::int FROM app.campaign_version WHERE id=$1::uuid)AS versions,(SELECT count(*)::int FROM app.idempotency_record WHERE response_body->>'id'=$1::text AND route_key LIKE 'marketing:workflow:%')AS receipts,(SELECT count(*)::int FROM app.audit_event WHERE resource_type='campaign_version'AND resource_id=$1::text)AS audits,(SELECT count(*)::int FROM app.outbox WHERE aggregate_id=$1::text AND event_type='campaign.workflow_draft_created')AS events",
      [id],
    )
  ).rows[0];
}

async function countVersions(campaignId: string) {
  return (
    await admin.query("SELECT count(*)::int AS count FROM app.campaign_version WHERE campaign_id=$1", [
      campaignId,
    ])
  ).rows[0].count as number;
}

async function design(tenant: string = fixtures.orgA, channel: "email" | "sms" = "sms") {
  const id = randomUUID();
  const text = "Synthetic private message " + randomUUID();
  const hash = createHash("sha256").update(text).digest("hex");
  await admin.query(
    "INSERT INTO app.message_design(tenant_id,id,name,channel,version,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'Synthetic workflow source',$3,1,$4,$5,$6,$7)",
    [
      tenant,
      id,
      channel,
      "native",
      JSON.stringify({ schemaVersion: 1, blocks: [{ type: "text", text }] }),
      text,
      hash,
    ],
  );
  return { id, text, hash };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function waitForDatabaseLock(pid: number, queryPart: string, requireExpiry = true) {
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
      if (!requireExpiry || row.expired) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    observed ? "Locked capability did not expire." : "Genuine runtime lock wait was not observed.",
  );
}

beforeAll(async () => {
  await assertRuntimeRole(runtime);
  await assertRuntimeRole(worker);
  expect(
    (await admin.query("SELECT name FROM public.estate_migration WHERE name LIKE '0017-%'")).rowCount,
  ).toBe(1);
  expect(
    (await admin.query("SELECT name FROM public.estate_migration WHERE name LIKE '0018-%'")).rowCount,
  ).toBe(1);
  expect(
    (await admin.query("SELECT name FROM public.estate_migration WHERE name LIKE '0019-%'")).rowCount,
  ).toBe(1);
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

const indexPath = (campaignId: string, orgId: string = fixtures.orgA) =>
  `/v1/orgs/${orgId}/campaigns/${campaignId}/versions`;
const detailPath = (id: string, orgId: string = fixtures.orgA) => `/v1/orgs/${orgId}/campaign-versions/${id}`;

function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-trace-id")).toBeTruthy();
}

async function versionHttp(response: Response, status: 200 | 201 = 200) {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  privateResponse(response);
  assertContract("CampaignVersion", body);
  expect(response.headers.get("etag")).toBe('"' + body.version + '"');
  return { body, etag: response.headers.get("etag")! };
}

async function workflowProblem(response: Response, status: number) {
  privateResponse(response);
  expect(response.headers.get("etag")).toBeNull();
  return assertProblem(response, status);
}

function rawHttp(path: string, init: RequestInit = {}, session: ApiSession | null = ownerHttp) {
  const headers = new Headers(init.headers);
  if (session?.cookie) headers.set("cookie", session.cookie);
  return fetch(apiOrigin + path, { ...init, headers });
}

describe("registered synthetic immutable workflow HTTP boundary", () => {
  it("exposes only the frozen draft append list and detail shapes with private historical strong ETags", async () => {
    const campaign = await parent(),
      body = definition(),
      key = randomUUID();
    const first = await versionHttp(await ownerHttp.command(indexPath(campaign.body.id), body, { key }), 201);
    const later = await versionHttp(await ownerHttp.command(indexPath(campaign.body.id), definition()), 201);
    expect(later.body.version).toBe(2);
    expect(await versionHttp(await ownerHttp.request(detailPath(first.body.id)))).toEqual(first);
    expect(
      await versionHttp(
        await ownerHttp.request(detailPath(first.body.id), { headers: { "if-none-match": first.etag } }),
      ),
    ).toEqual(first);
    expect(
      await versionHttp(await ownerHttp.command(indexPath(campaign.body.id), body, { key }), 201),
    ).toEqual(first);
    const pageResponse = await ownerHttp.request(indexPath(campaign.body.id) + "?limit=1");
    expect(pageResponse.status).toBe(200);
    privateResponse(pageResponse);
    expect(pageResponse.headers.get("etag")).toBeNull();
    const page = await pageResponse.json();
    assertContract("PageCampaignVersion", page);
    const ordered = [first.body, later.body].sort((a, b) => a.id.localeCompare(b.id));
    expect(page.items).toEqual([ordered[0]]);
    expect(page.hasMore).toBe(true);
    const nextResponse = await ownerHttp.request(
      indexPath(campaign.body.id) + "?limit=1&cursor=" + encodeURIComponent(page.nextCursor!),
    );
    expect(nextResponse.status).toBe(200);
    const next = await nextResponse.json();
    assertContract("PageCampaignVersion", next);
    expect(next).toEqual({ items: [ordered[1]], hasMore: false, nextCursor: null });
    expect(
      (
        await workflowProblem(
          await ownerHttp.command(indexPath(campaign.body.id), definition("Altered original"), { key }),
          409,
        )
      ).code,
    ).toBe("idempotency_conflict");
    expect(await references(first.body.id)).toEqual({ versions: 1, receipts: 1, audits: 1, events: 1 });
  });

  it("enforces CSRF origin key and bounded JSON before committing any workflow", async () => {
    const campaign = await parent(),
      path = indexPath(campaign.body.id),
      body = JSON.stringify(definition());
    const origin = process.env.TEST_WEB_ORIGIN ?? "http://localhost:3000";
    const requests: { headers: Record<string, string>; body: string; status: number }[] = [
      {
        headers: { origin, "content-type": "application/json", "idempotency-key": randomUUID() },
        body,
        status: 403,
      },
      {
        headers: {
          origin,
          "content-type": "application/json",
          "x-csrf-token": "wrong",
          "idempotency-key": randomUUID(),
        },
        body,
        status: 403,
      },
      {
        headers: {
          origin: "https://untrusted.invalid",
          "content-type": "application/json",
          "x-csrf-token": ownerHttp.csrf,
          "idempotency-key": randomUUID(),
        },
        body,
        status: 403,
      },
      {
        headers: {
          "content-type": "application/json",
          "x-csrf-token": ownerHttp.csrf,
          "idempotency-key": randomUUID(),
        },
        body,
        status: 403,
      },
      {
        headers: { origin, "content-type": "application/json", "x-csrf-token": ownerHttp.csrf },
        body,
        status: 400,
      },
      {
        headers: {
          origin,
          "content-type": "application/json",
          "x-csrf-token": ownerHttp.csrf,
          "idempotency-key": "invalid key",
        },
        body,
        status: 400,
      },
      {
        headers: {
          origin,
          "content-type": "application/json",
          "x-csrf-token": ownerHttp.csrf,
          "idempotency-key": randomUUID(),
        },
        body: "{",
        status: 400,
      },
      {
        headers: {
          origin,
          "content-type": "application/json",
          "x-csrf-token": ownerHttp.csrf,
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ nodes: [], edges: [], timezone: "UTC", payload: "x".repeat(256 * 1024) }),
        status: 413,
      },
    ];
    for (const request of requests)
      await workflowProblem(
        await rawHttp(path, { method: "POST", headers: request.headers, body: request.body }),
        request.status,
      );
    expect(await countVersions(campaign.body.id)).toBe(0);
  });

  it("returns frozen safe graph field errors and rejects duplicate unknown or nonscalar query parameters", async () => {
    const campaign = await parent(),
      marker = "PRIVATE_SYNTHETIC_INVALID_" + randomUUID();
    const problem = await workflowProblem(
      await ownerHttp.command(indexPath(campaign.body.id), {
        ...definition(marker),
        edges: [
          { from: "wait", to: "task", branch: "always" },
          { from: "task", to: "wait", branch: "always" },
        ],
      }),
      422,
    );
    expect(problem.errors?.length).toBeGreaterThan(0);
    for (const issue of problem.errors ?? []) {
      expect(issue.field.length).toBeLessThanOrEqual(200);
      expect(issue.message.length).toBeLessThanOrEqual(500);
    }
    expect(JSON.stringify(problem)).not.toContain(marker);
    for (const query of [
      "?limit=1&limit=2",
      "?limit=01",
      "?limit=0",
      "?cursor=",
      "?filter=%7B%7D",
      "?limit%5B%5D=1",
    ])
      await workflowProblem(await ownerHttp.request(indexPath(campaign.body.id) + query), 422);
    await workflowProblem(await ownerHttp.request(detailPath("not-a-uuid")), 422);
    expect(await countVersions(campaign.body.id)).toBe(0);
  });

  it("requires current member authority and exact tenant even when caller-supplied member headers name the owner", async () => {
    const campaign = await parent(),
      fixture = await create(campaign.body.id),
      path = detailPath(fixture.response.body.id);
    await workflowProblem(await rawHttp(path, {}, null), 401);
    await workflowProblem(
      await agentHttp.request(path, { headers: { "x-member-id": ownerHttp.memberId } }),
      403,
    );
    await workflowProblem(await agentHttp.command(indexPath(campaign.body.id), definition()), 403);
    expect(
      (await versionHttp(await ownerHttp.request(path, { headers: { "x-member-id": agentHttp.memberId } })))
        .body.id,
    ).toBe(fixture.response.body.id);
    await workflowProblem(await ownerHttp.request(detailPath(fixture.response.body.id, fixtures.orgB)), 403);
    const b = await new ApiSession().signIn("owner");
    expect((await b.switchOrganization(fixtures.orgB)).status).toBe(200);
    await workflowProblem(await b.request(detailPath(fixture.response.body.id, fixtures.orgB)), 404);
    await workflowProblem(await b.command(indexPath(campaign.body.id, fixtures.orgB), definition()), 404);
  });

  it("revokes registered reads and cached append commands when role membership capability or current parent changes", async () => {
    const campaign = await parent(),
      permitted = await actor();
    const previous = (
      await admin.query("SELECT role_id,status FROM app.membership WHERE id=$1", [fixtures.agentMemberA])
    ).rows[0];
    let fixture: { body: Version; etag: string } | undefined;
    const body = definition(),
      key = randomUUID();
    try {
      await admin.query("UPDATE app.membership SET role_id=$2 WHERE id=$1", [
        fixtures.agentMemberA,
        permitted.roleId,
      ]);
      fixture = await versionHttp(await agentHttp.command(indexPath(campaign.body.id), body, { key }), 201);
      expect((await versionHttp(await agentHttp.request(detailPath(fixture.body.id)))).body.id).toBe(
        fixture.body.id,
      );
      await admin.query("UPDATE app.role_definition SET permission_grants='[]'WHERE id=$1", [
        permitted.roleId,
      ]);
      await workflowProblem(await agentHttp.request(detailPath(fixture.body.id)), 403);
      await workflowProblem(await agentHttp.command(indexPath(campaign.body.id), body, { key }), 403);
      await admin.query("UPDATE app.role_definition SET permission_grants=$2 WHERE id=$1", [
        permitted.roleId,
        JSON.stringify(campaignGrants),
      ]);
      await admin.query("UPDATE app.membership SET status='disabled'WHERE id=$1", [fixtures.agentMemberA]);
      await workflowProblem(await agentHttp.request(detailPath(fixture.body.id)), 403);
      await workflowProblem(await agentHttp.command(indexPath(campaign.body.id), body, { key }), 403);
      await admin.query("UPDATE app.membership SET status='active'WHERE id=$1", [fixtures.agentMemberA]);
      await admin.query(
        "UPDATE app.entitlement SET state='disabled'WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
      await workflowProblem(await agentHttp.request(detailPath(fixture.body.id)), 403);
      await workflowProblem(await agentHttp.command(indexPath(campaign.body.id), body, { key }), 403);
      await admin.query(
        "UPDATE app.entitlement SET state='enabled'WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
      await admin.query("UPDATE app.campaign SET state='archived'WHERE id=$1", [campaign.body.id]);
      await workflowProblem(await agentHttp.request(detailPath(fixture.body.id)), 404);
      await workflowProblem(await agentHttp.command(indexPath(campaign.body.id), body, { key }), 404);
      expect(await references(fixture.body.id)).toEqual({ versions: 1, receipts: 1, audits: 1, events: 1 });
    } finally {
      await admin.query("UPDATE app.membership SET role_id=$2,status=$3 WHERE id=$1", [
        fixtures.agentMemberA,
        previous.role_id,
        previous.status,
      ]);
      await admin.query(
        "UPDATE app.entitlement SET state='enabled',effective_until=NULL WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
    }
  });

  it("rejects forwarded clients mixed identity cookies and all editing publication or delivery routes", async () => {
    const campaign = await parent(),
      fixture = await create(campaign.body.id),
      path = detailPath(fixture.response.body.id);
    await workflowProblem(
      await ownerHttp.request(path, { headers: { "x-forwarded-for": "198.51.100.17" } }),
      403,
    );
    await workflowProblem(
      await ownerHttp.request(indexPath(campaign.body.id), {
        method: "POST",
        headers: {
          "x-forwarded-for": "127.0.0.1, 198.51.100.17",
          "x-csrf-token": ownerHttp.csrf,
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify(definition()),
      }),
      403,
    );
    expect(
      (
        await workflowProblem(
          await rawHttp(
            path,
            { headers: { cookie: ownerHttp.cookie + "; estate_staff_session=" + "a".repeat(64) } },
            null,
          ),
          403,
        )
      ).code,
    ).toBe("identity_context_ambiguous");
    const commands: { path: string; method: string; body?: unknown }[] = [
      { path, method: "PATCH", body: definition() },
      { path, method: "DELETE", body: {} },
      {
        path: `/v1/orgs/${fixtures.orgA}/broadcast-confirmations`,
        method: "POST",
        body: {
          previewId: randomUUID(),
          acceptedTermsVersion: "synthetic-never-send",
        } satisfies Schemas["PreviewConfirm"],
      },
      { path: `/public/campaign-versions/${fixture.response.body.id}`, method: "GET" },
    ];
    for (const command of commands) {
      const response =
        command.method === "GET"
          ? await ownerHttp.request(command.path)
          : await ownerHttp.command(command.path, command.body, { method: command.method, revision: '"1"' });
      expect([404, 503]).toContain(response.status);
      await workflowProblem(response, response.status);
    }
    expect(await references(fixture.response.body.id)).toEqual({
      versions: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
    for (const table of ["campaign_step", "enrollment", "scheduled_action", "delivery_attempt"])
      expect((await admin.query(`SELECT count(*)::int AS count FROM app.${table}`)).rows[0].count).toBe(0);
  });
});

describe("actual0017–0019 immutable native workflow draft service", () => {
  it("appends generated definitions and explicit version ETags without modifying parent metadata or old definitions", async () => {
    const campaign = await parent();
    const first = await create(campaign.body.id);
    const second = await create(campaign.body.id, definition("A different synthetic task"));
    expect(first.response.body).toEqual({
      id: first.response.body.id,
      campaignId: campaign.body.id,
      version: 1,
      state: "draft",
      definition: first.body,
    });
    expect(second.response.body.version).toBe(2);
    expect(await use(ownerA, (service) => service.get(first.response.body.id))).toEqual(first.response.body);
    const page = await use(ownerA, (service) => service.list(campaign.body.id));
    assertContract("PageCampaignVersion", page);
    expect(page.items.map((item) => item.id).sort()).toEqual(
      [first.response.body.id, second.response.body.id].sort(),
    );
    expect(
      (
        await admin.query("SELECT name,category,state,row_version FROM app.campaign WHERE id=$1", [
          campaign.body.id,
        ])
      ).rows[0],
    ).toEqual({
      name: campaign.body.name,
      category: campaign.body.category,
      state: "draft",
      row_version: "1",
    });
    for (const table of [
      "campaign_step",
      "automation_rule",
      "enrollment",
      "scheduled_action",
      "delivery_attempt",
    ])
      expect((await admin.query(`SELECT count(*)::int AS count FROM app.${table}`)).rows[0].count).toBe(0);
  });

  it.each(["own", "team"] as const)(
    "denies stored %s grants and forged retained organization permission arrays",
    async (scope) => {
      const member = await actor(campaignGrants.map((grant) => ({ ...grant, scope })));
      const campaign = await parent(),
        fixture = await create(campaign.body.id);
      await expect(use(member, (service) => service.list(campaign.body.id))).rejects.toMatchObject({
        status: 403,
        code: "permission_denied",
      });
      await expect(
        use(member, (service) => service.create(campaign.body.id, definition(), { key: randomUUID() })),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        withTenantTransaction(runtime, member, (client, context) =>
          new CampaignWorkflowService(client, { ...context, permissions: campaignGrants }, randomUUID()).get(
            fixture.response.body.id,
          ),
        ),
      ).rejects.toMatchObject({ status: 403 });
    },
  );

  it("keeps read and write grants separate and allows wait/task drafts without CRM permissions", async () => {
    const campaign = await parent(),
      readOnly = await actor([campaignGrants[0]]),
      writeOnly = await actor([campaignGrants[1]]);
    const fixture = await create(campaign.body.id, definition(), randomUUID(), writeOnly);
    expect(await use(readOnly, (service) => service.get(fixture.response.body.id))).toEqual(
      fixture.response.body,
    );
    await expect(
      use(readOnly, (service) => service.create(campaign.body.id, definition(), { key: randomUUID() })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(use(writeOnly, (service) => service.list(campaign.body.id))).rejects.toMatchObject({
      status: 403,
    });
    await expect(use(writeOnly, (service) => service.get(fixture.response.body.id))).rejects.toMatchObject({
      status: 403,
    });
    expect(
      await use(writeOnly, (service) => service.create(campaign.body.id, fixture.body, { key: fixture.key })),
    ).toEqual(fixture.response);
  });

  it("reauthorizes current role and membership before reads and durable command replay", async () => {
    const member = await actor(),
      campaign = await parent(),
      fixture = await create(campaign.body.id, definition(), randomUUID(), member);
    await admin.query("UPDATE app.role_definition SET permission_grants='[]'WHERE id=$1", [member.roleId]);
    await expect(use(member, (service) => service.get(fixture.response.body.id))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      use(member, (service) => service.create(campaign.body.id, fixture.body, { key: fixture.key })),
    ).rejects.toMatchObject({ status: 403 });
    await admin.query("UPDATE app.role_definition SET permission_grants=$2 WHERE id=$1", [
      member.roleId,
      JSON.stringify(campaignGrants),
    ]);
    await admin.query("UPDATE app.membership SET status='disabled'WHERE id=$1", [member.memberId]);
    let invoked = false;
    await expect(
      use(member, async (service) => {
        invoked = true;
        return service.create(campaign.body.id, fixture.body, { key: fixture.key });
      }),
    ).rejects.toMatchObject({ status: 403, code: "membership_required" });
    expect(invoked).toBe(false);
    expect(await references(fixture.response.body.id)).toEqual({
      versions: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
  });

  it("rejects missing transaction context, forged tenant/member values and foreign membership", async () => {
    const campaign = await parent(),
      fixture = await create(campaign.body.id);
    const retained = await withTenantTransaction(runtime, ownerA, async (_client, context) => context);
    const client = await runtime.connect();
    try {
      await expect(
        new CampaignWorkflowService(client, retained, randomUUID()).get(fixture.response.body.id),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        (await client.query("SELECT count(*)::int AS count FROM app.campaign_version")).rows[0].count,
      ).toBe(0);
    } finally {
      client.release();
    }
    for (const override of [{ organizationId: fixtures.orgB }, { memberId: fixtures.ownerMemberB }])
      await expect(
        withTenantTransaction(runtime, ownerA, (current, context) =>
          new CampaignWorkflowService(current, { ...context, ...override }, randomUUID()).get(
            fixture.response.body.id,
          ),
        ),
      ).rejects.toMatchObject({ status: 403 });
    await expect(
      use({ userId: fixtures.agentUser, organizationId: fixtures.orgB }, (service) =>
        service.list(campaign.body.id),
      ),
    ).rejects.toMatchObject({ status: 403, code: "membership_required" });
  });

  it("checks enabled unexpired marketing capability before reads fresh writes and historical replay", async () => {
    const campaign = await parent(),
      fixture = await create(campaign.body.id);
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
        await expect(use(ownerA, (service) => service.list(campaign.body.id))).rejects.toMatchObject({
          status: 403,
        });
        await expect(
          use(ownerA, (service) => service.create(campaign.body.id, fixture.body, { key: fixture.key })),
        ).rejects.toMatchObject({ status: 403 });
      }
    } finally {
      await admin.query(
        "UPDATE app.entitlement SET state='enabled',effective_until=NULL WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
    }
    expect(await references(fixture.response.body.id)).toEqual({
      versions: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
  });

  it("isolates foreign parent/version IDs and identical keys across tenants", async () => {
    const campaignA = await parent(),
      campaignB = await parent(ownerB),
      body = definition(),
      key = randomUUID();
    const a = await create(campaignA.body.id, body, key),
      b = await create(campaignB.body.id, body, key, ownerB);
    expect(a.response.body.id).not.toBe(b.response.body.id);
    await expect(use(ownerA, (service) => service.get(b.response.body.id))).rejects.toMatchObject({
      status: 404,
    });
    await expect(use(ownerB, (service) => service.list(campaignA.body.id))).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      use(ownerA, (service) => service.create(campaignB.body.id, body, { key: randomUUID() })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("concurrent identical commands commit one version receipt audit and closed safe-reference event", async () => {
    const campaign = await parent(),
      body = definition(),
      key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        use(ownerA, (service) => service.create(campaign.body.id, body, { key })),
      ),
    );
    for (const response of responses) expect(response).toEqual(responses[0]);
    const current = responses[0].body;
    expect(await references(current.id)).toEqual({ versions: 1, receipts: 1, audits: 1, events: 1 });
    const event = (
      await admin.query(
        "SELECT * FROM app.outbox WHERE aggregate_id=$1 AND event_type='campaign.workflow_draft_created'",
        [current.id],
      )
    ).rows[0];
    expect(validateEvent(event.payload), JSON.stringify(validateEvent.errors)).toBe(true);
    expect(event).toMatchObject({
      tenant_id: fixtures.orgA,
      initiating_actor_id: fixtures.ownerUser,
      aggregate_id: current.id,
      published_at: null,
    });
    expect(event.payload).toMatchObject({
      eventId: event.id,
      aggregateId: current.id,
      payload: { campaignId: campaign.body.id, workflowVersionId: current.id, workflowVersion: 1 },
    });
    expect(event.payload.occurredAt).toBe(event.payload.ingestedAt);
    const audit = (
      await admin.query(
        "SELECT safe_diff FROM app.audit_event WHERE resource_type='campaign_version'AND resource_id=$1",
        [current.id],
      )
    ).rows[0];
    expect(audit.safe_diff).toEqual({ resourceVersion: 1 });
    expect(JSON.stringify({ event: event.payload, audit: audit.safe_diff })).not.toContain(
      body.nodes[1].taskTitle,
    );
    expect(JSON.stringify(event.payload)).not.toContain("quietHours");
  });

  it("independent concurrent keys allocate contiguous versions under the parent lock without overwriting prior drafts", async () => {
    const campaign = await parent();
    const bodies = Array.from({ length: 6 }, () => definition());
    const responses = await Promise.all(
      bodies.map((body) =>
        use(ownerA, (service) => service.create(campaign.body.id, body, { key: randomUUID() })),
      ),
    );
    expect(responses.map((response) => response.body.version).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(6);
    for (const response of responses) {
      expect(await use(ownerA, (service) => service.get(response.body.id))).toEqual(response.body);
      expect(await references(response.body.id)).toEqual({ versions: 1, receipts: 1, audits: 1, events: 1 });
    }
    expect(
      (await admin.query("SELECT row_version FROM app.campaign WHERE id=$1", [campaign.body.id])).rows[0]
        .row_version,
    ).toBe("1");
  });

  it("keeps infinite receipts and historical ETags after later workflow and parent metadata edits", async () => {
    const campaign = await parent(),
      first = await create(campaign.body.id),
      later = await create(campaign.body.id);
    await withTenantTransaction(runtime, ownerA, (client, context) =>
      new CampaignDraftService(client, context, randomUUID()).update(
        campaign.body.id,
        { name: "Changed synthetic metadata", category: "still-draft" },
        { key: randomUUID(), ifMatch: '"1"' },
      ),
    );
    const expiry = (
      await admin.query(
        "SELECT expires_at::text AS expiry FROM app.idempotency_record WHERE response_body->>'id'=$1",
        [first.response.body.id],
      )
    ).rows;
    expect(expiry).toEqual([{ expiry: "infinity" }]);
    await admin.query(
      "UPDATE app.idempotency_record SET created_at=created_at-interval '1 year' WHERE response_body->>'id'=$1",
      [first.response.body.id],
    );
    expect(
      await use(ownerA, (service) => service.create(campaign.body.id, first.body, { key: first.key })),
    ).toEqual(first.response);
    await expect(
      use(ownerA, (service) =>
        service.create(campaign.body.id, definition("Changed original input"), { key: first.key }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect(await use(ownerA, (service) => service.get(later.response.body.id))).toEqual(later.response.body);
    expect(await countVersions(campaign.body.id)).toBe(2);
  });

  it("denies cached definitions once the current parent becomes active paused or archived", async () => {
    for (const state of ["active", "paused", "archived"]) {
      const campaign = await parent(),
        fixture = await create(campaign.body.id);
      await admin.query("UPDATE app.campaign SET state=$2 WHERE id=$1", [campaign.body.id, state]);
      await expect(use(ownerA, (service) => service.get(fixture.response.body.id))).rejects.toMatchObject({
        status: 404,
      });
      await expect(use(ownerA, (service) => service.list(campaign.body.id))).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        use(ownerA, (service) => service.create(campaign.body.id, fixture.body, { key: fixture.key })),
      ).rejects.toMatchObject({ status: 404 });
      expect(await references(fixture.response.body.id)).toEqual({
        versions: 1,
        receipts: 1,
        audits: 1,
        events: 1,
      });
    }
  });

  it("rejects malformed graphs with bounded safe field issues and no committed command effects", async () => {
    const campaign = await parent(),
      marker = "PRIVATE_SYNTHETIC_INVALID_" + randomUUID();
    const invalid: unknown[] = [
      null,
      {},
      { nodes: [], edges: [], timezone: "UTC" },
      { ...definition(), timezone: "UTC+7" },
      { ...definition(), quietHours: { start: "23:60", end: "00:00" } },
      { ...definition(), quietHours: { start: "00:00", end: "00:00" } },
      {
        nodes: [
          { key: "a", kind: "wait", delaySeconds: 0 },
          { key: "a", kind: "wait", delaySeconds: 1 },
        ],
        edges: [],
        timezone: "UTC",
      },
      {
        nodes: [
          { key: "a", kind: "wait", delaySeconds: 0 },
          { key: "b", kind: "wait", delaySeconds: 1 },
        ],
        edges: [
          { from: "a", to: "b", branch: "always" },
          { from: "b", to: "a", branch: "always" },
        ],
        timezone: "UTC",
      },
      { ...condition({ intent: "buyer" }), edges: [{ from: "match", to: "yes", branch: "true" }] },
      {
        ...condition({ intent: "buyer" }),
        edges: [
          { from: "match", to: "yes", branch: "true" },
          { from: "match", to: "yes", branch: "false" },
        ],
      },
      condition({ q: " " }),
      condition({ tagIds: [] }),
      condition({ tagIds: [randomUUID(), randomUUID()].map(() => fixtures.leadA) }),
      { nodes: [{ key: "a", kind: "wait", delaySeconds: 0, taskTitle: marker }], edges: [], timezone: "UTC" },
      { nodes: [{ key: "a", kind: "task", taskTitle: " ", expression: marker }], edges: [], timezone: "UTC" },
      { nodes: [{ key: "a", kind: "wait", delaySeconds: 0.5 }], edges: [], timezone: "UTC" },
      { ...definition(), unsafe: marker },
    ];
    for (const body of invalid) {
      const error = await use(ownerA, (service) =>
        service.create(campaign.body.id, body as Definition, { key: randomUUID() }),
      ).then(
        () => {
          throw new Error("Invalid definition unexpectedly committed.");
        },
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({ status: 422 });
      expect(JSON.stringify(error)).not.toContain(marker);
    }
    expect(await countVersions(campaign.body.id)).toBe(0);
  });

  it("rejects malformed keys and non-scalar closed pagination input", async () => {
    const campaign = await parent();
    for (const key of [undefined, "", "with space", "\n", "x".repeat(101)])
      await expect(
        use(ownerA, (service) => service.create(campaign.body.id, definition(), { key })),
      ).rejects.toMatchObject({ status: 400 });
    for (const query of [
      { limit: 0 },
      { limit: "01" },
      { limit: false },
      { limit: ["1", "2"] },
      { cursor: ["a"] },
      { cursor: "" },
      { filter: "{}" },
    ])
      await expect(use(ownerA, (service) => service.list(campaign.body.id, query))).rejects.toMatchObject({
        status: 422,
      });
    expect(await countVersions(campaign.body.id)).toBe(0);
  });

  it("binds signed cursors to parent tenant actor limit and current grants", async () => {
    const campaign = await parent(),
      otherCampaign = await parent(),
      other = await actor();
    for (let index = 0; index < 3; index++) await create(campaign.body.id);
    await create(otherCampaign.body.id);
    const first = await use(ownerA, (service) => service.list(campaign.body.id, { limit: "1" }));
    expect(first.hasMore).toBe(true);
    const cursor = first.nextCursor!;
    expect(
      (await use(ownerA, (service) => service.list(campaign.body.id, { limit: "1", cursor }))).items[0].id,
    ).not.toBe(first.items[0].id);
    for (const [identity, id, query] of [
      [ownerA, otherCampaign.body.id, { limit: "1", cursor }],
      [other, campaign.body.id, { limit: "1", cursor }],
      [ownerA, campaign.body.id, { limit: "2", cursor }],
    ] as const)
      await expect(use(identity, (service) => service.list(id, query))).rejects.toMatchObject({
        status: 422,
        code: "cursor_invalid",
      });
    const b = await parent(ownerB);
    await expect(
      use(ownerB, (service) => service.list(b.body.id, { limit: "1", cursor })),
    ).rejects.toMatchObject({ status: 422 });
    const signatureStart = cursor.lastIndexOf(".") + 1;
    const altered =
      cursor.slice(0, signatureStart) +
      (cursor[signatureStart] === "A" ? "B" : "A") +
      cursor.slice(signatureStart + 1);
    await expect(
      use(ownerA, (service) => service.list(campaign.body.id, { limit: "1", cursor: altered })),
    ).rejects.toMatchObject({ status: 422 });
    const current = await use(other, (service) => service.list(campaign.body.id, { limit: "1" }));
    await admin.query(
      "UPDATE app.role_definition SET permission_grants=permission_grants||$2::jsonb WHERE id=$1",
      [other.roleId, JSON.stringify([{ code: "crm.contacts.read", scope: "own" }])],
    );
    await expect(
      use(other, (service) => service.list(campaign.body.id, { limit: "1", cursor: current.nextCursor! })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("pages five large valid definitions as four complete objects and a cursor rather than throwing or truncating", async () => {
    const campaign = await parent(),
      tags = Array.from({ length: 20 }, () => randomUUID());
    for (const tag of tags)
      await admin.query("INSERT INTO app.tag(tenant_id,id,name)VALUES($1,$2,$3)", [
        fixtures.orgA,
        tag,
        "Large synthetic workflow tag " + tag,
      ]);
    const key = (index: number) => `c${String(index).padStart(2, "0")}_${"k".repeat(60)}`;
    const yes = "t" + "a".repeat(63),
      no = "t" + "b".repeat(63);
    const nodes: Definition["nodes"] = Array.from({ length: 98 }, (_, index) => ({
      key: key(index),
      kind: "condition",
      condition: {
        stageId: stageId(1, 1),
        sourceId: fixtures.sourceA,
        ownerMemberId: fixtures.ownerMemberA,
        tagIds: tags,
        intent: "buyer",
        q: "😀".repeat(200),
      },
    }));
    nodes.push(
      { key: yes, kind: "task", taskTitle: "😀".repeat(200) },
      { key: no, kind: "task", taskTitle: "😀".repeat(200) },
    );
    const edges: Definition["edges"] = Array.from({ length: 98 }, (_, index) => [
      { from: key(index), to: index < 97 ? key(index + 1) : yes, branch: "true" as const },
      { from: key(index), to: no, branch: "false" as const },
    ]).flat();
    const body: Definition = { nodes, edges, timezone: "UTC" };
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(210_000);
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThan(262_144);
    const versions: Version[] = [];
    for (let index = 0; index < 5; index++)
      versions.push((await create(campaign.body.id, body)).response.body);
    const first = await use(ownerA, (service) => service.list(campaign.body.id, { limit: "100" }));
    assertContract("PageCampaignVersion", first);
    expect(first.items).toHaveLength(4);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThan(1_048_576);
    for (const item of first.items) expect(item.definition).toEqual(body);
    const second = await use(ownerA, (service) =>
      service.list(campaign.body.id, { limit: "100", cursor: first.nextCursor! }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(second.items[0].definition).toEqual(body);
    expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual(
      versions.map((item) => item.id).sort(),
    );
    const response = await ownerHttp.request(indexPath(campaign.body.id) + "?limit=100");
    expect(response.status).toBe(200);
    privateResponse(response);
    expect(response.headers.get("etag")).toBeNull();
    const page = await response.json();
    assertContract("PageCampaignVersion", page);
    expect(page.items).toEqual(first.items);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeTruthy();
  }, 15_000);

  it.each(["advisory", "campaign"] as const)(
    "rechecks database-clock marketing expiry after an observed %s lock wait",
    async (lock) => {
      const campaign = await parent(),
        key = randomUUID(),
        blocker = await admin.connect(),
        started = deferred<number>();
      let held = false;
      let pending: Promise<{ value: Mutation } | { error: unknown }> | undefined;
      try {
        await blocker.query("BEGIN");
        held = true;
        if (lock === "advisory")
          await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `${fixtures.orgA}:${fixtures.ownerUser}:marketing:workflow:create:${campaign.body.id}:${key}`,
          ]);
        else await blocker.query("SELECT id FROM app.campaign WHERE id=$1 FOR UPDATE", [campaign.body.id]);
        await admin.query(
          "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '1 second'WHERE tenant_id=$1 AND feature='marketing'",
          [fixtures.orgA],
        );
        pending = use(ownerA, async (service, client) => {
          started.resolve((await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid);
          return service.create(campaign.body.id, definition(), { key });
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const pid = await Promise.race([
          started.promise,
          pending.then(() => {
            throw new Error("Workflow command ended before the lock-wait fixture.");
          }),
        ]);
        await waitForDatabaseLock(pid, lock === "advisory" ? "pg_advisory_xact_lock" : "FROM app.campaign");
        await blocker.query("COMMIT");
        held = false;
        const outcome = await pending;
        expect(outcome).toHaveProperty("error");
        if ("error" in outcome)
          expect(outcome.error).toMatchObject({ status: 403, code: "entitlement_disabled" });
        expect(await countVersions(campaign.body.id)).toBe(0);
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

  it("accepts only current closed native static message sources without exposing message content", async () => {
    const campaign = await parent(),
      sms = await design(),
      email = await design(fixtures.orgA, "email");
    for (const [source, kind] of [
      [sms, "sms"],
      [email, "email"],
    ] as const) {
      const fixture = await create(campaign.body.id, message(source.id, kind));
      expect(await use(ownerA, (service) => service.get(fixture.response.body.id))).toEqual(
        fixture.response.body,
      );
      const event = (
        await admin.query("SELECT payload FROM app.outbox WHERE aggregate_id=$1", [fixture.response.body.id])
      ).rows[0].payload;
      expect(JSON.stringify(event)).not.toContain(source.text);
      expect(JSON.stringify(fixture.response)).not.toContain(source.text);
      expect(fixture.response.body.definition.nodes[0].messageDesignId).toBe(source.id);
    }
  });

  it("denies missing foreign wrong-channel unrecognized-editor and corrupted native message designs", async () => {
    const campaign = await parent(),
      foreign = await design(fixtures.orgB),
      wrongChannel = await design(fixtures.orgA, "email");
    for (const id of [randomUUID(), foreign.id, wrongChannel.id])
      await expect(
        use(ownerA, (service) => service.create(campaign.body.id, message(id), { key: randomUUID() })),
      ).rejects.toMatchObject({ status: 422, code: "workflow_reference_unavailable" });
    const text = "Synthetic malformed fixture";
    const native = { schemaVersion: 1, blocks: [{ type: "text", text }] };
    const variants = [
      { editor: "unlayer" },
      { name: " " },
      { hash: "a".repeat(64) },
      { body: { schemaVersion: 1, blocks: [{ type: "text", text: "Wrong rendering" }] } },
      { body: { ...native, executable: "blocked" } },
      { content: "{{contact.name}}" },
      { content: "<script>unsafe</script>" },
      { content: "https://unapproved.invalid" },
    ];
    await expect(
      admin.query("UPDATE app.message_design SET version=0 WHERE id=$1", [wrongChannel.id]),
    ).rejects.toMatchObject({ code: "23514" });
    for (const variant of variants) {
      //0019 denies corruption of existing immutable history, including privileged
      //fixture edits. New explicit malformed migration fixtures remain unproven.
      const id = randomUUID();
      const row = {
        name: "Synthetic workflow source",
        editor: "native",
        body: native,
        content: text,
        hash: createHash("sha256").update(text).digest("hex"),
        ...variant,
      };
      await admin.query(
        "INSERT INTO app.message_design(tenant_id,id,name,channel,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,$3,'sms',$4,$5,$6,$7)",
        [fixtures.orgA, id, row.name, row.editor, JSON.stringify(row.body), row.content, row.hash],
      );
      expect(
        (await admin.query("SELECT history_ready FROM app.message_design WHERE id=$1", [id])).rows[0]
          .history_ready,
      ).toBe(false);
      expect(
        (
          await admin.query("SELECT version FROM app.message_design_revision WHERE message_design_id=$1", [
            id,
          ])
        ).rowCount,
      ).toBe(0);
      await expect(
        use(ownerA, (service) => service.create(campaign.body.id, message(id), { key: randomUUID() })),
      ).rejects.toMatchObject({ status: 422, code: "workflow_reference_unavailable" });
    }
    expect(await countVersions(campaign.body.id)).toBe(0);
  });

  it("reauthorizes current design validity and read permission before detail pages and historical replay", async () => {
    const member = await actor(),
      campaign = await parent(),
      source = await design();
    const fixture = await create(campaign.body.id, message(source.id), randomUUID(), member);
    await expect(
      admin.query("UPDATE app.message_design SET content_hash=repeat('a',64)WHERE id=$1", [source.id]),
    ).rejects.toMatchObject({ code: "23514", constraint: "native_design_unreferenced" });
    await admin.query("UPDATE app.message_design SET availability_state='archived'WHERE id=$1", [source.id]);
    for (const read of [
      () => use(member, (service) => service.get(fixture.response.body.id)),
      () => use(member, (service) => service.create(campaign.body.id, fixture.body, { key: fixture.key })),
    ])
      await expect(read()).rejects.toMatchObject({ status: 404, code: "resource_unavailable" });
    expect((await use(member, (service) => service.list(campaign.body.id))).items).toEqual([]);
    expect(
      (
        await admin.query("SELECT content_hash FROM app.message_design_revision WHERE message_design_id=$1", [
          source.id,
        ])
      ).rows[0].content_hash,
    ).toBe(source.hash);
    const currentSource = await design();
    const currentFixture = await create(campaign.body.id, message(currentSource.id), randomUUID(), member);
    await admin.query("UPDATE app.role_definition SET permission_grants=$2 WHERE id=$1", [
      member.roleId,
      JSON.stringify([campaignGrants[1]]),
    ]);
    await expect(
      use(member, (service) =>
        service.create(campaign.body.id, currentFixture.body, { key: currentFixture.key }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
    expect(await references(fixture.response.body.id)).toEqual({
      versions: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
  });

  it("requires current tenant-scoped stage source tags and active owner for meaningful conditions", async () => {
    const campaign = await parent(),
      member = await actor([...campaignGrants, ...referenceGrants]),
      tag = randomUUID();
    await admin.query("INSERT INTO app.tag(tenant_id,id,name)VALUES($1,$2,$3)", [
      fixtures.orgA,
      tag,
      "Synthetic workflow tag " + tag,
    ]);
    const body = condition({
      stageId: stageId(1, 1),
      sourceId: fixtures.sourceA,
      tagIds: [tag],
      ownerMemberId: member.memberId,
      q: "synthetic",
      intent: "buyer",
    });
    const fixture = await create(campaign.body.id, body, randomUUID(), member);
    expect(await use(member, (service) => service.get(fixture.response.body.id))).toEqual(
      fixture.response.body,
    );
    const foreignTag = randomUUID();
    await admin.query("INSERT INTO app.tag(tenant_id,id,name)VALUES($1,$2,$3)", [
      fixtures.orgB,
      foreignTag,
      "Synthetic foreign workflow tag " + foreignTag,
    ]);
    for (const filter of [
      { stageId: stageId(2, 1) },
      { sourceId: fixtures.sourceB },
      { tagIds: [foreignTag] },
      { ownerMemberId: fixtures.ownerMemberB },
      { sourceId: randomUUID() },
    ])
      await expect(
        use(member, (service) => service.create(campaign.body.id, condition(filter), { key: randomUUID() })),
      ).rejects.toMatchObject({ status: 422, code: "workflow_reference_unavailable" });
    await admin.query("DELETE FROM app.tag WHERE id=$1", [tag]);
    await expect(use(member, (service) => service.get(fixture.response.body.id))).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      use(member, (service) => service.create(campaign.body.id, body, { key: fixture.key })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("accepts and returns the nested reconverging graph the ADR-050 outline editor serializes", async () => {
    const campaign = await parent(),
      member = await actor([...campaignGrants, ...referenceGrants]);
    const outline: Outline = [
      { type: "step", node: { key: "step_1", kind: "wait", delaySeconds: 60 } },
      {
        type: "condition",
        node: { key: "step_2", kind: "condition", condition: { intent: "buyer", stageId: stageId(1, 1) } },
        whenTrue: [
          {
            type: "condition",
            node: { key: "step_3", kind: "condition", condition: { sourceId: fixtures.sourceA } },
            whenTrue: [{ type: "step", node: { key: "step_4", kind: "task", taskTitle: "Synthetic inner" } }],
            whenFalse: [],
          },
          { type: "step", node: { key: "step_5", kind: "wait", delaySeconds: 0 } },
        ],
        whenFalse: [
          { type: "step", node: { key: "step_6", kind: "task", taskTitle: "Synthetic otherwise" } },
        ],
      },
      { type: "step", node: { key: "step_7", kind: "task", taskTitle: "Synthetic after" } },
    ];
    const body = outlineDefinition(outline, { nodes: [], edges: [], timezone: "UTC" });
    const fixture = await create(campaign.body.id, body, randomUUID(), member);
    expect(fixture.response.body.definition).toEqual(body);
    const read = await use(member, (service) => service.get(fixture.response.body.id));
    expect(definitionOutline(read.definition)).toEqual(outline);
  });

  it("checks matching organization source grants and current CRM capability on condition read and replay", async () => {
    const campaign = await parent(),
      allowed = await actor([...campaignGrants, ...referenceGrants]);
    const filters: { permission: string; filter: Schemas["LeadFilter"] }[] = [
      { permission: "crm.leads.read", filter: { q: "synthetic" } },
      { permission: "crm.leads.read", filter: { intent: "buyer" } },
      { permission: "crm.pipeline.read", filter: { stageId: stageId(1, 1) } },
      { permission: "crm.sources.read", filter: { sourceId: fixtures.sourceA } },
      { permission: "members.read", filter: { ownerMemberId: fixtures.ownerMemberA } },
    ];
    for (const { permission, filter } of filters) {
      const fixture = await create(campaign.body.id, condition(filter), randomUUID(), allowed);
      const missing = await actor([
        ...campaignGrants,
        ...referenceGrants.filter((grant) => grant.code !== permission),
      ]);
      await expect(use(missing, (service) => service.get(fixture.response.body.id))).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        use(missing, (service) => service.create(campaign.body.id, condition(filter), { key: randomUUID() })),
      ).rejects.toMatchObject({ status: 403 });
    }
    for (const scope of ["own", "team"] as const) {
      const scoped = await actor([
        ...campaignGrants,
        ...referenceGrants.map((grant) => (grant.code === "crm.leads.read" ? { ...grant, scope } : grant)),
      ]);
      await expect(
        use(scoped, (service) =>
          service.create(campaign.body.id, condition({ intent: "buyer" }), { key: randomUUID() }),
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
    const fixture = await create(campaign.body.id, condition({ intent: "buyer" }), randomUUID(), allowed);
    try {
      await admin.query("UPDATE app.entitlement SET state='disabled'WHERE tenant_id=$1 AND feature='crm'", [
        fixtures.orgA,
      ]);
      await expect(use(allowed, (service) => service.get(fixture.response.body.id))).rejects.toMatchObject({
        status: 403,
        code: "entitlement_disabled",
      });
      await expect(
        use(allowed, (service) => service.create(campaign.body.id, fixture.body, { key: fixture.key })),
      ).rejects.toMatchObject({ status: 403 });
      // A draft that references no CRM source remains metadata-only.
      await create(campaign.body.id, definition(), randomUUID(), allowed);
    } finally {
      await admin.query("UPDATE app.entitlement SET state='enabled'WHERE tenant_id=$1 AND feature='crm'", [
        fixtures.orgA,
      ]);
    }
  });

  it("cannot replay an old condition after its referenced owner membership becomes disabled", async () => {
    const campaign = await parent(),
      target = await actor(),
      body = condition({ ownerMemberId: target.memberId });
    const fixture = await create(campaign.body.id, body);
    await admin.query("UPDATE app.membership SET status='disabled'WHERE id=$1", [target.memberId]);
    await expect(use(ownerA, (service) => service.get(fixture.response.body.id))).rejects.toMatchObject({
      status: 422,
      code: "workflow_reference_unavailable",
    });
    await expect(
      use(ownerA, (service) => service.create(campaign.body.id, body, { key: fixture.key })),
    ).rejects.toMatchObject({ status: 422 });
    expect(await references(fixture.response.body.id)).toEqual({
      versions: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
  });

  it("allocates after unreadable legacy published versions without exposing historical content", async () => {
    const campaign = await parent(),
      published = randomUUID(),
      privateDefinition = definition("PRIVATE_SYNTHETIC_PUBLISHED_CONTENT");
    await admin.query(
      "INSERT INTO app.campaign_version(tenant_id,id,campaign_id,version,definition,state,published_at)VALUES($1,$2,$3,10,$4,'published',clock_timestamp())",
      [fixtures.orgA, published, campaign.body.id, JSON.stringify(privateDefinition)],
    );
    const fixture = await create(campaign.body.id);
    expect(fixture.response.body.version).toBe(11);
    expect(fixture.response.etag).toBe('"11"');
    await expect(use(ownerA, (service) => service.get(published))).rejects.toMatchObject({ status: 404 });
    const page = await use(ownerA, (service) => service.list(campaign.body.id));
    expect(page.items).toEqual([fixture.response.body]);
    expect(JSON.stringify(page)).not.toContain("PRIVATE_SYNTHETIC_PUBLISHED_CONTENT");
    expect(
      (await admin.query("SELECT definition,version FROM app.campaign_version WHERE id=$1", [published]))
        .rows[0],
    ).toEqual({ definition: privateDefinition, version: 10 });
  });

  it("maps hidden published int-max exhaustion to a safe conflict with no version or receipt", async () => {
    const campaign = await parent(),
      key = randomUUID();
    await admin.query(
      "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state,published_at)VALUES($1,$2,2147483647,$3,'published',clock_timestamp())",
      [fixtures.orgA, campaign.body.id, JSON.stringify(definition())],
    );
    await expect(
      use(ownerA, (service) => service.create(campaign.body.id, definition(), { key })),
    ).rejects.toMatchObject({ status: 409, code: "workflow_version_exhausted" });
    expect(await countVersions(campaign.body.id)).toBe(1);
    expect((await admin.query("SELECT id FROM app.idempotency_record WHERE key=$1", [key])).rowCount).toBe(0);
  });

  it.each(["advisory", "campaign"] as const)(
    "snapshots caller input before waiting on a %s lock",
    async (lock) => {
      const campaign = await parent(),
        body = definition(),
        original = structuredClone(body),
        key = randomUUID();
      const blocker = await admin.connect(),
        started = deferred<number>();
      let held = false,
        pending: Promise<Mutation> | undefined;
      try {
        await blocker.query("BEGIN");
        held = true;
        if (lock === "advisory")
          await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `${fixtures.orgA}:${fixtures.ownerUser}:marketing:workflow:create:${campaign.body.id}:${key}`,
          ]);
        else await blocker.query("SELECT id FROM app.campaign WHERE id=$1 FOR UPDATE", [campaign.body.id]);
        pending = use(ownerA, async (service, client) => {
          started.resolve((await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid);
          return service.create(campaign.body.id, body, { key });
        });
        await waitForDatabaseLock(
          await started.promise,
          lock === "advisory" ? "pg_advisory_xact_lock" : "FROM app.campaign",
          false,
        );
        body.nodes[1].taskTitle = "Changed while waiting";
        body.nodes[0].delaySeconds = 1;
        body.timezone = "UTC";
        await blocker.query("COMMIT");
        held = false;
        const response = await pending;
        expect(response.body.definition).toEqual(original);
        expect(await use(ownerA, (service) => service.create(campaign.body.id, original, { key }))).toEqual(
          response,
        );
        await expect(
          use(ownerA, (service) => service.create(campaign.body.id, body, { key })),
        ).rejects.toMatchObject({ status: 409 });
      } finally {
        if (held) await blocker.query("ROLLBACK");
        if (pending) await pending;
        blocker.release();
      }
    },
    15_000,
  );

  it("caller rollback removes appended definitions audits events and durable receipts atomically", async () => {
    const campaign = await parent(),
      rollback = new Error("Synthetic workflow rollback"),
      ids: string[] = [];
    await expect(
      use(ownerA, async (service) => {
        for (let index = 0; index < 2; index++)
          ids.push((await service.create(campaign.body.id, definition(), { key: randomUUID() })).body.id);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(ids).toHaveLength(2);
    for (const id of ids)
      expect(await references(id)).toEqual({ versions: 0, receipts: 0, audits: 0, events: 0 });
    expect((await create(campaign.body.id)).response.body.version).toBe(1);
  });

  it("the closed event producer rejects forged tenant actor campaign sequence and state references", async () => {
    const campaign = await parent(),
      fixture = await create(campaign.body.id);
    for (const variant of ["tenant", "actor", "parent", "sequence", "state", "missing"])
      await expect(
        withTenantTransaction(runtime, ownerA, (client, context) =>
          appendCampaignWorkflowEvent(
            client,
            {
              ...context,
              ...(variant === "tenant" ? { organizationId: fixtures.orgB } : {}),
              ...(variant === "actor" ? { userId: fixtures.agentUser } : {}),
            },
            randomUUID(),
            {
              ...fixture.response.body,
              ...(variant === "parent" ? { campaignId: randomUUID() } : {}),
              ...(variant === "sequence" ? { version: 2 } : {}),
              ...(variant === "state" ? { state: "published" as const } : {}),
              ...(variant === "missing" ? { id: randomUUID() } : {}),
            },
          ),
        ),
      ).rejects.toMatchObject({ status: 403, code: "campaign_context_unavailable" });
    expect(await references(fixture.response.body.id)).toEqual({
      versions: 1,
      receipts: 1,
      audits: 1,
      events: 1,
    });
  });

  it("the real lead-only dispatcher leaves this unsupported family untouched without receipt acknowledgement or delivery", async () => {
    const campaign = await parent(),
      fixture = await create(campaign.body.id);
    const event = (
      await admin.query("SELECT id FROM app.outbox WHERE aggregate_id=$1", [fixture.response.body.id])
    ).rows[0];
    expect(await dispatchOutbox(worker, ownerA, 100)).toEqual({ dispatched: 0, deferred: 0 });
    const row = (
      await admin.query("SELECT published_at,attempt_count,lease_until FROM app.outbox WHERE id=$1", [
        event.id,
      ])
    ).rows[0];
    expect(row).toEqual({ published_at: null, attempt_count: 0, lease_until: null });
    expect(
      (await admin.query("SELECT event_id FROM app.outbox_consumer_receipt WHERE event_id=$1", [event.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await admin.query("SELECT id FROM app.audit_event WHERE resource_type='outbox'AND resource_id=$1", [
          event.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await dispatchOutbox(worker, ownerA, 100)).toEqual({ dispatched: 0, deferred: 0 });
    const clients = await Promise.all(Array.from({ length: 8 }, () => runtime.connect()));
    try {
      for (const client of clients)
        expect(
          (
            await client.query(
              "SELECT nullif(current_setting('app.tenant_id',true),'')AS tenant,nullif(current_setting('app.actor_id',true),'')AS actor,(SELECT count(*)::int FROM app.campaign_version)AS visible",
            )
          ).rows[0],
        ).toEqual({ tenant: null, actor: null, visible: 0 });
    } finally {
      for (const client of clients) client.release();
    }
  });
});

describe("ADR-059 publishCampaign", () => {
  const publishGrants: PermissionGrant[] = [
    { code: "campaigns.read", scope: "organization" },
    { code: "campaigns.write", scope: "organization" },
    { code: "campaigns.publish", scope: "organization" },
  ];

  async function publishActor() {
    return actor(publishGrants);
  }

  async function publish(versionId: string, identity: VerifiedIdentityContext = ownerA, key = randomUUID()) {
    const result = await use(identity, (service) => service.publish(versionId, { key }));
    expect(result.status).toBe(201);
    assertContract("CampaignVersion", result.body);
    expect(result.body.state).toBe("published");
    return result;
  }

  it("publishes a draft version and transitions parent campaign to active", async () => {
    const campaign = await parent();
    const { response } = await create(campaign.body.id);
    const publishId = await publishActor();
    const result = await publish(response.body.id, publishId);
    expect(result.body.id).toBe(response.body.id);
    const row = (await admin.query("SELECT state FROM app.campaign WHERE id=$1", [campaign.body.id])).rows[0];
    expect(row.state).toBe("active");
    const vrow = (
      await admin.query("SELECT state,published_at FROM app.campaign_version WHERE id=$1", [response.body.id])
    ).rows[0];
    expect(vrow.state).toBe("published");
    expect(vrow.published_at).not.toBeNull();
  });

  it("publish is idempotent for the same key", async () => {
    const campaign = await parent();
    const { response } = await create(campaign.body.id);
    const publishId = await publishActor();
    const key = randomUUID();
    const first = await publish(response.body.id, publishId, key);
    const second = await publish(response.body.id, publishId, key);
    expect(second.body.id).toBe(first.body.id);
    expect(second.etag).toBe(first.etag);
  });

  it("returns 403 without campaigns.publish permission", async () => {
    const campaign = await parent();
    const { response } = await create(campaign.body.id);
    const noPublish = await actor(campaignGrants);
    await expect(
      use(noPublish, (service) => service.publish(response.body.id, { key: randomUUID() })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns 409 if version is already published (different key)", async () => {
    const campaign = await parent();
    const { response } = await create(campaign.body.id);
    const publishId = await publishActor();
    await publish(response.body.id, publishId);
    await expect(
      use(publishId, (service) => service.publish(response.body.id, { key: randomUUID() })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("enforces tenant isolation — cannot publish another tenant's campaign version", async () => {
    const campaign = await parent(ownerA);
    const { response } = await create(campaign.body.id, definition(), randomUUID(), ownerA);
    await expect(
      withTenantTransaction(runtime, ownerB, (client, context) =>
        new CampaignWorkflowService(client, context, randomUUID()).publish(response.body.id, {
          key: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
