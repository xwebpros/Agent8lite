import { createHash, randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CampaignDraftService, CampaignWorkflowService } from "../../apps/api/src/marketing";
import { MessageDesignDraftService } from "../../apps/api/src/marketing/message-design-service";
import { dispatchOutbox } from "../../apps/worker/src/outbox";
import eventSchema from "../../packages/contracts/internal/native-message-design-event-v1.schema.json";
import { fixtures } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import {
  withTenantTransaction,
  type PermissionGrant,
  type TenantContext,
  type VerifiedIdentityContext,
} from "../../packages/db/tenant-transaction";
import { ApiSession, apiOrigin, assertContract, assertProblem, type Schemas } from "../helpers/api";

// Only the coordinator's disposable runner may execute this file.
for (const variable of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL", "TEST_WORKER_DATABASE_URL"]) {
  const url = new URL(process.env[variable] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Message-design acceptance requires the owned disposable isolated batch runner.");
}
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const worker = new Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 1 });
const ownerA: VerifiedIdentityContext = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const ownerB: VerifiedIdentityContext = { userId: fixtures.ownerUser, organizationId: fixtures.orgB };
type Write = Schemas["MessageDesignWrite"];
type Mutation = Awaited<ReturnType<MessageDesignDraftService["create"]>>;
type Actor = VerifiedIdentityContext & { memberId: string; roleId: string };
const grants: PermissionGrant[] = [
  { code: "campaigns.read", scope: "organization" },
  { code: "campaigns.write", scope: "organization" },
];
const ajv = new Ajv2020({ strict: false, allErrors: true, ownProperties: true });
addFormats(ajv);
const validateEvent = ajv.compile(eventSchema);
let ownerHttp: ApiSession;
let agentHttp: ApiSession;

