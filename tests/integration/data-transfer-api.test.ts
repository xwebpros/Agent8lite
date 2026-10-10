import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseCsv } from "../../apps/api/src/csv";
import { fixtures } from "../../packages/db/fixtures";
import { apiOrigin, ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
const privateRoot = path.resolve(
  process.env.PRIVATE_OBJECT_DIRECTORY ?? path.join(process.cwd(), ".local", "private-objects"),
);
let owner: ApiSession;
let agent: ApiSession;
let originalMember: Record<string, any>;
let customRole: Schemas["Role"];
const grants: Schemas["RoleWrite"]["permissions"] = [
  { code: "crm.contacts.read", scope: "own" },
  { code: "crm.contacts.write", scope: "own" },
  { code: "crm.leads.read", scope: "own" },
  { code: "crm.leads.write", scope: "own" },
  { code: "crm.import", scope: "own" },
  { code: "data.export", scope: "organization" },
  { code: "media.write", scope: "organization" },
  { code: "jobs.read", scope: "organization" },
];
const assets = new Set<string>();
const imports = new Set<string>();
const jobs = new Set<string>();
const contacts = new Set<string>();
const leads = new Set<string>();
const keys = new Set<string>();
const privateKeys = new Set<string>();
const recordNames = new Set<string>();
const prefix = () => `Synthetic transfer ${randomUUID()}`;
const orgPath = (session: ApiSession, resource: string) => `/v1/orgs/${session.orgId}/${resource}`;
const mapping: Schemas["ImportPreviewRequest"]["columnMap"] = { Name: "displayName", Email: "email" };

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
  originalMember = (
    await admin.query("SELECT role_id,status FROM app.membership WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      agent.memberId,
    ])
  ).rows[0];
  const response = await owner.command(orgPath(owner, "roles"), { name: prefix(), permissions: grants });
  expect(response.status).toBe(201);
  const value = await response.json();
  assertContract("Role", value);
  customRole = value;
});
beforeEach(async () => {
  await admin.query(
    "UPDATE app.membership SET role_id=$3,status='active',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, agent.memberId, customRole.id],
  );
});
afterEach(async () => {
  if (owner.orgId !== fixtures.orgA) expect((await owner.switchOrganization(fixtures.orgA)).status).toBe(200);
  await admin.query(
    "UPDATE app.membership SET role_id=$3,status=$4,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, agent.memberId, originalMember.role_id, originalMember.status],
  );
  await admin.query(
    "UPDATE app.role_definition SET permission_grants=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, customRole.id, JSON.stringify(grants)],
  );
  if (recordNames.size) {
    const created = (
      await admin.query("SELECT id FROM app.contact WHERE tenant_id=$1 AND display_name=ANY($2::text[])", [
        fixtures.orgA,
        [...recordNames],
      ])
    ).rows;
    for (const row of created) contacts.add(row.id);
  }
  if (contacts.size)
    for (const row of (
      await admin.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND contact_id=ANY($2::uuid[])", [
        fixtures.orgA,
        [...contacts],
      ])
    ).rows)
      leads.add(row.id);
  if (assets.size)
    for (const row of (
      await admin.query("SELECT object_key FROM app.media_asset WHERE id=ANY($1::uuid[])", [[...assets]])
    ).rows)
      privateKeys.add(row.object_key);
  if (jobs.size)
    for (const row of (
      await admin.query(
        "SELECT safe_result->>'objectKey' object_key FROM app.integration_job WHERE id=ANY($1::uuid[])",
        [[...jobs]],
      )
    ).rows)
      if (row.object_key) privateKeys.add(row.object_key);
  const resources = [...assets, ...imports, ...jobs, ...contacts, ...leads];
  if (resources.length) {
    const eventIds = (
      await admin.query("SELECT id FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=ANY($2::text[])", [
        fixtures.orgA,
        resources,
      ])
    ).rows.map((row) => row.id);
    if (eventIds.length) {
      await admin.query("DELETE FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])", [eventIds]);
      await admin.query("DELETE FROM app.outbox WHERE id=ANY($1::uuid[])", [eventIds]);
    }
    await admin.query("DELETE FROM app.audit_event WHERE tenant_id=$1 AND resource_id=ANY($2::text[])", [
      fixtures.orgA,
      resources,
    ]);
  }
  if (leads.size) {
    await admin.query("DELETE FROM app.stage_transition WHERE tenant_id=$1 AND lead_id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...leads],
    ]);
    await admin.query("DELETE FROM app.activity_event WHERE tenant_id=$1 AND lead_id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...leads],
    ]);
    await admin.query("DELETE FROM app.lead WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...leads],
    ]);
  }
  if (contacts.size) {
    await admin.query("DELETE FROM app.contact_channel WHERE tenant_id=$1 AND contact_id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...contacts],
    ]);
    await admin.query("DELETE FROM app.contact WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...contacts],
    ]);
  }
  if (imports.size)
    await admin.query("DELETE FROM app.import_job WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...imports],
    ]);
  if (jobs.size)
    await admin.query("DELETE FROM app.integration_job WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...jobs],
    ]);
  if (assets.size)
    await admin.query("DELETE FROM app.media_asset WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...assets],
    ]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  for (const key of privateKeys) {
    const absolute = privatePath(key);
    try {
      await unlink(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const set of [assets, imports, jobs, contacts, leads, keys, privateKeys, recordNames]) set.clear();
});
afterAll(async () => {
  if (customRole) {
    await admin.query(
      "DELETE FROM app.audit_event WHERE tenant_id=$1 AND resource_type='roles' AND resource_id=$2",
      [fixtures.orgA, customRole.id],
    );
    await admin.query("DELETE FROM app.role_definition WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      customRole.id,
    ]);
  }
  await admin.end();
});

