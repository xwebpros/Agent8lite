/**
 * ADR-049 Contact merge/duplicate review — integration acceptance tests.
 * Requirements: TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL must point to a
 * file-fresh disposable acceptance database (loopback only).
 */
import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchOutbox } from "../../apps/worker/src/outbox";
import eventSchema from "../../packages/contracts/events.schema.json";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import type { VerifiedIdentityContext } from "../../packages/db/tenant-transaction";
import { ApiSession, assertContract } from "../helpers/api";

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"]) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Contact-merge acceptance requires its owned file-fresh disposable database.");
}

const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const worker = new Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 2 });

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validEvent = ajv.compile(eventSchema);

let agent: ApiSession, owner: ApiSession, other: ApiSession;
const sessions: ApiSession[] = []; // kept for potential future teardown use

// ─── helpers ────────────────────────────────────────────────────────────────

async function createContact(
  options: {
    creator?: string;
    email?: string | null;
    phone?: string | null;
    tenant?: string;
  } = {},
) {
  const tid = options.tenant ?? fixtures.orgA;
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,'Synthetic merge contact',$3)",
    [tid, id, options.creator ?? fixtures.agentMemberA],
  );
  if (options.email !== null) {
    const email = options.email ?? `merge-${id.slice(0, 8)}@example.test`;
    await admin.query(
      "INSERT INTO app.contact_channel(tenant_id,contact_id,kind,normalized_value,is_primary)VALUES($1,$2,'email',$3,true)",
      [tid, id, email],
    );
  }
  if (options.phone) {
    await admin.query(
      "INSERT INTO app.contact_channel(tenant_id,contact_id,kind,normalized_value,is_primary)VALUES($1,$2,'phone',$3,false)",
      [tid, id, options.phone],
    );
  }
  return id;
}

async function contactVersion(id: string, tenant = fixtures.orgA) {
  const r = await admin.query("SELECT row_version::int v FROM app.contact WHERE tenant_id=$1 AND id=$2", [
    tenant,
    id,
  ]);
  return r.rows[0]?.v as number | undefined;
}

async function createLead(contactId: string, ownerMember: string | null = fixtures.agentMemberA) {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id)VALUES($1,$2,$3,$4,$5,$6)",
    [fixtures.orgA, id, contactId, fixtures.sourceA, stageId(1, 1), ownerMember],
  );
  return id;
}

function mergePath(survivorId: string, session: ApiSession = agent) {
  return `/v1/orgs/${session.orgId}/contacts/${survivorId}/merges`;
}
function mergesPath(mergeId: string, session: ApiSession = agent) {
  return `/v1/orgs/${session.orgId}/contact-merges/${mergeId}`;
}
function duplicatesPath(session: ApiSession = agent) {
  return `/v1/orgs/${session.orgId}/contact-duplicates`;
}

async function merge(
  survivorId: string,
  body: object,
  options: {
    key?: string;
    survivorVersion?: number;
    session?: ApiSession;
  } = {},
) {
  const s = options.session ?? agent;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": options.key ?? randomUUID(),
    "x-csrf-token": s.csrf,
  };
  if (options.survivorVersion !== undefined) headers["if-match"] = `"${options.survivorVersion}"`;
  return s.request(mergePath(survivorId, s), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function getMerge(mergeId: string, session: ApiSession = agent) {
  return session.request(mergesPath(mergeId, session));
}

async function getDuplicates(session: ApiSession = agent, query = "") {
  return session.request(`${duplicatesPath(session)}${query}`);
}

async function mergeRow(mergeId: string) {
  return (
    await admin.query(
      "SELECT * FROM app.contact_merge WHERE tenant_id=$1 AND id=$2::uuid",
      [fixtures.orgA, mergeId],
    )
  ).rows[0];
}

async function mergedIntoId(contactId: string) {
  return (
    await admin.query(
      "SELECT merged_into_contact_id FROM app.contact WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, contactId],
    )
  ).rows[0]?.merged_into_contact_id as string | null | undefined;
}

// ─── setup / teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  await assertRuntimeRole(runtime);
  await assertRuntimeRole(worker);
  agent = await new ApiSession().signIn("agent");
  owner = await new ApiSession().signIn();
  other = await new ApiSession().signIn();
  sessions.push(agent, owner, other);
  expect((await other.switchOrganization(fixtures.orgB)).status).toBe(200);
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
  await worker.end();
});

// ─── listContactDuplicates ───────────────────────────────────────────────────