function input(text = "PRIVATE_SYNTHETIC_BODY_" + randomUUID(), channel: "email" | "sms" = "email"): Write {
  return {
    name: "PRIVATE_SYNTHETIC_NAME_" + randomUUID(),
    channel,
    subject: "PRIVATE_SYNTHETIC_SUBJECT",
    editor: "native",
    design: { schemaVersion: 1, blocks: [{ type: "text", text }] },
    content: text,
  };
}
async function use<T>(
  identity: VerifiedIdentityContext,
  operation: (service: MessageDesignDraftService, client: PoolClient, context: TenantContext) => Promise<T>,
) {
  return withTenantTransaction(runtime, identity, (client, context) =>
    operation(new MessageDesignDraftService(client, context, randomUUID()), client, context),
  );
}
async function create(body = input(), key = randomUUID(), identity = ownerA) {
  const response = await use(identity, (service) => service.create(body, { key }));
  expect(response.status).toBe(201);
  assertContract("MessageDesign", response.body);
  expect(response.etag).toBe('"' + response.body.version + '"');
  return { response, body, key };
}
async function actor(
  permissionGrants = grants,
  organizationId: string = fixtures.orgA,
  userId = randomUUID(),
): Promise<Actor> {
  const memberId = randomUUID(),
    roleId = randomUUID();
  await admin.query(
    "INSERT INTO app.user_identity(id,issuer,subject,display_name,email_verified)VALUES($1,'urn:estate:synthetic',$2,'Synthetic message-design actor',true)ON CONFLICT(id)DO NOTHING",
    [userId, randomUUID()],
  );
  await admin.query(
    "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants)VALUES($1,$2,$3,$4)",
    [
      organizationId,
      roleId,
      "Synthetic message-design role " + randomUUID(),
      JSON.stringify(permissionGrants),
    ],
  );
  await admin.query(
    "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active','Synthetic message-design member')",
    [organizationId, memberId, userId, roleId],
  );
  return { organizationId, userId, memberId, roleId };
}
async function counts(id: string) {
  return (
    await admin.query(
      "SELECT (SELECT count(*)::int FROM app.message_design WHERE id=$1::uuid)AS designs,(SELECT count(*)::int FROM app.message_design_revision WHERE message_design_id=$1::uuid)AS snapshots,(SELECT count(*)::int FROM app.idempotency_record WHERE response_body->>'id'=$1::text AND route_key LIKE 'marketing:message-design:%')AS receipts,(SELECT count(*)::int FROM app.audit_event WHERE resource_type='message_design'AND resource_id=$1::text)AS audits,(SELECT count(*)::int FROM app.outbox WHERE aggregate_id=$1::text AND event_type='message_design.draft_changed')AS events",
      [id],
    )
  ).rows[0];
}
const committed = (revisions = 1) => ({
  designs: 1,
  snapshots: revisions,
  receipts: revisions,
  audits: revisions,
  events: revisions,
});
async function snapshot(id: string) {
  return (
    await admin.query(
      "SELECT version,source_row_version,name,channel,subject,editor_kind,design,rendered_content,content_hash FROM app.message_design_revision WHERE message_design_id=$1 ORDER BY version",
      [id],
    )
  ).rows;
}
async function bind(id: string, channel: "email" | "sms" = "email") {
  return withTenantTransaction(runtime, ownerA, async (client, context) => {
    const parent = await new CampaignDraftService(client, context, randomUUID()).create(
      { name: "Synthetic source-reference parent " + randomUUID(), category: "synthetic-only" },
      { key: randomUUID() },
    );
    return new CampaignWorkflowService(client, context, randomUUID()).create(
      parent.body.id,
      { nodes: [{ key: "message", kind: channel, messageDesignId: id }], edges: [], timezone: "UTC" },
      { key: randomUUID() },
    );
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
async function observedLock(pid: number, blockerPid: number, requireExpiry = false) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = (
      await admin.query(
        "SELECT wait_event_type,pg_blocking_pids(pid)AS blockers,(SELECT effective_until<=clock_timestamp()FROM app.entitlement WHERE tenant_id=$1 AND feature='marketing')AS expired FROM pg_stat_activity WHERE pid=$2",
        [fixtures.orgA, pid],
      )
    ).rows[0];
    if (
      row?.wait_event_type === "Lock" &&
      row.blockers.includes(blockerPid) &&
      (!requireExpiry || row.expired)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Required genuine runtime lock wait was not observed.");
}
async function blocked<T>(
  lock: (client: PoolClient) => Promise<unknown>,
  operation: (service: MessageDesignDraftService, client: PoolClient) => Promise<T>,
  onWait: () => void = () => {},
  requireExpiry = false,
) {
  const blocker = await admin.connect(),
    started = deferred<number>();
  let held = false;
  let pending: Promise<{ value: T } | { error: unknown }> | undefined;
  try {
    await blocker.query("BEGIN");
    held = true;
    const blockerPid = (await blocker.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
    await lock(blocker);
    if (requireExpiry)
      await admin.query(
        "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '1 second'WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
    pending = use(ownerA, async (service, client) => {
      started.resolve((await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid);
      return operation(service, client);
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const pid = await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error("Runtime command ended before entering the lock fixture.");
      }),
    ]);
    await observedLock(pid, blockerPid, requireExpiry);
    onWait();
    await blocker.query("COMMIT");
    held = false;
    return await pending;
  } finally {
    if (held) await blocker.query("ROLLBACK");
    if (pending) await pending;
    blocker.release();
    if (requireExpiry)
      await admin.query(
        "UPDATE app.entitlement SET effective_until=NULL WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
  }
}
beforeAll(async () => {
  await assertRuntimeRole(runtime);
  await assertRuntimeRole(worker);
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
  await Promise.all([runtime.end(), admin.end(), worker.end()]);
});

const path = (id?: string, orgId: string = fixtures.orgA) =>
  "/v1/orgs/" + orgId + "/message-designs" + (id ? "/" + id : "");
function privacy(response: Response) {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-trace-id")).toBeTruthy();
}
async function httpDesign(response: Response, status = 200) {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  privacy(response);
  assertContract("MessageDesign", body);
  expect(response.headers.get("etag")).toBe('"' + body.version + '"');
  return { body, etag: response.headers.get("etag")! };
}
async function problem(response: Response, status: number) {
  privacy(response);
  expect(response.headers.get("etag")).toBeNull();
  return assertProblem(response, status);
}
function rawHttp(endpoint: string, init: RequestInit = {}, session: ApiSession | null = ownerHttp) {
  const headers = new Headers(init.headers);
  if (session?.cookie) headers.set("cookie", session.cookie);
  return fetch(apiOrigin + endpoint, { ...init, headers });
}

describe("registered private native message-design HTTP boundary", () => {
  it("uses frozen list/get/create/PATCH shapes, no page ETag, and historical replay ETags", async () => {
    const body = input(),
      key = randomUUID();
    const first = await httpDesign(await ownerHttp.command(path(), body, { key }), 201);
    expect(await httpDesign(await ownerHttp.request(path(first.body.id)))).toEqual(first);
    expect(
      await httpDesign(
        await ownerHttp.request(path(first.body.id), { headers: { "if-none-match": first.etag } }),
      ),
    ).toEqual(first);
    const list = await ownerHttp.request(path() + "?limit=1");
    expect(list.status).toBe(200);
    privacy(list);
    expect(list.headers.get("etag")).toBeNull();
    assertContract("PageMessageDesign", await list.json());
    const updatedBody = input(),
      updatedKey = randomUUID();
    const second = await httpDesign(
      await ownerHttp.command(path(first.body.id), updatedBody, {
        method: "PATCH",
        key: updatedKey,
        revision: first.etag,
      }),
    );
    expect(second.etag).toBe('"2"');
    await httpDesign(
      await ownerHttp.command(path(first.body.id), input(), { method: "PATCH", revision: second.etag }),
    );
    expect(await httpDesign(await ownerHttp.command(path(), body, { key }), 201)).toEqual(first);
    expect(
      await httpDesign(
        await ownerHttp.command(path(first.body.id), updatedBody, {
          method: "PATCH",
          key: updatedKey,
          revision: first.etag,
        }),
      ),
    ).toEqual(second);
    expect(await counts(first.body.id)).toEqual(committed(3));
  });
  it("requires CSRF, exact Origin, printable command key, valid bounded JSON before mutation", async () => {
    const body = JSON.stringify(input()),
      origin = process.env.TEST_WEB_ORIGIN ?? "http://localhost:3000";
    const base = {
      origin,
      "content-type": "application/json",
      "x-csrf-token": ownerHttp.csrf,
      "idempotency-key": randomUUID(),
    };
    const cases: { headers: Record<string, string>; body: string; status: number }[] = [
      {
        headers: { origin, "content-type": "application/json", "idempotency-key": randomUUID() },
        body,
        status: 403,
      },
      { headers: { ...base, "x-csrf-token": "wrong" }, body, status: 403 },
      { headers: { ...base, origin: "https://untrusted.invalid" }, body, status: 403 },
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
      { headers: { ...base, "idempotency-key": "has space" }, body, status: 400 },
      { headers: base, body: "{", status: 400 },
      { headers: base, body: JSON.stringify({ ...input(), content: "x".repeat(270_000) }), status: 413 },
    ];
    const before = (await admin.query("SELECT count(*)::int AS count FROM app.message_design")).rows[0].count;
    for (const item of cases)
      await problem(
        await rawHttp(path(), { method: "POST", headers: item.headers, body: item.body }),
        item.status,
      );
    expect((await admin.query("SELECT count(*)::int AS count FROM app.message_design")).rows[0].count).toBe(
      before,
    );
  });
  it("returns closed safe semantic issues and rejects strong-revision and query errors", async () => {
    const created = await create();
    for (const revision of [undefined, "1", 'W/"1"', '"0"', '"01"', '"1', '1"', '"2147483648"'])
      await problem(
        await ownerHttp.command(path(created.response.body.id), input(), {
          method: "PATCH",
          revision,
        }),
        400,
      );
    await problem(
      await ownerHttp.command(path(created.response.body.id), input(), {
        method: "PATCH",
        revision: '"99"',
      }),
      412,
    );
    for (const body of [
      { ...input(), editor: "unlayer" },
      { ...input(), content: "PRIVATE_MISMATCH_SHOULD_NOT_LEAK" },
      { ...input(), subject: "bad\nsubject" },
      {
        ...input(),
        design: { schemaVersion: 1, blocks: [{ type: "text", text: "<script>PRIVATE_UNSAFE</script>" }] },
      },
    ]) {
      const error = await problem(await ownerHttp.command(path(), body), 422);
      expect(JSON.stringify(error)).not.toContain("PRIVATE_MISMATCH_SHOULD_NOT_LEAK");
      expect(JSON.stringify(error)).not.toContain("PRIVATE_UNSAFE");
      expect(error.errors?.length).toBeGreaterThan(0);
    }
    await problem(await ownerHttp.command(path(), { ...input(), state: "published" }), 422);
    for (const query of ["?limit=0", "?limit=1&limit=2", "?cursor=", "?state=published"])
      await problem(await ownerHttp.request(path() + query), 422);
    expect(await counts(created.response.body.id)).toEqual(committed());
  });
  it("fails current member, tenant and forwarded synthetic boundary checks", async () => {
    const created = await create();
    for (const endpoint of [path(), path(created.response.body.id)])
      await problem(await agentHttp.request(endpoint), 403);
    await problem(await ownerHttp.request(path(created.response.body.id, fixtures.orgB)), 403);
    await problem(await rawHttp(path(), {}, null), 401);
    const forwardedHeaders: Record<string, string>[] = [
      { "x-forwarded-for": "203.0.113.7" },
      { forwarded: "for=203.0.113.7;proto=https" },
      { "x-forwarded-host": "public.example.test" },
    ];
    for (const headers of forwardedHeaders) await problem(await ownerHttp.request(path(), { headers }), 403);
    const member = await actor();
    await admin.query("UPDATE app.membership SET status='disabled'WHERE id=$1", [member.memberId]);
    await expect(use(member, (service) => service.get(created.response.body.id))).rejects.toMatchObject({
      status: 403,
    });
  });
  it("rejects referenced label/no-op edits with an explicit POST copy retaining source identity", async () => {
    const created = await create();
    await bind(created.response.body.id);
    for (const body of [created.body, { ...created.body, name: "Synthetic new label" }]) {
      const error = await problem(
        await ownerHttp.command(path(created.response.body.id), body, {
          method: "PATCH",
          revision: '"1"',
        }),
        409,
      );
      expect(error.code).toBe("design_referenced_immutable");
    }
    const copy = await httpDesign(await ownerHttp.command(path(), created.body), 201);
    expect(copy.body.id).not.toBe(created.response.body.id);
    expect(copy.body.version).toBe(1);
    expect(copy.body.content).toBe(created.body.content);
    expect(await counts(created.response.body.id)).toEqual(committed());
    expect(await counts(copy.body.id)).toEqual(committed());
  });
  it("does not expose history, publish, send, archive or delete routes", async () => {
    const created = await create();
    for (const endpoint of [
      path(created.response.body.id) + "/history",
      path(created.response.body.id) + "/publish",
      path(created.response.body.id) + "/send",
      path(created.response.body.id) + "/archive",
    ])
      await problem(await ownerHttp.command(endpoint, {}), 404);
    await problem(await ownerHttp.command(path(created.response.body.id), {}, { method: "DELETE" }), 404);
    expect(await counts(created.response.body.id)).toEqual(committed());
  });
  it("denies historical replay and private reads after source archive and capability withdrawal", async () => {
    const created = await create();
    await admin.query("UPDATE app.message_design SET availability_state='archived'WHERE id=$1", [
      created.response.body.id,
    ]);
    await problem(await ownerHttp.request(path(created.response.body.id)), 404);
    await problem(await ownerHttp.command(path(), created.body, { key: created.key }), 404);
    try {
      await admin.query(
        "UPDATE app.entitlement SET state='disabled'WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
      await problem(await ownerHttp.request(path()), 403);
      await problem(await ownerHttp.command(path(), input()), 403);
    } finally {
      await admin.query(
        "UPDATE app.entitlement SET state='enabled'WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
    }
  });
});

describe("actual-role native message-design commands and storage invariants", () => {
  it("preserves exact Unicode/LF block content, optional subject, coupled hash and both revisions", async () => {
    const text = "Synthetic emoji 😀\n\tSynthetic second block.";
    const body: Write = {
      ...input(text, "sms"),
      design: {
        schemaVersion: 1,
        blocks: [
          { type: "text", text: "Synthetic emoji 😀" },
          { type: "text", text: "\tSynthetic second block." },
        ],
      },
    };
    delete body.subject;
    const created = await create(body);
    expect(created.response.body).toMatchObject({
      id: created.response.body.id,
      version: 1,
      content: text,
      design: body.design,
    });
    expect(created.response.body.subject ?? null).toBeNull();
    const rows = await snapshot(created.response.body.id);
    expect(rows).toEqual([
      {
        version: 1,
        source_row_version: "1",
        name: body.name,
        channel: "sms",
        subject: null,
        editor_kind: "native",
        design: body.design,
        rendered_content: text,
        content_hash: createHash("sha256").update(text, "utf8").digest("hex"),
      },
    ]);
    expect(await use(ownerA, (service) => service.get(created.response.body.id))).toEqual(
      created.response.body,
    );
    expect(await counts(created.response.body.id)).toEqual(committed());
  });
  it("concurrent identical creates commit exactly one aggregate, snapshot, receipt, audit and event", async () => {
    const body = input(),
      key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => use(ownerA, (service) => service.create(body, { key }))),
    );
    for (const response of responses) expect(response).toEqual(responses[0]);
    const id = responses[0].body.id;
    expect(await counts(id)).toEqual(committed());
    const event = (await admin.query("SELECT * FROM app.outbox WHERE aggregate_id=$1", [id])).rows[0];
    expect(validateEvent(event.payload), JSON.stringify(validateEvent.errors)).toBe(true);
    expect(event).toMatchObject({
      tenant_id: fixtures.orgA,
      initiating_actor_id: fixtures.ownerUser,
      event_type: "message_design.draft_changed",
      aggregate_id: id,
      published_at: null,
    });
    expect(event.payload).toMatchObject({
      eventId: event.id,
      tenantId: fixtures.orgA,
      aggregateId: id,
      payload: { messageDesignId: id, designVersion: 1, operation: "create" },
    });
    expect(event.payload.occurredAt).toBe(event.payload.ingestedAt);
    const audit = (
      await admin.query(
        "SELECT action,safe_diff FROM app.audit_event WHERE resource_type='message_design'AND resource_id=$1",
        [id],
      )
    ).rows[0];
    expect(audit).toEqual({ action: "message_design.draft_created", safe_diff: { resourceVersion: 1 } });
    const safe = JSON.stringify({ audit, event: event.payload });
    for (const privateValue of [body.name, body.subject!, body.content])
      expect(safe).not.toContain(privateValue);
    await expect(
      use(ownerA, (service) => service.create({ ...body, name: "Changed original input" }, { key })),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
  });
  it("historical infinite receipts preserve old body/ETag without overwriting later source history", async () => {
    const first = await create(),
      id = first.response.body.id,
      secondBody = input(),
      secondKey = randomUUID();
    const second = await use(ownerA, (service) =>
      service.update(id, secondBody, { key: secondKey, ifMatch: '"1"' }),
    );
    const third = await use(ownerA, (service) =>
      service.update(id, input(), { key: randomUUID(), ifMatch: '"2"' }),
    );
    expect(second.etag).toBe('"2"');
    expect(third.etag).toBe('"3"');
    const receipts = (
      await admin.query(
        "SELECT expires_at::text AS expiry FROM app.idempotency_record WHERE response_body->>'id'=$1 AND route_key LIKE 'marketing:message-design:%'",
        [id],
      )
    ).rows;
    expect(receipts).toHaveLength(3);
    expect(receipts.every((receipt) => receipt.expiry === "infinity")).toBe(true);
    await admin.query(
      "UPDATE app.idempotency_record SET created_at=created_at-interval '1 year'WHERE response_body->>'id'=$1",
      [id],
    );
    expect(await use(ownerA, (service) => service.create(first.body, { key: first.key }))).toEqual(
      first.response,
    );
    expect(
      await use(ownerA, (service) => service.update(id, secondBody, { key: secondKey, ifMatch: '"1"' })),
    ).toEqual(second);
    await expect(
      use(ownerA, (service) => service.update(id, secondBody, { key: secondKey, ifMatch: '"2"' })),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    await expect(
      use(ownerA, (service) => service.update(id, input(), { key: secondKey, ifMatch: '"1"' })),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      use(ownerA, (service) => service.update(id, secondBody, { key: randomUUID(), ifMatch: '"1"' })),
    ).rejects.toMatchObject({ status: 412 });
    expect(await use(ownerA, (service) => service.get(id))).toEqual(third.body);
    expect(await counts(id)).toEqual(committed(3));
    expect((await snapshot(id)).map((row) => [row.version, row.source_row_version])).toEqual([
      [1, "1"],
      [2, "2"],
      [3, "3"],
    ]);
  });
  it("concurrent new update keys on one revision produce one complete update and one stale denial", async () => {
    const created = await create(),
      id = created.response.body.id;
    const outcomes = await Promise.all(
      [input(), input()].map((body) =>
        use(ownerA, (service) => service.update(id, body, { key: randomUUID(), ifMatch: '"1"' })).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
      ),
    );
    const success = outcomes.filter((outcome): outcome is { value: Mutation } => "value" in outcome);
    const failed = outcomes.filter((outcome): outcome is { error: unknown } => "error" in outcome);
    expect(success).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(success[0].value).toMatchObject({ status: 200, etag: '"2"' });
    expect(failed[0].error).toMatchObject({ status: 412, code: "revision_stale" });
    expect(await counts(id)).toEqual(committed(2));
  });
  it("concurrent identical updates share one new immutable snapshot and historical response", async () => {
    const created = await create(),
      body = input(),
      key = randomUUID();
    const outcomes = await Promise.all(
      Array.from({ length: 3 }, () =>
        use(ownerA, (service) => service.update(created.response.body.id, body, { key, ifMatch: '"1"' })),
      ),
    );
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
    expect(outcomes[0].etag).toBe('"2"');
    expect(await counts(created.response.body.id)).toEqual(committed(2));
  });
  it("scopes identical command keys to tenant and actor instead of returning another source", async () => {
    const key = randomUUID(),
      body = input(),
      other = await actor();
    const first = await create(body, key),
      foreign = await create(body, key, ownerB),
      colleague = await create(body, key, other);
    expect(new Set([first.response.body.id, foreign.response.body.id, colleague.response.body.id]).size).toBe(
      3,
    );
    await expect(use(ownerB, (service) => service.get(first.response.body.id))).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      use(ownerA, (service) =>
        service.update(foreign.response.body.id, input(), { key: randomUUID(), ifMatch: '"1"' }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await use(ownerB, (service) => service.list())).items.map((item) => item.id)).not.toContain(
      first.response.body.id,
    );
  });
  it.each(["own", "team"] as const)(
    "does not infer organizational design authority from %s grants",
    async (scope) => {
      const member = await actor([
        { code: "campaigns.read", scope },
        { code: "campaigns.write", scope },
      ]);
      const created = await create();
      await expect(use(member, (service) => service.list())).rejects.toMatchObject({
        status: 403,
        code: "permission_denied",
      });
      await expect(use(member, (service) => service.get(created.response.body.id))).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        use(member, (service) => service.create(input(), { key: randomUUID() })),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        use(member, (service) =>
          service.update(created.response.body.id, input(), { key: randomUUID(), ifMatch: '"1"' }),
        ),
      ).rejects.toMatchObject({ status: 403 });
    },
  );
  it("requires read for reads and write for commands/replay without assuming one grant implies both", async () => {
    const reader = await actor([{ code: "campaigns.read", scope: "organization" }]),
      writer = await actor([{ code: "campaigns.write", scope: "organization" }]),
      created = await create();
    expect(await use(reader, (service) => service.get(created.response.body.id))).toEqual(
      created.response.body,
    );
    await expect(
      use(reader, (service) => service.create(input(), { key: randomUUID() })),
    ).rejects.toMatchObject({ status: 403 });
    const written = await create(input(), randomUUID(), writer);
    expect(await use(writer, (service) => service.create(written.body, { key: written.key }))).toEqual(
      written.response,
    );
    await expect(use(writer, (service) => service.get(written.response.body.id))).rejects.toMatchObject({
      status: 403,
    });
    await expect(use(writer, (service) => service.list())).rejects.toMatchObject({ status: 403 });
  });
  it("denies current disabled member and removed role grants on exact historical command replay", async () => {
    const member = await actor(),
      created = await create(input(), randomUUID(), member);
    await admin.query("UPDATE app.role_definition SET permission_grants=$2 WHERE id=$1", [
      member.roleId,
      JSON.stringify([{ code: "campaigns.read", scope: "organization" }]),
    ]);
    await expect(
      use(member, (service) => service.create(created.body, { key: created.key })),
    ).rejects.toMatchObject({ status: 403 });
    await admin.query("UPDATE app.membership SET status='disabled'WHERE id=$1", [member.memberId]);
    await expect(use(member, (service) => service.get(created.response.body.id))).rejects.toMatchObject({
      status: 403,
    });
    expect(await counts(created.response.body.id)).toEqual(committed());
  });
  it("does not trust a forged/stale typed permission context or missing transaction actor", async () => {
    const member = await actor([]),
      created = await create();
    await expect(
      withTenantTransaction(runtime, member, (client, context) =>
        new MessageDesignDraftService(client, { ...context, permissions: grants }, randomUUID()).get(
          created.response.body.id,
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    let retained!: TenantContext;
    await use(ownerA, async (_service, _client, context) => {
      retained = context;
    });
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await expect(
        new MessageDesignDraftService(client, retained, randomUUID()).get(created.response.body.id),
      ).rejects.toMatchObject({ status: 403 });
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    const context = (
      await runtime.query(
        "SELECT nullif(current_setting('app.tenant_id',true),'')AS tenant,nullif(current_setting('app.actor_id',true),'')AS actor",
      )
    ).rows[0];
    expect(context).toEqual({ tenant: null, actor: null });
  });
  it("archive denies current reads/new commands/historical replay without deleting source history", async () => {
    const created = await create(),
      id = created.response.body.id,
      before = await snapshot(id);
    await admin.query("UPDATE app.message_design SET availability_state='archived'WHERE id=$1", [id]);
    await expect(use(ownerA, (service) => service.get(id))).rejects.toMatchObject({ status: 404 });
    await expect(
      use(ownerA, (service) => service.create(created.body, { key: created.key })),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      use(ownerA, (service) => service.update(id, created.body, { key: randomUUID(), ifMatch: '"1"' })),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await use(ownerA, (service) => service.list({ limit: 100 }))).items.map((item) => item.id),
    ).not.toContain(id);
    expect(await snapshot(id)).toEqual(before);
    expect(await counts(id)).toEqual(committed());
  });
  it.each(["disabled", "expired", "missing"] as const)(
    "fails closed for %s current marketing capability including cached replay",
    async (state) => {
      const created = await create();
      try {
        if (state === "missing")
          await admin.query("DELETE FROM app.entitlement WHERE tenant_id=$1 AND feature='marketing'", [
            fixtures.orgA,
          ]);
        else
          await admin.query(
            "UPDATE app.entitlement SET state=$2,effective_until=" +
              (state === "expired" ? "clock_timestamp()-interval '1 second'" : "NULL") +
              " WHERE tenant_id=$1 AND feature='marketing'",
            [fixtures.orgA, state === "disabled" ? "disabled" : "enabled"],
          );
        await expect(use(ownerA, (service) => service.get(created.response.body.id))).rejects.toMatchObject({
          status: 403,
          code: "entitlement_disabled",
        });
        await expect(
          use(ownerA, (service) => service.create(created.body, { key: created.key })),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          use(ownerA, (service) =>
            service.update(created.response.body.id, input(), { key: randomUUID(), ifMatch: '"1"' }),
          ),
        ).rejects.toMatchObject({ status: 403 });
      } finally {
        await admin.query(
          "INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'marketing','enabled')ON CONFLICT(tenant_id,feature)DO UPDATE SET state='enabled',effective_until=NULL",
          [fixtures.orgA],
        );
      }
      expect(await counts(created.response.body.id)).toEqual(committed());
    },
  );
  it("unlicensed and explicitly unavailable historical source fixtures never fall back to old content", async () => {
    for (const editor of ["unlayer", "native"]) {
      const id = randomUUID();
      await admin.query(
        "INSERT INTO app.message_design(tenant_id,id,name,channel,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'Synthetic unavailable source','email',$3,'{}','PRIVATE_UNAVAILABLE_BODY','invalid-hash')",
        [fixtures.orgA, id, editor],
      );
      await expect(use(ownerA, (service) => service.get(id))).rejects.toMatchObject({ status: 404 });
      await expect(
        use(ownerA, (service) => service.update(id, input(), { key: randomUUID(), ifMatch: '"1"' })),
      ).rejects.toMatchObject({ status: 404 });
      expect(await snapshot(id)).toHaveLength(0);
    }
  });
  it("rejects unsafe content, accessors and proxies without executing getters or traps or storing receipts", async () => {
    let calls = 0;
    const accessor = input();
    Object.defineProperty(accessor, "name", {
      enumerable: true,
      get() {
        calls += 1;
        return "unsafe";
      },
    });
    const proxy = new Proxy(input(), {
      ownKeys() {
        calls += 1;
        throw new Error("Must not run");
      },
    });
    const before = (await admin.query("SELECT count(*)::int AS count FROM app.message_design")).rows[0].count;
    for (const body of [
      accessor,
      proxy,
      { ...input(), content: "does not match" },
      { ...input(), subject: "bad\nsubject" },
      { ...input(), editor: "unlayer" },
      { ...input(), channel: "fax" },
      { ...input(), state: "published" },
      input("https://unavailable.example.test"),
      input("Hello {{contact.name}}"),
      input("<p>Markup</p>"),
    ])
      await expect(
        use(ownerA, (service) => service.create(body as Write, { key: randomUUID() })),
      ).rejects.toMatchObject({ status: 422 });
    expect(calls).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS count FROM app.message_design")).rows[0].count).toBe(
      before,
    );
  });
  it("strong revisions, command keys and query values are bounded before durable writes", async () => {
    const created = await create();
    for (const ifMatch of [undefined, "", "1", 'W/"1"', '"0"', '"01"', '"1', '1"', '"2147483648"'])
      await expect(
        use(ownerA, (service) =>
          service.update(created.response.body.id, input(), { key: randomUUID(), ifMatch }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    for (const key of [undefined, "", "has space", "\n", "x".repeat(101)])
      await expect(use(ownerA, (service) => service.create(input(), { key }))).rejects.toMatchObject({
        status: 400,
      });
    for (const query of [{ limit: 0 }, { limit: "01" }, { limit: [1, 2] }, { cursor: "" }, { filter: "{}" }])
      await expect(use(ownerA, (service) => service.list(query))).rejects.toMatchObject({ status: 422 });
    expect(await counts(created.response.body.id)).toEqual(committed());
  });
  it("binds signed page cursors to actor, tenant, limit and current grants", async () => {
    await create();
    await create();
    const first = await use(ownerA, (service) => service.list({ limit: 1 }));
    assertContract("PageMessageDesign", first);
    expect(first.hasMore).toBe(true);
    const cursor = first.nextCursor!,
      member = await actor();
    expect((await use(ownerA, (service) => service.list({ limit: 1, cursor }))).items[0].id).not.toBe(
      first.items[0].id,
    );
    for (const [identity, limit] of [
      [member, 1],
      [ownerB, 1],
      [ownerA, 2],
    ] as const)
      await expect(use(identity, (service) => service.list({ limit, cursor }))).rejects.toMatchObject({
        status: 422,
        code: "cursor_invalid",
      });
    await expect(
      use(ownerA, (service) => service.list({ limit: 1, cursor: cursor + "x" })),
    ).rejects.toMatchObject({ status: 422 });
    const custom = await use(member, (service) => service.list({ limit: 1 }));
    await admin.query(
      "UPDATE app.role_definition SET permission_grants=permission_grants||$2::jsonb WHERE id=$1",
      [member.roleId, JSON.stringify([{ code: "crm.contacts.read", scope: "own" }])],
    );
    await expect(
      use(member, (service) => service.list({ limit: 1, cursor: custom.nextCursor! })),
    ).rejects.toMatchObject({ status: 422 });
  });
  it.each(["advisory", "source"] as const)(
    "rechecks DB-clock capability expiry after a real %s wait",
    async (kind) => {
      const created = await create(),
        id = created.response.body.id,
        key = randomUUID();
      const result = await blocked(
        (client) =>
          kind === "advisory"
            ? client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                fixtures.orgA +
                  ":" +
                  fixtures.ownerUser +
                  ":marketing:message-design:update:" +
                  id +
                  ":" +
                  key,
              ])
            : client.query("SELECT id FROM app.message_design WHERE id=$1 FOR UPDATE", [id]),
        (service) => service.update(id, input(), { key, ifMatch: '"1"' }),
        () => {},
        true,
      );
      expect(result).toHaveProperty("error");
      if ("error" in result)
        expect(result.error).toMatchObject({ status: 403, code: "entitlement_disabled" });
      expect(await counts(id)).toEqual(committed());
      expect(await snapshot(id)).toHaveLength(1);
    },
    15_000,
  );
  it("snapshots original caller body and headers before an observed asynchronous command wait", async () => {
    const created = await create(),
      id = created.response.body.id,
      body = input(),
      original = structuredClone(body),
      headers = { key: randomUUID(), ifMatch: '"1"' },
      originalKey = headers.key;
    const result = await blocked(
      (client) =>
        client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          fixtures.orgA +
            ":" +
            fixtures.ownerUser +
            ":marketing:message-design:update:" +
            id +
            ":" +
            originalKey,
        ]),
      (service) => service.update(id, body, headers),
      () => {
        body.name = "MUTATED_AFTER_WAIT";
        body.subject = "MUTATED_AFTER_WAIT";
        body.content = "MUTATED_AFTER_WAIT";
        body.design = { schemaVersion: 1, blocks: [{ type: "text", text: "MUTATED_AFTER_WAIT" }] };
        headers.key = randomUUID();
        headers.ifMatch = '"99"';
      },
    );
    expect(result).toHaveProperty("value");
    if ("value" in result) {
      expect(result.value.body).toMatchObject(original);
      expect(result.value.etag).toBe('"2"');
      expect(
        await use(ownerA, (service) => service.update(id, original, { key: originalKey, ifMatch: '"1"' })),
      ).toEqual(result.value);
    }
    expect(await counts(id)).toEqual(committed(2));
    expect((await snapshot(id))[1].rendered_content).toBe(original.content);
  }, 15_000);
  it("reference capture makes label-only/no-op edits immutable while unchanged replay remains safe", async () => {
    const created = await create(),
      id = created.response.body.id;
    const version = await bind(id);
    expect(await use(ownerA, (service) => service.create(created.body, { key: created.key }))).toEqual(
      created.response,
    );
    expect(await use(ownerA, (service) => service.get(id))).toEqual(created.response.body);
    for (const body of [created.body, { ...created.body, name: "New referenced label" }])
      await expect(
        use(ownerA, (service) => service.update(id, body, { key: randomUUID(), ifMatch: '"1"' })),
      ).rejects.toMatchObject({ status: 409, code: "design_referenced_immutable" });
    const binding = (
      await admin.query(
        "SELECT design_version,content_hash FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
        [version.body.id],
      )
    ).rows[0];
    expect(binding).toEqual({
      design_version: 1,
      content_hash: createHash("sha256").update(created.body.content).digest("hex"),
    });
    expect(await counts(id)).toEqual(committed());
  });
  it("integer/bigint sequence exhaustion rejects safely without a partial new snapshot", async () => {
    for (const [ordinal, rowRevision] of [
      [2147483647, "1"],
      [1, "9223372036854775807"],
    ] as const) {
      const id = randomUUID(),
        body = input();
      await admin.query(
        "INSERT INTO app.message_design(tenant_id,id,name,channel,subject,editor_kind,design,rendered_content,content_hash,version,row_version)VALUES($1,$2,$3,'email',$4,'native',$5,$6,$7,$8,$9)",
        [
          fixtures.orgA,
          id,
          body.name,
          body.subject,
          JSON.stringify(body.design),
          body.content,
          createHash("sha256").update(body.content).digest("hex"),
          ordinal,
          rowRevision,
        ],
      );
      await expect(
        use(ownerA, (service) =>
          service.update(id, body, { key: randomUUID(), ifMatch: '"' + ordinal + '"' }),
        ),
      ).rejects.toMatchObject({ status: 409, code: "design_revision_exhausted" });
      expect(await counts(id)).toEqual({ designs: 1, snapshots: 1, receipts: 0, audits: 0, events: 0 });
    }
  });
  it("caller rollback removes both revisions, receipts, audits and outbox records atomically", async () => {
    const rollback = new Error("Synthetic message-design rollback");
    let id = "";
    await expect(
      use(ownerA, async (service) => {
        const created = await service.create(input(), { key: randomUUID() });
        id = created.body.id;
        await service.update(id, input(), { key: randomUUID(), ifMatch: '"1"' });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(id).not.toBe("");
    expect(await counts(id)).toEqual({ designs: 0, snapshots: 0, receipts: 0, audits: 0, events: 0 });
  });
  it("large pages keep complete native entities within private transport budget with resumable cursors", async () => {
    const organizationId = randomUUID();
    await admin.query(
      "INSERT INTO app.organization(id,name,status)VALUES($1,'Synthetic large design page','active')",
      [organizationId],
    );
    await admin.query(
      "INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'marketing','enabled')",
      [organizationId],
    );
    const member = await actor(grants, organizationId),
      bodies = Array.from({ length: 5 }, () => input("😀".repeat(31_000)));
    const created = [];
    for (const body of bodies) created.push((await create(body, randomUUID(), member)).response.body);
    const ordered = created.sort((a, b) => a.id.localeCompare(b.id));
    const first = await use(member, (service) => service.list({ limit: 100 }));
    assertContract("PageMessageDesign", first);
    expect(first.items).toEqual(ordered.slice(0, 4));
    expect(first.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(1_048_576);
    const last = await use(member, (service) => service.list({ limit: 100, cursor: first.nextCursor! }));
    expect(last).toEqual({ items: ordered.slice(4), nextCursor: null, hasMore: false });
    for (const entity of [...first.items, ...last.items]) expect(entity.content).toBe("😀".repeat(31_000));
  });
  it("the real lead-only worker leaves native-design events untouched without receipt, ack or delivery", async () => {
    const all = (
      await admin.query(
        "SELECT id,event_type FROM app.outbox WHERE tenant_id=$1 AND initiating_actor_id=$2 AND published_at IS NULL",
        [fixtures.orgA, fixtures.ownerUser],
      )
    ).rows;
    const ids = all.filter((row) => row.event_type === "message_design.draft_changed").map((row) => row.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(all.length).toBeLessThanOrEqual(100);
    expect(await dispatchOutbox(worker, ownerA, 100)).toEqual({ dispatched: 0, deferred: 0 });
    const rows = (
      await admin.query(
        "SELECT published_at,attempt_count,lease_until FROM app.outbox WHERE id=ANY($1::uuid[])",
        [ids],
      )
    ).rows;
    for (const row of rows) expect(row).toEqual({ published_at: null, attempt_count: 0, lease_until: null });
    expect(
      (
        await admin.query("SELECT event_id FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])", [
          ids,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT id FROM app.audit_event WHERE resource_type='outbox'AND resource_id=ANY($1::text[])",
          [ids],
        )
      ).rowCount,
    ).toBe(0);
  });
});