function privatePath(key: string) {
  const absolute = path.resolve(privateRoot, ...key.split("/"));
  expect(absolute.startsWith(`${privateRoot}${path.sep}`)).toBe(true);
  expect(key.startsWith(`${fixtures.orgA}/`)).toBe(true);
  expect(key.split("/").some((part) => part === ".." || part === ".")).toBe(false);
  return absolute;
}
async function command(session: ApiSession, resource: string, body: unknown, key = randomUUID()) {
  keys.add(key);
  return session.command(orgPath(session, resource), body, { key });
}
async function grant(bytes: Buffer, session = agent) {
  const response = await command(session, "uploads", {
    filename: "synthetic.csv",
    mimeType: "text/csv",
    bytes: bytes.length,
    purpose: "contact_import",
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const value = await response.json();
  assertContract("UploadGrant", value);
  assets.add(value.assetId);
  return value;
}
function put(
  value: Schemas["UploadGrant"],
  bytes: Buffer,
  options: { session?: ApiSession; mime?: string; csrf?: string; signature?: string } = {},
) {
  const session = options.session ?? agent;
  return fetch(`${apiOrigin}/dev/storage/uploads/${value.assetId}`, {
    method: "PUT",
    headers: {
      cookie: session.cookie,
      origin: process.env.TEST_WEB_ORIGIN ?? "http://localhost:3000",
      "x-csrf-token": options.csrf ?? session.csrf,
      "content-type": options.mime ?? "text/csv",
      "x-upload-grant": options.signature ?? String(value.requiredHeaders["X-Upload-Grant"]),
    },
    body: new Uint8Array(bytes),
  });
}
async function preview(bytes: Buffer, columnMap = mapping) {
  const upload = await grant(bytes);
  const result = await put(upload, bytes);
  expect(result.status, await result.clone().text()).toBe(204);
  const response = await command(agent, "imports/contact-previews", { assetId: upload.assetId, columnMap });
  expect(response.status, await response.clone().text()).toBe(201);
  const value = await response.json();
  assertContract("ImportPreview", value);
  imports.add(value.id);
  return { value, upload };
}
function commitBody(value: Schemas["ImportPreview"]): Schemas["ImportCommit"] {
  return { previewId: value.id, duplicatePolicy: "skip", confirmedRowCount: value.validRows };
}
async function exportJob(session: ApiSession, kind: "contacts" | "leads", filter: Schemas["LeadFilter"]) {
  const response = await command(session, "exports", { kind, filter });
  expect(response.status, await response.clone().text()).toBe(202);
  const value = await response.json();
  assertContract("Job", value);
  jobs.add(value.id);
  expect(value.state).toBe("succeeded");
  expect(new URL(value.resultUrl!).pathname).toBe(`/api/dev/exports/${value.id}`);
  return value;
}
async function contact(session = agent, displayName = prefix(), emails = [`${randomUUID()}@example.test`]) {
  recordNames.add(displayName);
  const response = await command(session, "contacts", { displayName, emails, phones: [] });
  expect(response.status).toBe(201);
  const value = await response.json();
  assertContract("Contact", value);
  contacts.add(value.id);
  return value;
}

describe("M2 — reviewed CSV imports and scoped private export artifacts", () => {
  it("upload grants enforce requester, CSRF, MIME, bytes, expiry and immutable retry content", async () => {
    const bytes = Buffer.from("Name,Email\nFirst,first@example.test\n");
    const upload = await grant(bytes);
    await assertProblem(await put(upload, bytes, { csrf: "invalid" }), 403);
    await assertProblem(await put(upload, bytes, { session: owner }), 404);
    await assertProblem(await put(upload, bytes, { mime: "text/plain" }), 422);
    await assertProblem(await put(upload, Buffer.concat([bytes, Buffer.from("\n")])), 422);
    await assertProblem(await put(upload, bytes, { signature: "invalid" }), 422);
    expect((await put(upload, bytes)).status).toBe(204);
    expect((await put(upload, bytes)).status).toBe(204);
    await assertProblem(await put(upload, Buffer.from(bytes.toString().replace("First", "Other"))), 409);
    const expired = await grant(bytes);
    await admin.query(
      "UPDATE app.media_asset SET upload_expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, expired.assetId],
    );
    await assertProblem(await put(expired, bytes), 422);
    await assertProblem(
      await command(agent, "uploads", {
        filename: "unsafe.html",
        mimeType: "text/html",
        bytes: 10,
        purpose: "media",
      }),
      422,
    );
  });

  it("preview reports deterministic duplicate/invalid counts and same-key commit creates one reviewed result", async () => {
    const existing = await contact();
    const name = prefix();
    recordNames.add(name);
    const email = `${randomUUID()}@example.test`;
    const bytes = Buffer.from(
      `Name,Email,Intent,Source\nDuplicate,${existing.emails[0]},buyer,synthetic-inquiry\n${name},${email},buyer,synthetic-inquiry\nRepeated,${email},buyer,synthetic-inquiry\nInvalid,not-an-email,buyer,synthetic-inquiry\n`,
    );
    const created = await preview(bytes, { ...mapping, Intent: "intent", Source: "sourceCode" });
    expect(created.value).toMatchObject({ validRows: 3, invalidRows: 1, duplicates: 2 });
    expect(created.value.sampleErrors).toHaveLength(1);
    expect(JSON.stringify(created.value.sampleErrors)).not.toContain("not-an-email");
    const key = randomUUID();
    keys.add(key);
    const responses = await Promise.all([
      agent.command(orgPath(agent, "imports/contact-commits"), commitBody(created.value), { key }),
      agent.command(orgPath(agent, "imports/contact-commits"), commitBody(created.value), { key }),
    ]);
    for (const response of responses) {
      if (response.status === 202) jobs.add((await response.clone().json()).id);
      expect(response.status, await response.clone().text()).toBe(202);
    }
    const accepted = await responses[0].json();
    assertContract("Job", accepted);
    expect(await responses[1].json()).toEqual(accepted);
    expect(
      (await admin.query("SELECT safe_result FROM app.integration_job WHERE id=$1", [accepted.id])).rows[0]
        .safe_result,
    ).toMatchObject({ imported: 1, skipped: 2, invalid: 1, synthetic: true });
    const imported = (
      await admin.query("SELECT id FROM app.contact WHERE tenant_id=$1 AND display_name=$2", [
        fixtures.orgA,
        name,
      ])
    ).rows;
    expect(imported).toHaveLength(1);
    contacts.add(imported[0].id);
    const owned = (
      await admin.query("SELECT id,owner_member_id FROM app.lead WHERE tenant_id=$1 AND contact_id=$2", [
        fixtures.orgA,
        imported[0].id,
      ])
    ).rows;
    expect(owned).toHaveLength(1);
    expect(owned[0].owner_member_id).toBe(agent.memberId);
    leads.add(owned[0].id);
    await assertProblem(await command(agent, "imports/contact-commits", commitBody(created.value)), 409);
    await assertProblem(
      await command(
        agent,
        "imports/contact-commits",
        { ...commitBody(created.value), confirmedRowCount: 2 },
        key,
      ),
      409,
    );
  });

  it("requires valid explicit mapping, reviewed count, supported duplicate policy and an unexpired preview", async () => {
    const bytes = Buffer.from(`Name,Email\n${prefix()},${randomUUID()}@example.test\n`);
    const upload = await grant(bytes);
    await assertProblem(
      await command(agent, "imports/contact-previews", { assetId: upload.assetId, columnMap: mapping }),
      409,
    );
    expect((await put(upload, bytes)).status).toBe(204);
    for (const columnMap of [
      { Email: "email" },
      { Name: "displayName", Email: "displayName" },
      { Missing: "displayName" },
    ])
      await assertProblem(
        await command(agent, "imports/contact-previews", { assetId: upload.assetId, columnMap }),
        422,
      );
    const created = await preview(bytes);
    await assertProblem(
      await command(agent, "imports/contact-commits", { ...commitBody(created.value), confirmedRowCount: 2 }),
      409,
    );
    await assertProblem(
      await command(agent, "imports/contact-commits", {
        ...commitBody(created.value),
        duplicatePolicy: "merge_reviewed",
      }),
      422,
    );
    await admin.query(
      "UPDATE app.import_job SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, created.value.id],
    );
    await assertProblem(await command(agent, "imports/contact-commits", commitBody(created.value)), 409);
    expect(
      (await admin.query("SELECT accepted_job_id FROM app.import_job WHERE id=$1", [created.value.id]))
        .rows[0].accepted_job_id,
    ).toBeNull();
  });

  it("cannot commit bytes changed after review or a preview from an earlier permission context", async () => {
    const bytes = Buffer.from(`Name,Email\n${prefix()},${randomUUID()}@example.test\n`);
    const changed = await preview(bytes);
    const objectKey = (
      await admin.query("SELECT object_key FROM app.media_asset WHERE id=$1", [changed.upload.assetId])
    ).rows[0].object_key;
    const target = privatePath(objectKey);
    try {
      await writeFile(target, Buffer.from(bytes.toString().replace("Name", "Other")));
      await assertProblem(await command(agent, "imports/contact-commits", commitBody(changed.value)), 409);
    } finally {
      await writeFile(target, bytes);
    }
    const scoped = await preview(bytes);
    await admin.query(
      "UPDATE app.role_definition SET permission_grants=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [
        fixtures.orgA,
        customRole.id,
        JSON.stringify([...grants, { code: "support.read", scope: "organization" }]),
      ],
    );
    await assertProblem(await command(agent, "imports/contact-commits", commitBody(scoped.value)), 409);
    await assertProblem(await command(owner, "imports/contact-commits", commitBody(scoped.value)), 404);
    expect((await owner.switchOrganization(fixtures.orgB)).status).toBe(200);
    await assertProblem(await command(owner, "imports/contact-commits", commitBody(scoped.value)), 404);
  });

  it("a changed duplicate candidate revision invalidates the reviewed decision even when counts stay equal", async () => {
    const existing = await contact();
    const created = await preview(Buffer.from(`Name,Email\nDuplicate,${existing.emails[0]}\n`));
    expect(created.value).toMatchObject({ validRows: 1, duplicates: 1, invalidRows: 0 });
    await admin.query("UPDATE app.contact SET row_version=row_version+1 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      existing.id,
    ]);
    await assertProblem(await command(agent, "imports/contact-commits", commitBody(created.value)), 409);
    expect(
      (await admin.query("SELECT accepted_job_id FROM app.import_job WHERE id=$1", [created.value.id]))
        .rows[0].accepted_job_id,
    ).toBeNull();
  });

  it("overlapping independent previews cannot concurrently create duplicate contact decisions", async () => {
    const name = prefix();
    recordNames.add(name);
    const bytes = Buffer.from(`Name,Email\n${name},${randomUUID()}@example.test\n`);
    const first = await preview(bytes);
    const second = await preview(bytes);
    const responses = await Promise.all([
      command(agent, "imports/contact-commits", commitBody(first.value)),
      command(agent, "imports/contact-commits", commitBody(second.value)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    for (const response of responses) if (response.status === 202) jobs.add((await response.json()).id);
    const stored = (
      await admin.query("SELECT id FROM app.contact WHERE tenant_id=$1 AND display_name=$2", [
        fixtures.orgA,
        name,
      ])
    ).rows;
    expect(stored).toHaveLength(1);
    contacts.add(stored[0].id);
  });

  it("own exports exclude other owners, organization exports include them, and spreadsheet formulas are neutralized", async () => {
    const common = prefix();
    const own = await contact(agent, `=1+1 ${common}`);
    const other = await contact(owner, `${common} other owner`);
    const ownJob = await exportJob(agent, "contacts", { q: common });
    const response = await agent.request(`/dev/exports/${ownJob.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    const rows = parseCsv(Buffer.from(await response.arrayBuffer()));
    expect(rows[0][0]).toBe("SYNTHETIC DEMO DATA");
    expect(rows.slice(1).map((row) => row[1])).toEqual([own.id]);
    expect(rows[1][2]).toBe(`'=1+1 ${common}`);
    await assertProblem(await owner.request(`/dev/exports/${ownJob.id}`), 404);
    const orgJob = await exportJob(owner, "contacts", { q: common });
    const orgRows = parseCsv(
      Buffer.from(await (await owner.request(`/dev/exports/${orgJob.id}`)).arrayBuffer()),
    );
    expect(
      orgRows
        .slice(1)
        .map((row) => row[1])
        .sort(),
    ).toEqual([own.id, other.id].sort());
    expect((await owner.switchOrganization(fixtures.orgB)).status).toBe(200);
    await assertProblem(await owner.request(`/dev/exports/${orgJob.id}`), 404);
  });

  it("downloads reject a changed source revision and expired artifact rather than serving the old bytes", async () => {
    const item = await contact();
    const created = await exportJob(agent, "contacts", { q: item.displayName });
    await admin.query("UPDATE app.contact SET row_version=row_version+1 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      item.id,
    ]);
    await assertProblem(await agent.request(`/dev/exports/${created.id}`), 409);
    const expired = await exportJob(agent, "contacts", { q: item.displayName });
    await admin.query(
      "UPDATE app.integration_job SET safe_result=jsonb_set(safe_result,'{expiresAt}',to_jsonb((now()-interval '1 second')::text)) WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, expired.id],
    );
    await assertProblem(await agent.request(`/dev/exports/${expired.id}`), 410);
  });

  it("downloads recheck current membership, grants, entitlement and assigned lead scope", async () => {
    const item = await contact();
    const leadResponse = await command(agent, "leads", {
      contactId: item.id,
      sourceId: fixtures.sourceA,
      ownerMemberId: agent.memberId,
      intent: "buyer",
    });
    expect(leadResponse.status).toBe(201);
    const lead = await leadResponse.json();
    assertContract("Lead", lead);
    leads.add(lead.id);
    const assigned = await exportJob(agent, "leads", { ownerMemberId: agent.memberId, q: item.displayName });
    await admin.query(
      "UPDATE app.lead SET owner_member_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, lead.id, owner.memberId],
    );
    await assertProblem(await agent.request(`/dev/exports/${assigned.id}`), 404);
    const access = await exportJob(agent, "contacts", { q: item.displayName });
    await admin.query(
      "UPDATE app.membership SET status='disabled',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, agent.memberId],
    );
    try {
      await assertProblem(await agent.request(`/dev/exports/${access.id}`), 403);
    } finally {
      await admin.query(
        "UPDATE app.membership SET status='active',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, agent.memberId],
      );
    }
    const currentEntitlement = (
      await admin.query(
        "SELECT state,effective_until FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'",
        [fixtures.orgA],
      )
    ).rows[0];
    try {
      await admin.query(
        "UPDATE app.entitlement SET state='disabled',row_version=row_version+1 WHERE tenant_id=$1 AND feature='crm'",
        [fixtures.orgA],
      );
      await assertProblem(await agent.request(`/dev/exports/${access.id}`), 403);
    } finally {
      await admin.query(
        "UPDATE app.entitlement SET state=$2,effective_until=$3,row_version=row_version+1 WHERE tenant_id=$1 AND feature='crm'",
        [fixtures.orgA, currentEntitlement.state, currentEntitlement.effective_until],
      );
    }
    await admin.query(
      "UPDATE app.role_definition SET permission_grants=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [
        fixtures.orgA,
        customRole.id,
        JSON.stringify([...grants, { code: "support.read", scope: "organization" }]),
      ],
    );
    await assertProblem(await agent.request(`/dev/exports/${access.id}`), 403);
    await assertProblem(await command(agent, "exports", { kind: "report", filter: {} }), 422);
  });
});