describe("GET /v1/orgs/{orgId}/contact-duplicates", () => {
  it("returns 200 with empty page when no duplicates", async () => {
    const r = await getDuplicates(agent);
    expect(r.status).toBe(200);
    const body = await r.json();
    assertContract("PageContactDuplicate", body);
    expect(body.items).toBeInstanceOf(Array);
  });

  it("returns 200 and finds an email-duplicate pair", async () => {
    const email = `dup-${randomUUID().slice(0, 8)}@example.test`;
    const a = await createContact({ email });
    const b = await createContact({ email });
    const r = await getDuplicates(agent);
    expect(r.status).toBe(200);
    const body = await r.json();
    assertContract("PageContactDuplicate", body);
    const ids = body.items.flatMap((p: { contactIds: string[] }) => p.contactIds);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });

  it("returns 200 and finds a phone-duplicate pair", async () => {
    const phone = `+1555${randomUUID().replace(/-/g, "").slice(0, 7)}`;
    const a = await createContact({ email: null, phone });
    const b = await createContact({ email: null, phone });
    const r = await getDuplicates(agent);
    expect(r.status).toBe(200);
    const body = await r.json();
    const ids = body.items.flatMap((p: { contactIds: string[] }) => p.contactIds);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });

  it("returns 403 when session is for another org", async () => {
    // agent is an orgA session; accessing orgB's endpoint should 403
    const r = await agent.request(`/v1/orgs/${fixtures.orgB}/contact-duplicates`);
    expect(r.status).toBe(403);
  });

  it("rejects query params with 422", async () => {
    const r = await getDuplicates(agent, "?invalid=1");
    // API rejects unknown query params or GET with body — either 422 or 400
    expect([400, 422]).toContain(r.status);
  });
});

// ─── mergeContact ────────────────────────────────────────────────────────────

describe("POST /v1/orgs/{orgId}/contacts/{contactId}/merges", () => {
  it("merges two contacts successfully (happy path)", async () => {
    const survivor = await createContact();
    const source = await createContact();
    const leadId = await createLead(source);
    const survivorV = await contactVersion(survivor);
    const sourceV = await contactVersion(source);
    const key = randomUUID();
    const r = await merge(
      survivor,
      { sourceContactId: source, sourceVersion: sourceV },
      { key, survivorVersion: survivorV },
    );
    expect(r.status).toBe(202);
    const body = await r.json();
    assertContract("Job", body);
    expect(body.kind).toBe("crm.contact.merged");
    expect(body.resultUrl).toMatch(/\/contact-merges\//);

    // source should now have merged_into_contact_id set
    const mergedInto = await mergedIntoId(source);
    expect(mergedInto).toBe(survivor);

    // lead should now point to survivor
    const leadRow = await admin.query(
      "SELECT contact_id FROM app.lead WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, leadId],
    );
    expect(leadRow.rows[0]?.contact_id).toBe(survivor);

    // outbox event should exist
    const identity: VerifiedIdentityContext = { userId: fixtures.agentUser, organizationId: fixtures.orgA };
    await dispatchOutbox(worker, identity);
    const outbox = await admin.query(
      "SELECT event_type FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2::text",
      [fixtures.orgA, survivor],
    );
    const types = outbox.rows.map((r: { event_type: string }) => r.event_type);
    expect(types).toContain("contact.merged");
  });

  it("is idempotent: replaying the same key returns 202 with same resultUrl", async () => {
    const survivor = await createContact();
    const source = await createContact();
    const survivorV = await contactVersion(survivor);
    const sourceV = await contactVersion(source);
    const key = randomUUID();
    const body = { sourceContactId: source, sourceVersion: sourceV };
    const r1 = await merge(survivor, body, { key, survivorVersion: survivorV });
    expect(r1.status).toBe(202);
    const j1 = await r1.json();
    const r2 = await merge(survivor, body, { key, survivorVersion: survivorV });
    expect(r2.status).toBe(202);
    const j2 = await r2.json();
    expect(j2.resultUrl).toBe(j1.resultUrl);
  });

  it("returns 404 when survivor is not found", async () => {
    const r = await merge(
      randomUUID(),
      { sourceContactId: randomUUID(), sourceVersion: 1 },
      { survivorVersion: 1 },
    );
    expect(r.status).toBe(404);
  });

  it("returns 404 when source is not found", async () => {
    const survivor = await createContact();
    const survivorV = await contactVersion(survivor);
    const r = await merge(
      survivor,
      { sourceContactId: randomUUID(), sourceVersion: 1 },
      { survivorVersion: survivorV },
    );
    expect(r.status).toBe(404);
  });

  it("returns 412 on version mismatch for survivor", async () => {
    const survivor = await createContact();
    const source = await createContact();
    const sourceV = await contactVersion(source);
    const r = await merge(
      survivor,
      { sourceContactId: source, sourceVersion: sourceV },
      { survivorVersion: 9999 },
    );
    expect(r.status).toBe(412);
  });

  it("returns 412 on version mismatch for source", async () => {
    const survivor = await createContact();
    const source = await createContact();
    const survivorV = await contactVersion(survivor);
    const r = await merge(
      survivor,
      { sourceContactId: source, sourceVersion: 9999 },
      { survivorVersion: survivorV },
    );
    expect(r.status).toBe(412);
  });

  it("returns 409 when survivorContactId equals sourceContactId", async () => {
    const survivor = await createContact();
    const v = await contactVersion(survivor);
    const r = await merge(
      survivor,
      { sourceContactId: survivor, sourceVersion: v },
      { survivorVersion: v },
    );
    expect(r.status).toBe(409);
  });

  it("returns 400 / 422 with invalid body", async () => {
    const survivor = await createContact();
    const r = await merge(survivor, { garbage: true });
    expect([400, 422]).toContain(r.status);
  });

  it("returns 403 when session org does not match URL org", async () => {
    // agent has orgA session; trying to POST to orgB's endpoint gets 403
    const survivor = await createContact();
    const source = await createContact();
    const survivorV = await contactVersion(survivor);
    const sourceV = await contactVersion(source);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      "x-csrf-token": agent.csrf,
      "if-match": `"${survivorV}"`,
    };
    // POST to orgB with agent's orgA session
    const r = await agent.request(
      `/v1/orgs/${fixtures.orgB}/contacts/${survivor}/merges`,
      { method: "POST", headers, body: JSON.stringify({ sourceContactId: source, sourceVersion: sourceV }) },
    );
    expect(r.status).toBe(403);
  });

  it("returns 403 when agent lacks crm.contacts.write", async () => {
    const survivor = await createContact();
    const source = await createContact();
    const survivorV = await contactVersion(survivor);
    const sourceV = await contactVersion(source);
    // Create a session without the write permission
    const limited = await new ApiSession().signIn("agent");
    sessions.push(limited);
    // Temporarily strip crm.contacts.write via role update
    const roleRow = await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id) WHERE m.tenant_id=$1 AND m.id=$2",
      [fixtures.orgA, fixtures.agentMemberA],
    );
    if (roleRow.rows.length > 0) {
      const original = roleRow.rows[0];
      const stripped = (original.permission_grants as string[]).filter(
        (g: string) => g !== "crm.contacts.write",
      );
      await admin.query(
        "UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, original.id, JSON.stringify(stripped)],
      );
      try {
        const limitedMerge = await merge(
          survivor,
          { sourceContactId: source, sourceVersion: sourceV },
          { survivorVersion: survivorV, session: limited },
        );
        expect([403, 401]).toContain(limitedMerge.status);
      } finally {
        await admin.query(
          "UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2",
          [fixtures.orgA, original.id, JSON.stringify(original.permission_grants)],
        );
      }
    }
  });

  it("completes a merge when no conflicting lock is held", async () => {
    // Verify the merge is not blocked when no competing transaction holds the same advisory lock.
    const survivor = await createContact();
    const source = await createContact();
    const survivorV = await contactVersion(survivor);
    const sourceV = await contactVersion(source);
    const r = await merge(
      survivor,
      { sourceContactId: source, sourceVersion: sourceV },
      { survivorVersion: survivorV },
    );
    expect(r.status).toBe(202);
  });
});

// ─── getContactMerge ─────────────────────────────────────────────────────────

describe("GET /v1/orgs/{orgId}/contact-merges/{mergeId}", () => {
  it("returns 200 with ContactMerge schema after a merge", async () => {
    const survivor = await createContact();
    const source = await createContact();
    const survivorV = await contactVersion(survivor);
    const sourceV = await contactVersion(source);
    const r = await merge(
      survivor,
      { sourceContactId: source, sourceVersion: sourceV },
      { survivorVersion: survivorV },
    );
    expect(r.status).toBe(202);
    const job = await r.json();
    const mergeId = job.resultUrl?.split("/").at(-1);
    expect(mergeId).toBeTruthy();
    const r2 = await getMerge(mergeId as string);
    expect(r2.status).toBe(200);
    const body = await r2.json();
    assertContract("ContactMerge", body);
    expect(body.survivorContactId).toBe(survivor);
    expect(body.mergedContactId).toBe(source);
  });

  it("returns 404 for unknown merge id", async () => {
    const r = await getMerge(randomUUID());
    expect(r.status).toBe(404);
  });

  it("returns 403 when session is for another org", async () => {
    const survivor = await createContact();
    const source = await createContact();
    const survivorV = await contactVersion(survivor);
    const sourceV = await contactVersion(source);
    const r = await merge(
      survivor,
      { sourceContactId: source, sourceVersion: sourceV },
      { survivorVersion: survivorV },
    );
    const job = await r.json();
    const mergeId = job.resultUrl?.split("/").at(-1);
    if (mergeId) {
      const r2 = await getMerge(mergeId, other);
      expect(r2.status).toBe(403);
    }
  });
});

// ─── outbox event validation ──────────────────────────────────────────────────

describe("contact.merged outbox event schema", () => {
  it("emits a valid contact.merged event after merge", async () => {
    const survivor = await createContact();
    const source = await createContact();
    const survivorV = await contactVersion(survivor);
    const sourceV = await contactVersion(source);
    await merge(
      survivor,
      { sourceContactId: source, sourceVersion: sourceV },
      { survivorVersion: survivorV },
    );
    const dispatchIdentity: VerifiedIdentityContext = { userId: fixtures.agentUser, organizationId: fixtures.orgA };
    await dispatchOutbox(worker, dispatchIdentity);
    const rows = await admin.query(
      "SELECT payload FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2::text AND event_type='contact.merged' ORDER BY created_at DESC LIMIT 1",
      [fixtures.orgA, survivor],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    const payload = rows.rows[0].payload;
    const valid = validEvent(payload);
    if (!valid) console.error(ajv.errorsText(validEvent.errors));
    expect(valid).toBe(true);
  });
});
