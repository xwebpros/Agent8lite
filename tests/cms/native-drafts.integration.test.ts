import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CmsService } from "../../apps/api/src/cms";
import { encodeCursor } from "../../apps/api/src/cursors";
import { createSyntheticSession } from "../../packages/auth/sessions";
import { prepareTemplateDraft } from "../../packages/cms";
import { requireRevisionRecovery } from "../../packages/cms/recovery";
import { requireRevisionHistory } from "../../packages/cms/history";
import { fixtures } from "../../packages/db/fixtures";
import { withTenantTransaction } from "../../packages/db/tenant-transaction";
import { assertContract, assertProblem, type Schemas } from "../helpers/api";
import { cmsTestOrigin, cmsTestPolicy, createIsolatedCms, testProfilePort } from "./isolated";
import { MockStorageProvider } from "../../packages/providers/storage/mock";

let environment: Awaited<ReturnType<typeof createIsolatedCms>>;
type Session = { token: string; csrfToken: string; org: string; user: string };
let owner: Session;
let otherOwner: Session;
let editor: Session;
let profileA: string;
let profileB: string;
const editorRole = randomUUID();
const grants = ["sites.read", "sites.write", "content.read", "content.write", "content.publish"].map((code) => ({
  code,
  scope: "organization",
}));
const base = (session = owner) => `/v1/orgs/${session.org}`;
const draftPath = (id: string, session = owner) => `/dev/orgs/${session.org}/cms/documents/${id}/drafts`;
const recoveryPath = (documentId: string, revisionId: string, session = owner) =>
  `/dev/orgs/${session.org}/cms/documents/${documentId}/revisions/${revisionId}/recovery`;
const historyPath = (documentId: string, session = owner) =>
  `/dev/orgs/${session.org}/cms/documents/${documentId}/revision-history`;
const draft = () => prepareTemplateDraft("agent-introduction", "1.0.0", cmsTestPolicy).document;
function request(
  session: Session,
  method: string,
  path: string,
  body?: unknown,
  options: { key?: string; ifMatch?: string; omitKey?: boolean; csrf?: string; origin?: string } = {},
) {
  const headers: Record<string, string> = {
    cookie: `estate_session=${session.token}`,
    origin: options.origin ?? cmsTestOrigin,
    "content-type": "application/json",
  };
  if (method !== "GET") {
    headers["x-csrf-token"] = options.csrf ?? session.csrfToken;
    if (!options.omitKey) headers["idempotency-key"] = options.key ?? randomUUID();
    if (options.ifMatch !== undefined) headers["if-match"] = options.ifMatch;
  }
  return fetch(`${environment.origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function success<T extends keyof Schemas>(response: Response, schema: T, status = 200) {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  assertContract(schema, body);
  return body;
}
async function createPair(session = owner, slug = `home-${randomUUID()}`) {
  const siteBody = {
    name: `Synthetic CMS ${randomUUID()}`,
    businessProfileId: session.org === fixtures.orgA ? profileA : profileB,
    templateCode: "agent-introduction",
  };
  const site = await success(await request(session, "POST", `${base(session)}/sites`, siteBody), "Site", 201);
  const document = await success(
    await request(session, "POST", `${base(session)}/sites/${site.id}/documents`, {
      slug,
      kind: "page",
      title: "Private draft title",
    }),
    "Document",
    201,
  );
  return { site, document, siteBody };
}
async function direct<T>(
  operation: (service: CmsService, client: pg.PoolClient) => Promise<T>,
  session = owner,
) {
  return withTenantTransaction(
    environment.runtime,
    { userId: session.user, organizationId: session.org },
    (client, context) =>
      operation(
        new CmsService(client, context, randomUUID(), {
          profiles: testProfilePort(client, context, environment.deniedProfiles),
          trustedLinkPolicy: cmsTestPolicy,
          storage: new MockStorageProvider(cmsTestOrigin),
        }),
        client,
      ),
  );
}
async function counts(documentId: string) {
  const result = await environment.admin.query(
    "SELECT row_version,published_revision_id,(SELECT count(*)::int FROM app.content_revision WHERE document_id=d.id) AS revisions,(SELECT count(*)::int FROM app.audit_event WHERE resource_id=d.id::text) AS audits,(SELECT count(*)::int FROM app.idempotency_record WHERE route_key LIKE '%'||d.id::text) AS commands FROM app.content_document d WHERE id=$1",
    [documentId],
  );
  return result.rows[0];
}
async function insertRecovery(
  documentId: string,
  data = { schemaVersion: 7, blocks: [] as unknown, seo: {} as unknown },
  id: string = randomUUID(),
  createdAt?: string,
) {
  await environment.admin.query(
    "INSERT INTO app.content_revision(tenant_id,id,document_id,author_member_id,schema_version,block_data,seo,content_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic-recovery',COALESCE($8::timestamptz,now()))",
    [
      fixtures.orgA,
      id,
      documentId,
      fixtures.ownerMemberA,
      data.schemaVersion,
      JSON.stringify(data.blocks),
      JSON.stringify(data.seo),
      createdAt ?? null,
    ],
  );
  return id;
}
async function recovered(response: Response) {
  const body = requireRevisionRecovery(await response.json());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-trace-id")).toBeTruthy();
  expect(response.headers.get("etag")).toBeNull();
  expect(Object.keys(body).sort()).toEqual(["canPublish", "canSave", "data", "documentId", "id", "issues"]);
  return body;
}
async function history(response: Response, documentId: string) {
  const raw = await response.text();
  expect(response.status, raw).toBe(200);
  expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(64 * 1024);
  const body = requireRevisionHistory(JSON.parse(raw), documentId);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-trace-id")).toBeTruthy();
  expect(response.headers.get("etag")).toBeNull();
  return body;
}
async function waitForLock(table: string, minimum = 1) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await environment.admin.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND usename='estate_runtime' AND wait_event_type='Lock' AND query LIKE $2",
      [environment.database, `%${table}%`],
    );
    if (state.rows[0].count >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected the recovery request to wait for its source lock.");
}

beforeAll(async () => {
  environment = await createIsolatedCms();
  for (const org of [fixtures.orgA, fixtures.orgB])
    await environment.admin.query(
      "INSERT INTO app.entitlement(tenant_id,feature,state) VALUES($1,'websites','enabled') ON CONFLICT(tenant_id,feature) DO NOTHING",
      [org],
    );
  await environment.admin.query(
    "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants) VALUES($1,$2,'Synthetic CMS editor',$3)",
    [fixtures.orgA, editorRole, JSON.stringify(grants)],
  );
  await environment.admin.query("UPDATE app.membership SET role_id=$1 WHERE id=$2", [
    editorRole,
    fixtures.agentMemberA,
  ]);
  const profiles = await environment.admin.query(
    "SELECT tenant_id,id FROM app.business_profile ORDER BY tenant_id",
  );
  profileA = profiles.rows.find((row) => row.tenant_id === fixtures.orgA).id;
  profileB = profiles.rows.find((row) => row.tenant_id === fixtures.orgB).id;
  owner = {
    ...(await createSyntheticSession(environment.runtime, fixtures.ownerUser, fixtures.orgA)),
    user: fixtures.ownerUser,
    org: fixtures.orgA,
  };
  otherOwner = {
    ...(await createSyntheticSession(environment.runtime, fixtures.ownerUser, fixtures.orgB)),
    user: fixtures.ownerUser,
    org: fixtures.orgB,
  };
  editor = {
    ...(await createSyntheticSession(environment.runtime, fixtures.agentUser, fixtures.orgA)),
    user: fixtures.agentUser,
    org: fixtures.orgA,
  };
});

afterEach(async () => {
  if (!environment) return;
  environment.deniedProfiles.clear();
  await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
    JSON.stringify(grants),
    editorRole,
  ]);
  await environment.admin.query("UPDATE app.membership SET status='active' WHERE id=$1", [
    fixtures.agentMemberA,
  ]);
  await environment.admin.query(
    "UPDATE app.entitlement SET state='enabled',effective_until=NULL WHERE feature='websites'",
  );
});
afterAll(async () => {
  if (environment) await environment.close();
});

describe("unregistered native CMS API against a disposable real-role database", () => {
  it("uses a nonowner NOBYPASSRLS runtime and creates only private native draft records", async () => {
    const role = await environment.runtime.query(
      "SELECT current_user,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE rolname=current_user",
    );
    expect(role.rows[0]).toEqual({ current_user: "estate_runtime", rolsuper: false, rolbypassrls: false });
    const tables = await environment.admin.query(
      "SELECT c.relname,c.relforcerowsecurity,c.relowner=(SELECT oid FROM pg_roles WHERE rolname='estate_runtime') AS owns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname IN ('site','content_document','content_revision')",
    );
    expect(tables.rows).toHaveLength(3);
    expect(tables.rows.every((row) => row.relforcerowsecurity && !row.owns)).toBe(true);
    const { site, document } = await createPair(editor);
    expect(site).toMatchObject({
      state: "draft",
      publishedAt: null,
      themeVersion: "agent-introduction@1.0.0",
      version: 1,
    });
    expect(document).toMatchObject({ publishedRevisionId: null, version: 1 });
    expect((await counts(document.id)).revisions).toBe(0);
    const templates = await success(await request(editor, "GET", "/v1/templates"), "PageTemplate");
    expect(new Set(templates.items.map((item) => item.family))).toEqual(
      new Set(["agent", "brokerage", "landing"]),
    );
  });

  it("persists one immutable revision, verified author, hash and original document ETag without publication", async () => {
    const { site, document } = await createPair(editor);
    const body = draft();
    const response = await request(editor, "POST", draftPath(document.id, editor), body, { ifMatch: '"1"' });
    const revision = await success(response, "Revision", 201);
    expect(response.headers.get("etag")).toBe('"2"');
    const stored = await environment.admin.query(
      "SELECT author_member_id,block_data,seo,content_hash FROM app.content_revision WHERE id=$1",
      [revision.id],
    );
    expect(stored.rows[0]).toMatchObject({
      author_member_id: fixtures.agentMemberA,
      block_data: body.blocks,
      seo: body.seo,
    });
    expect(stored.rows[0].content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await counts(document.id)).toMatchObject({
      row_version: "2",
      published_revision_id: null,
      revisions: 1,
      commands: 1,
    });
    expect(
      await success(await request(editor, "GET", `${base(editor)}/sites/${site.id}`), "Site"),
    ).toMatchObject({ state: "draft", publishedAt: null });
    const audit = await environment.admin.query(
      "SELECT safe_diff FROM app.audit_event WHERE action='content_revision.saved' AND resource_id=$1",
      [document.id],
    );
    expect(audit.rows).toEqual([{ safe_diff: { resourceVersion: 2 } }]);
    expect(JSON.stringify(audit.rows)).not.toContain(body.blocks[0].props.heading);
    expect(
      await success(await request(editor, "GET", `${base(editor)}/revisions/${revision.id}`), "Revision"),
    ).toEqual(revision);
  });

  it("two concurrent editors receive one successful append and one version conflict", async () => {
    const { document } = await createPair();
    const first = draft();
    const second = draft();
    second.blocks[0].props.heading = "Other editor's unsaved work";
    const responses = await Promise.all([
      request(owner, "POST", draftPath(document.id), first, { ifMatch: '"1"' }),
      request(editor, "POST", draftPath(document.id, editor), second, { ifMatch: '"1"' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 412]);
    const failure = responses.find((response) => response.status === 412)!;
    expect(await assertProblem(failure, 412)).toMatchObject({ code: "revision_changed" });
    expect(await counts(document.id)).toMatchObject({ row_version: "2", revisions: 1, commands: 1 });
    expect(second.blocks[0].props.heading).toBe("Other editor's unsaved work");
  });

  it("returns exact historical body/ETag before evaluating the original now-stale If-Match", async () => {
    const { document } = await createPair();
    const key = randomUUID();
    const body = draft();
    const original = await success(
      await request(owner, "POST", draftPath(document.id), body, { key, ifMatch: '"1"' }),
      "Revision",
      201,
    );
    await success(
      await request(owner, "POST", draftPath(document.id), body, { ifMatch: '"2"' }),
      "Revision",
      201,
    );
    const replayResponse = await request(owner, "POST", draftPath(document.id), body, {
      key,
      ifMatch: '"1"',
    });
    expect(await success(replayResponse, "Revision", 201)).toEqual(original);
    expect(replayResponse.headers.get("etag")).toBe('"2"');
    expect((await counts(document.id)).row_version).toBe("3");
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), body, { key, ifMatch: '"2"' }),
      409,
    );
    const changed = structuredClone(body);
    changed.seo.title = "Changed intent";
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), changed, { key, ifMatch: '"1"' }),
      409,
    );
    expect((await counts(document.id)).revisions).toBe(2);
  });

  it("concurrent exact retries commit only one revision and replay its persisted metadata", async () => {
    const { document } = await createPair();
    const key = randomUUID();
    const body = draft();
    const responses = await Promise.all([
      request(owner, "POST", draftPath(document.id), body, { key, ifMatch: '"1"' }),
      request(owner, "POST", draftPath(document.id), body, { key, ifMatch: '"1"' }),
    ]);
    const results = await Promise.all(responses.map((response) => success(response, "Revision", 201)));
    expect(results[0]).toEqual(results[1]);
    expect(responses.map((response) => response.headers.get("etag"))).toEqual(['"2"', '"2"']);
    expect(await counts(document.id)).toMatchObject({ row_version: "2", revisions: 1, commands: 1 });
  });

  it("metadata edits share the document version and preserve an existing publication pointer", async () => {
    const { site, document } = await createPair();
    const first = await success(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    );
    // Synthetic fixture only: no renderer/host/publication route is activated.
    await environment.admin.query("UPDATE app.site SET state='published',published_at=now() WHERE id=$1", [
      site.id,
    ]);
    await environment.admin.query("UPDATE app.content_document SET published_revision_id=$1 WHERE id=$2", [
      first.id,
      document.id,
    ]);
    const updated = await success(
      await request(
        owner,
        "PATCH",
        `${base()}/documents/${document.id}`,
        { slug: "edited", kind: "landing", title: "Edited title" },
        { ifMatch: '"2"' },
      ),
      "Document",
    );
    expect(updated).toMatchObject({ version: 3, publishedRevisionId: first.id });
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"2"' }),
      412,
    );
    await success(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"3"' }),
      "Revision",
      201,
    );
    expect(await counts(document.id)).toMatchObject({
      row_version: "4",
      published_revision_id: first.id,
      revisions: 2,
    });
    expect(await success(await request(owner, "GET", `${base()}/sites/${site.id}`), "Site")).toMatchObject({
      state: "published",
    });
  });

  it("rejects unprotective headers and unsafe/unregistered content before any durable write", async () => {
    const { document } = await createPair();
    const before = await counts(document.id);
    await assertProblem(await request(owner, "POST", draftPath(document.id), draft()), 400);
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: 'W/"1"' }),
      400,
    );
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"', omitKey: true }),
      400,
    );
    const unregistered = draft();
    unregistered.blocks.push({ id: randomUUID(), type: "listing_grid", props: {} });
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), unregistered, { ifMatch: '"1"' }),
      422,
    );
    const unsafe = draft();
    unsafe.blocks[0].props.action = { label: "Secret unsafe value", href: "javascript:alert(1)" };
    const error = await assertProblem(
      await request(owner, "POST", draftPath(document.id), unsafe, { ifMatch: '"1"' }),
      422,
    );
    expect(JSON.stringify(error)).not.toContain("Secret unsafe value");
    expect(await counts(document.id)).toEqual(before);
  });

  it("enforces session, CSRF, origin, selected organization and frozen saveRevision route", async () => {
    const { document } = await createPair();
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"', csrf: "incorrect" }),
      403,
    );
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), draft(), {
        ifMatch: '"1"',
        origin: "https://unapproved.example.test",
      }),
      403,
    );
    await assertProblem(await request(owner, "GET", `${base(otherOwner)}/sites`), 403);
    await assertProblem(await fetch(`${environment.origin}${base()}/sites`), 401);
    // saveRevision POST (/documents/{id}/revisions) remains frozen
    await assertProblem(
      await request(owner, "POST", `${base()}/documents/${document.id}/revisions`, draft(), {
        ifMatch: '"1"',
      }),
      404,
    );
    expect((await counts(document.id)).revisions).toBe(0);
  });

  it("isolates foreign site/document/revision/profile IDs under real RLS", async () => {
    const { site, document } = await createPair(otherOwner);
    const revision = await success(
      await request(otherOwner, "POST", draftPath(document.id, otherOwner), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    );
    for (const path of [
      `${base()}/sites/${site.id}`,
      `${base()}/documents/${document.id}`,
      `${base()}/revisions/${revision.id}`,
    ])
      await assertProblem(await request(owner, "GET", path), 404);
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"' }),
      404,
    );
    await assertProblem(
      await request(owner, "POST", `${base()}/sites`, {
        name: "Foreign reference",
        businessProfileId: profileB,
        templateCode: "agent-introduction",
      }),
      404,
    );
    const directRows = await direct(async (_service, client) =>
      client.query("SELECT id FROM app.content_revision WHERE id=$1", [revision.id]),
    );
    expect(directRows.rowCount).toBe(0);
    const pool = new pg.Pool({ connectionString: environment.runtimeUrl, max: 1 });
    try {
      await withTenantTransaction(
        pool,
        { userId: fixtures.ownerUser, organizationId: fixtures.orgB },
        (client) => client.query("SELECT id FROM app.site"),
      );
      expect((await pool.query("SELECT id FROM app.site")).rowCount).toBe(0);
      await expect(
        pool.query(
          "INSERT INTO app.site(tenant_id,business_profile_id,name,theme_version) VALUES($1,$2,'No context','synthetic')",
          [fixtures.orgA, profileA],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await withTenantTransaction(
        pool,
        { userId: fixtures.ownerUser, organizationId: fixtures.orgA },
        async (client) => {
          expect((await client.query("SELECT id FROM app.site WHERE id=$1", [site.id])).rowCount).toBe(0);
        },
      );
    } finally {
      await pool.end();
    }
  });

  it("denies historical replay after write-grant, membership or capability revocation", async () => {
    const { document } = await createPair(editor);
    const key = randomUUID();
    const body = draft();
    await success(
      await request(editor, "POST", draftPath(document.id, editor), body, { key, ifMatch: '"1"' }),
      "Revision",
      201,
    );
    await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
      JSON.stringify(grants.filter((grant) => grant.code !== "content.write")),
      editorRole,
    ]);
    await assertProblem(
      await request(editor, "POST", draftPath(document.id, editor), body, { key, ifMatch: '"1"' }),
      403,
    );
    await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
      JSON.stringify(grants),
      editorRole,
    ]);
    await environment.admin.query("UPDATE app.membership SET status='disabled' WHERE id=$1", [
      fixtures.agentMemberA,
    ]);
    await assertProblem(
      await request(editor, "POST", draftPath(document.id, editor), body, { key, ifMatch: '"1"' }),
      403,
    );
    await environment.admin.query("UPDATE app.membership SET status='active' WHERE id=$1", [
      fixtures.agentMemberA,
    ]);
    await environment.admin.query(
      "UPDATE app.entitlement SET effective_until=now()-interval '1 minute' WHERE tenant_id=$1 AND feature='websites'",
      [fixtures.orgA],
    );
    await assertProblem(
      await request(editor, "POST", draftPath(document.id, editor), body, { key, ifMatch: '"1"' }),
      403,
    );
    await assertProblem(await request(editor, "GET", `${base(editor)}/documents/${document.id}`), 403);
    expect((await counts(document.id)).revisions).toBe(1);
  });

  it.each(["own", "team"])(
    "fails closed on a forged %s CMS grant, even inside the correct tenant",
    async (scope) => {
      await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
        JSON.stringify(grants.map((grant) => ({ ...grant, scope }))),
        editorRole,
      ]);
      await assertProblem(await request(editor, "GET", `${base(editor)}/sites`), 403);
      await assertProblem(
        await request(editor, "POST", `${base(editor)}/sites`, {
          name: "Forged scope",
          businessProfileId: profileA,
          templateCode: "agent-introduction",
        }),
        403,
      );
    },
  );

  it("rechecks locked site/document and supplied profile eligibility before replay", async () => {
    const { site, document } = await createPair();
    const key = randomUUID();
    const body = draft();
    await success(
      await request(owner, "POST", draftPath(document.id), body, { key, ifMatch: '"1"' }),
      "Revision",
      201,
    );
    environment.deniedProfiles.add(profileA);
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), body, { key, ifMatch: '"1"' }),
      404,
    );
    environment.deniedProfiles.clear();
    await environment.admin.query("UPDATE app.site SET state='suspended' WHERE id=$1", [site.id]);
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), body, { key, ifMatch: '"1"' }),
      404,
    );
    await environment.admin.query("UPDATE app.site SET state='draft' WHERE id=$1", [site.id]);
    await environment.admin.query("UPDATE app.content_document SET archived_at=now() WHERE id=$1", [
      document.id,
    ]);
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), body, { key, ifMatch: '"1"' }),
      404,
    );
    expect((await counts(document.id)).revisions).toBe(1);
  });

  it("same-slug concurrency is unique and create retries return the existing native record", async () => {
    const key = randomUUID();
    const body = {
      name: `Idempotent site ${randomUUID()}`,
      businessProfileId: profileA,
      templateCode: "agent-introduction",
    };
    const first = await success(await request(owner, "POST", `${base()}/sites`, body, { key }), "Site", 201);
    const second = await success(await request(owner, "POST", `${base()}/sites`, body, { key }), "Site", 201);
    expect(second).toEqual(first);
    const docBody = { slug: "unique-path", kind: "page", title: "Concurrent slug" };
    const responses = await Promise.all([
      request(owner, "POST", `${base()}/sites/${first.id}/documents`, docBody),
      request(editor, "POST", `${base(editor)}/sites/${first.id}/documents`, docBody),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const result = await environment.admin.query(
      "SELECT count(*)::int AS count FROM app.content_document WHERE site_id=$1 AND slug='unique-path'",
      [first.id],
    );
    expect(result.rows[0].count).toBe(1);
  });

  it("rolls revision/version/audit/idempotency back with the caller's failed transaction", async () => {
    const { document } = await createPair();
    const before = await counts(document.id);
    await expect(
      direct(async (service) => {
        await service.saveDraft(document.id, draft(), { key: randomUUID(), ifMatch: '"1"' });
        throw new Error("Synthetic caller rollback");
      }),
    ).rejects.toThrow("Synthetic caller rollback");
    expect(await counts(document.id)).toEqual(before);
  });

  it("denies runtime history mutation/publication grants and enforces immutable history for migration identity", async () => {
    const { site, document } = await createPair();
    const revision = await success(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    );
    for (const [sql, values] of [
      ["UPDATE app.content_revision SET seo='{}' WHERE id=$1", [revision.id]],
      ["DELETE FROM app.content_revision WHERE id=$1", [revision.id]],
      ["UPDATE app.content_document SET published_revision_id=$1 WHERE id=$2", [revision.id, document.id]],
      ["UPDATE app.site SET state='published' WHERE id=$1", [site.id]],
    ] as const)
      await expect(direct(async (_service, client) => client.query(sql, [...values]))).rejects.toMatchObject({
        code: "42501",
      });
    await expect(
      environment.admin.query("UPDATE app.content_revision SET seo='{}' WHERE id=$1", [revision.id]),
    ).rejects.toMatchObject({ code: "55000" });
    expect((await counts(document.id)).revisions).toBe(1);
  });

  it("keeps unknown stored JSON recoverable without dropping it or widening frozen v1", async () => {
    const { document } = await createPair();
    const id = randomUUID();
    const unknown = [{ id: randomUUID(), type: "future", props: { original: { opaque: ["<script>", 42] } } }];
    await environment.admin.query(
      "INSERT INTO app.content_revision(tenant_id,id,document_id,author_member_id,schema_version,block_data,seo,content_hash) VALUES($1,$2,$3,$4,7,$5,$6,'synthetic-recovery')",
      [
        fixtures.orgA,
        id,
        document.id,
        fixtures.ownerMemberA,
        JSON.stringify(unknown),
        JSON.stringify(draft().seo),
      ],
    );
    const recovered = await direct((service) => service.getRevisionRecovery(document.id, id));
    expect(recovered).toMatchObject({ id, documentId: document.id, canSave: false, canPublish: false });
    expect(recovered.data).toEqual({ schemaVersion: 7, blocks: unknown, seo: draft().seo });
    expect(JSON.stringify(recovered.issues)).not.toContain("<script>");
    expect(await assertProblem(await request(owner, "GET", `${base()}/revisions/${id}`), 409)).toMatchObject({
      code: "revision_recovery_required",
    });
    const stored = await environment.admin.query("SELECT block_data FROM app.content_revision WHERE id=$1", [
      id,
    ]);
    expect(stored.rows[0].block_data).toEqual(unknown);
    const before = await counts(document.id);
    const response = await request(owner, "GET", recoveryPath(document.id, id));
    const body = requireRevisionRecovery(await response.json());
    expect(response.status).toBe(200);
    expect(body).toEqual(recovered);
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await counts(document.id)).toEqual(before);
  });

  it("recovers registered content read-only while retaining its normal frozen response and version", async () => {
    const { document } = await createPair();
    const revision = await success(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    );
    const before = await counts(document.id);
    const recovery = await recovered(await request(owner, "GET", recoveryPath(document.id, revision.id)));
    expect(recovery).toMatchObject({
      id: revision.id,
      documentId: document.id,
      canSave: false,
      canPublish: false,
      issues: [],
    });
    expect(recovery.data).toEqual({
      schemaVersion: revision.schemaVersion,
      blocks: revision.blocks,
      seo: revision.seo,
    });
    expect(
      await success(await request(owner, "GET", `${base()}/revisions/${revision.id}`), "Revision"),
    ).toEqual(revision);
    expect(await counts(document.id)).toEqual(before);
  });

  it("indexes all mixed native revisions with default 50-row ID pagination and no original data", async () => {
    const { document } = await createPair();
    const supported = await success(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    );
    const ids = [supported.id];
    for (let index = 1; index <= 50; index++) {
      const id = `a3000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
      ids.push(
        await insertRecovery(
          document.id,
          {
            schemaVersion: index % 2 ? 1 : 7,
            blocks: [{ id: randomUUID(), type: "future", props: { private: "Never expose original data" } }],
            seo: index === 50 ? "界".repeat(90_000) : {},
          },
          id,
          new Date(Date.UTC(2026, 9, 10) - index * 1000).toISOString(),
        ),
      );
    }
    const before = await counts(document.id);
    const first = await history(await request(owner, "GET", historyPath(document.id)), document.id);
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const second = await history(
      await request(
        owner,
        "GET",
        `${historyPath(document.id)}?cursor=${encodeURIComponent(first.nextCursor!)}`,
      ),
      document.id,
    );
    expect(second.items).toHaveLength(1);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    const items = [...first.items, ...second.items];
    expect(items.map((item) => item.id)).toEqual(ids.sort());
    for (const item of items)
      expect(Object.keys(item).sort()).toEqual(["createdAt", "documentId", "id", "schemaVersion"]);
    expect(JSON.stringify(first)).not.toContain("Never expose original data");
    const row1 = items.find((item) => item.id.endsWith("000000000001"))!;
    const row2 = items.find((item) => item.id.endsWith("000000000002"))!;
    expect(row1.id < row2.id && row1.createdAt > row2.createdAt).toBe(true);
    expect(
      await history(await request(owner, "GET", `${historyPath(document.id)}?limit=100`), document.id),
    ).toMatchObject({ items, hasMore: false, nextCursor: null });
    await assertProblem(await request(owner, "GET", `${base()}/documents/${document.id}/revisions`), 409);
    await assertProblem(
      await request(owner, "GET", recoveryPath(document.id, ids.find((id) => id.endsWith("000000000050"))!)),
      422,
    );
    expect(await counts(document.id)).toEqual(before);
  });

  it("reads history under real column grants that make original block/SEO reads impossible", async () => {
    const { document } = await createPair();
    const id = await insertRecovery(document.id);
    const before = await counts(document.id);
    await environment.admin.query("REVOKE SELECT ON app.content_revision FROM estate_runtime");
    await environment.admin.query(
      "GRANT SELECT(id,tenant_id,document_id,schema_version,created_at) ON app.content_revision TO estate_runtime",
    );
    try {
      await expect(
        direct((_service, client) =>
          client.query("SELECT block_data,seo FROM app.content_revision WHERE id=$1", [id]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const page = await history(await request(owner, "GET", historyPath(document.id)), document.id);
      expect(page.items.map((item) => item.id)).toEqual([id]);
      expect(await counts(document.id)).toEqual(before);
    } finally {
      await environment.admin.query(
        "REVOKE SELECT(id,tenant_id,document_id,schema_version,created_at) ON app.content_revision FROM estate_runtime",
      );
      await environment.admin.query("GRANT SELECT ON app.content_revision TO estate_runtime");
    }
  });

  it("binds expiring history cursors to the member, current grants, document and distinct resource", async () => {
    const { document } = await createPair(editor);
    const second = await createPair(editor);
    await insertRecovery(document.id);
    await insertRecovery(document.id);
    const first = await history(
      await request(editor, "GET", `${historyPath(document.id, editor)}?limit=1`),
      document.id,
    );
    const cursor = first.nextCursor!;
    for (const [session, path] of [
      [owner, historyPath(document.id)],
      [editor, historyPath(second.document.id, editor)],
      [editor, `${base(editor)}/documents/${document.id}/revisions`],
    ] as const)
      await assertProblem(await request(session, "GET", `${path}?cursor=${encodeURIComponent(cursor)}`), 422);
    const tampered = `${cursor[0] === "a" ? "b" : "a"}${cursor.slice(1)}`;
    await assertProblem(
      await request(
        editor,
        "GET",
        `${historyPath(document.id, editor)}?cursor=${encodeURIComponent(tampered)}`,
      ),
      422,
    );
    const binding = JSON.parse(Buffer.from(cursor.split(".")[0], "base64url").toString("utf8")).binding;
    let expired: string;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 16 * 60 * 1000);
    try {
      expired = encodeCursor(first.items[0].id, binding);
    } finally {
      clock.mockRestore();
    }
    await assertProblem(
      await request(
        editor,
        "GET",
        `${historyPath(document.id, editor)}?cursor=${encodeURIComponent(expired!)}`,
      ),
      422,
    );
    await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
      JSON.stringify(grants.filter((grant) => grant.code !== "content.write")),
      editorRole,
    ]);
    await assertProblem(
      await request(
        editor,
        "GET",
        `${historyPath(document.id, editor)}?cursor=${encodeURIComponent(cursor)}`,
      ),
      422,
    );
  });

  it("defines stable-index insertion behavior without a snapshot or latest-revision inference", async () => {
    const { document } = await createPair();
    const id = (value: string) => `a4000000-0000-4000-8000-${value.padStart(12, "0")}`;
    await insertRecovery(document.id, undefined, id("100"));
    await insertRecovery(document.id, undefined, id("200"));
    const first = await history(
      await request(owner, "GET", `${historyPath(document.id)}?limit=1`),
      document.id,
    );
    expect(first.items.map((item) => item.id)).toEqual([id("100")]);
    await insertRecovery(document.id, undefined, id("50"));
    await insertRecovery(document.id, undefined, id("150"));
    const next = await history(
      await request(
        owner,
        "GET",
        `${historyPath(document.id)}?cursor=${encodeURIComponent(first.nextCursor!)}`,
      ),
      document.id,
    );
    expect(next.items.map((item) => item.id)).toEqual([id("150"), id("200")]);
    expect(next).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("gates history by the exact current tenant/document, private session and synthetic transport", async () => {
    const { document } = await createPair();
    await insertRecovery(document.id);
    expect(await history(await request(owner, "GET", historyPath(document.id)), document.id)).toHaveProperty(
      "items",
    );
    const empty = await createPair();
    expect(
      await history(await request(owner, "GET", historyPath(empty.document.id)), empty.document.id),
    ).toEqual({ items: [], hasMore: false, nextCursor: null });
    await assertProblem(await request(owner, "GET", historyPath(randomUUID())), 404);
    await assertProblem(await request(otherOwner, "GET", historyPath(document.id, otherOwner)), 404);
    await assertProblem(await request(otherOwner, "GET", historyPath(document.id)), 403);
    await assertProblem(await request(owner, "GET", historyPath("invalid")), 422);
    await assertProblem(await fetch(`${environment.origin}${historyPath(document.id)}`), 401);
    await assertProblem(await request(owner, "POST", historyPath(document.id)), 404);
    await assertProblem(await request(owner, "GET", `${historyPath(document.id)}?unexpected=true`), 422);
    await assertProblem(await request(owner, "GET", `${historyPath(document.id)}?__proto__=value`), 422);
    await assertProblem(
      await request(owner, "GET", `${historyPath(document.id)}?__proto__=a&__proto__=b`),
      422,
    );
    await assertProblem(await request(owner, "GET", `${historyPath(document.id)}?limit=1&limit=2`), 422);
    await assertProblem(await request(owner, "GET", `${historyPath(document.id)}?cursor=x&cursor=y`), 422);
    const input = {
      method: "GET",
      url: historyPath(document.id),
      headers: { cookie: `estate_session=${owner.token}` },
      remoteAddress: "203.0.113.8",
    };
    expect((await environment.adapter.handle(input)).status).toBe(403);
    expect(
      (
        await environment.adapter.handle({
          ...input,
          remoteAddress: "127.0.0.1",
          headers: { ...input.headers, "x-forwarded-for": "203.0.113.8" },
        })
      ).status,
    ).toBe(403);
    const previous = process.env.DEV_AUTH_ENABLED;
    try {
      process.env.DEV_AUTH_ENABLED = "false";
      expect((await environment.adapter.handle({ ...input, remoteAddress: "127.0.0.1" })).status).toBe(404);
    } finally {
      if (previous === undefined) delete process.env.DEV_AUTH_ENABLED;
      else process.env.DEV_AUTH_ENABLED = previous;
    }
  });

  it.each(["0", "101", "1.5", "1e2", "01", "true", ""])(
    "rejects noncanonical history limit %s",
    async (limit) => {
      const { document } = await createPair();
      await assertProblem(
        await request(owner, "GET", `${historyPath(document.id)}?limit=${encodeURIComponent(limit)}`),
        422,
      );
    },
  );

  it.each(["own", "team"])("denies history under unsupported %s content scope", async (scope) => {
    const { document } = await createPair(editor);
    await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
      JSON.stringify(grants.map((grant) => (grant.code === "content.read" ? { ...grant, scope } : grant))),
      editorRole,
    ]);
    await assertProblem(await request(editor, "GET", historyPath(document.id, editor)), 403);
  });

  it("keeps recovery unavailable outside explicit synthetic loopback access", async () => {
    const { document } = await createPair();
    const id = await insertRecovery(document.id, {
      schemaVersion: 7,
      blocks: [{ private: "Do not disclose" }],
      seo: {},
    });
    const input = {
      method: "GET",
      url: recoveryPath(document.id, id),
      headers: { cookie: `estate_session=${owner.token}` },
      remoteAddress: "127.0.0.1",
    };
    for (const request of [
      { ...input, remoteAddress: "203.0.113.8" },
      { ...input, headers: { ...input.headers, "x-forwarded-for": "127.0.0.1, 203.0.113.8" } },
    ]) {
      const response = await environment.adapter.handle(request);
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain("Do not disclose");
    }
    const previous = process.env.APP_ENV;
    try {
      process.env.APP_ENV = "production";
      const response = await environment.adapter.handle(input);
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain("Do not disclose");
    } finally {
      if (previous === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previous;
    }
  });

  it("denies wrong-document, foreign-tenant and missing recovery bindings without original JSON", async () => {
    const { document } = await createPair();
    const second = await createPair();
    const id = await insertRecovery(document.id, {
      schemaVersion: 7,
      blocks: [{ private: "Never disclose" }],
      seo: {},
    });
    for (const path of [
      recoveryPath(second.document.id, id),
      recoveryPath(document.id, randomUUID()),
      recoveryPath(randomUUID(), id),
    ]) {
      const body = await assertProblem(await request(owner, "GET", path), 404);
      expect(JSON.stringify(body)).not.toContain("Never disclose");
    }
    await assertProblem(await request(otherOwner, "GET", recoveryPath(document.id, id, otherOwner)), 404);
    await assertProblem(await request(otherOwner, "GET", recoveryPath(document.id, id)), 403);
    await assertProblem(await request(owner, "GET", recoveryPath(document.id, "invalid")), 422);
    await assertProblem(await request(owner, "GET", `${recoveryPath(document.id, id)}?unexpected=true`), 422);
    await assertProblem(await fetch(`${environment.origin}${recoveryPath(document.id, id)}`), 401);
    await assertProblem(await request(owner, "POST", recoveryPath(document.id, id)), 404);
  });

  it.each(["grant", "member", "capability", "site", "document", "profile"])(
    "denies recovery and history after current %s eligibility is revoked",
    async (mode) => {
      const { site, document } = await createPair(editor);
      const id = await insertRecovery(document.id);
      if (mode === "grant")
        await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
          JSON.stringify(grants.filter((grant) => grant.code !== "content.read")),
          editorRole,
        ]);
      if (mode === "member")
        await environment.admin.query("UPDATE app.membership SET status='disabled' WHERE id=$1", [
          fixtures.agentMemberA,
        ]);
      if (mode === "capability")
        await environment.admin.query(
          "UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND feature='websites'",
          [fixtures.orgA],
        );
      if (mode === "site")
        await environment.admin.query("UPDATE app.site SET state='suspended' WHERE id=$1", [site.id]);
      if (mode === "document")
        await environment.admin.query("UPDATE app.content_document SET archived_at=now() WHERE id=$1", [
          document.id,
        ]);
      if (mode === "profile") environment.deniedProfiles.add(profileA);
      const before = await counts(document.id);
      const body = await assertProblem(
        await request(editor, "GET", recoveryPath(document.id, id, editor)),
        ["grant", "member", "capability"].includes(mode) ? 403 : 404,
      );
      expect(body).not.toHaveProperty("data");
      const metadata = await assertProblem(
        await request(editor, "GET", historyPath(document.id, editor)),
        ["grant", "member", "capability"].includes(mode) ? 403 : 404,
      );
      expect(metadata).not.toHaveProperty("items");
      expect(await counts(document.id)).toEqual(before);
    },
  );

  it("refuses excessive original data and diagnostics without truncating stored JSON", async () => {
    const { document } = await createPair();
    let nested: unknown = null;
    for (let index = 0; index < 32; index++) nested = { child: nested };
    const samples = [
      { schemaVersion: 7, blocks: [], seo: "界".repeat(90_000) },
      { schemaVersion: 7, blocks: [], seo: nested },
      { schemaVersion: 7, blocks: Array(20_001).fill(null), seo: {} },
      { schemaVersion: 1, blocks: Array.from({ length: 1000 }, () => ({})), seo: draft().seo },
    ];
    for (const data of samples) {
      const id = await insertRecovery(document.id, data);
      const before = await counts(document.id);
      const body = await assertProblem(await request(owner, "GET", recoveryPath(document.id, id)), 422);
      expect(body).not.toHaveProperty("data");
      const stored = await environment.admin.query(
        "SELECT schema_version,block_data,seo FROM app.content_revision WHERE id=$1",
        [id],
      );
      expect(stored.rows[0]).toEqual({
        schema_version: data.schemaVersion,
        block_data: data.blocks,
        seo: data.seo,
      });
      expect(await counts(document.id)).toEqual(before);
    }
  });

  it.each(["content_document", "site", "business_profile", "membership", "entitlement"])(
    "denies recovery and history when the database clock expires across a blocked %s source",
    async (table) => {
      const { site, document } = await createPair(editor);
      const id = await insertRecovery(document.id);
      const before = await counts(document.id);
      await environment.admin.query(
        "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '2 seconds' WHERE tenant_id=$1 AND feature='websites'",
        [fixtures.orgA],
      );
      const sources: Record<string, [string, string]> = {
        content_document: ["SELECT id FROM app.content_document WHERE id=$1 FOR UPDATE", document.id],
        site: ["SELECT id FROM app.site WHERE id=$1 FOR UPDATE", site.id],
        business_profile: ["SELECT id FROM app.business_profile WHERE id=$1 FOR UPDATE", profileA],
        membership: ["SELECT id FROM app.membership WHERE id=$1 FOR UPDATE", fixtures.agentMemberA],
        entitlement: [
          "SELECT tenant_id FROM app.entitlement WHERE tenant_id=$1 AND feature='websites' FOR UPDATE",
          fixtures.orgA,
        ],
      };
      const blocker = await environment.admin.connect();
      const pending: Promise<Response>[] = [];
      let released = false;
      try {
        await blocker.query("BEGIN");
        await blocker.query(sources[table][0], [sources[table][1]]);
        pending.push(
          request(editor, "GET", recoveryPath(document.id, id, editor)),
          request(editor, "GET", historyPath(document.id, editor)),
        );
        await waitForLock(table, 2);
        const deadline = Date.now() + 5000;
        let expired = false;
        while (!expired && Date.now() < deadline) {
          const result = await environment.admin.query(
            "SELECT clock_timestamp()>=effective_until AS expired FROM app.entitlement WHERE tenant_id=$1 AND feature='websites'",
            [fixtures.orgA],
          );
          expired = result.rows[0].expired;
          if (!expired) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(expired).toBe(true);
        await blocker.query("ROLLBACK");
        released = true;
        for (const response of await Promise.all(pending)) {
          const body = await assertProblem(response, 403);
          expect(body).toMatchObject({ code: "entitlement_disabled" });
          expect(body).not.toHaveProperty("data");
          expect(body).not.toHaveProperty("items");
        }
        expect(await counts(document.id)).toEqual(before);
      } finally {
        if (!released) await blocker.query("ROLLBACK");
        await Promise.allSettled(pending);
        blocker.release();
      }
    },
  );

  it.each(["content_document", "site", "business_profile", "membership", "role_definition", "entitlement"])(
    "rechecks recovery/history %s eligibility after its locked source is changed",
    async (table) => {
      const { site, document } = await createPair(editor);
      const id = await insertRecovery(document.id);
      const sources: Record<string, [string, string]> = {
        content_document: ["SELECT id FROM app.content_document WHERE id=$1 FOR UPDATE", document.id],
        site: ["SELECT id FROM app.site WHERE id=$1 FOR UPDATE", site.id],
        business_profile: ["SELECT id FROM app.business_profile WHERE id=$1 FOR UPDATE", profileA],
        membership: ["SELECT id FROM app.membership WHERE id=$1 FOR UPDATE", fixtures.agentMemberA],
        role_definition: ["SELECT id FROM app.role_definition WHERE id=$1 FOR UPDATE", editorRole],
        entitlement: [
          "SELECT tenant_id FROM app.entitlement WHERE tenant_id=$1 AND feature='websites' FOR UPDATE",
          fixtures.orgA,
        ],
      };
      const blocker = await environment.admin.connect();
      const pending: Promise<Response>[] = [];
      let released = false;
      try {
        await blocker.query("BEGIN");
        await blocker.query(sources[table][0], [sources[table][1]]);
        pending.push(
          request(editor, "GET", recoveryPath(document.id, id, editor)),
          request(editor, "GET", historyPath(document.id, editor)),
        );
        await waitForLock(table, 2);
        if (table === "content_document")
          await blocker.query("UPDATE app.content_document SET archived_at=now() WHERE id=$1", [document.id]);
        if (table === "site")
          await blocker.query("UPDATE app.site SET state='suspended' WHERE id=$1", [site.id]);
        if (table === "business_profile") environment.deniedProfiles.add(profileA);
        if (table === "membership")
          await blocker.query("UPDATE app.membership SET status='disabled' WHERE id=$1", [
            fixtures.agentMemberA,
          ]);
        if (table === "role_definition")
          await blocker.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
            JSON.stringify(grants.filter((grant) => grant.code !== "content.read")),
            editorRole,
          ]);
        if (table === "entitlement")
          await blocker.query(
            "UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND feature='websites'",
            [fixtures.orgA],
          );
        await blocker.query("COMMIT");
        released = true;
        for (const response of await Promise.all(pending)) {
          const body = await assertProblem(
            response,
            ["content_document", "site", "business_profile"].includes(table) ? 404 : 403,
          );
          expect(body).not.toHaveProperty("data");
          expect(body).not.toHaveProperty("items");
        }
        expect((await counts(document.id)).revisions).toBe(1);
      } finally {
        if (!released) await blocker.query("ROLLBACK");
        await Promise.allSettled(pending);
        blocker.release();
      }
    },
  );

  it("uses signed resource-bound pagination and explicit revision IDs rather than a latest-draft inference", async () => {
    const { site, document } = await createPair();
    await success(
      await request(owner, "POST", `${base()}/sites/${site.id}/documents`, {
        slug: "second-page",
        kind: "blog",
        title: "Second page",
      }),
      "Document",
      201,
    );
    const path = `${base()}/sites/${site.id}/documents`;
    const page = await success(await request(owner, "GET", `${path}?limit=1`), "PageDocument");
    expect(page.hasMore).toBe(true);
    const next = await success(
      await request(owner, "GET", `${path}?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`),
      "PageDocument",
    );
    expect(next.items[0].id).not.toBe(page.items[0].id);
    await assertProblem(
      await request(
        owner,
        "GET",
        `${base()}/documents/${document.id}/revisions?cursor=${encodeURIComponent(page.nextCursor!)}`,
      ),
      422,
    );
    await assertProblem(
      await request(editor, "GET", `${path}?cursor=${encodeURIComponent(page.nextCursor!)}`),
      422,
    );
    await assertProblem(await request(owner, "GET", `${path}?limit=1&limit=2`), 422);
    await assertProblem(await request(owner, "GET", `${path}?unexpected=value`), 422);
    const first = await success(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    );
    const changed = draft();
    changed.seo.title = "Explicitly selected later revision";
    await success(
      await request(owner, "POST", draftPath(document.id), changed, { ifMatch: '"2"' }),
      "Revision",
      201,
    );
    const revisions = await success(
      await request(owner, "GET", `${base()}/documents/${document.id}/revisions`),
      "PageRevision",
    );
    expect(revisions.items).toHaveLength(2);
    expect(await success(await request(owner, "GET", `${base()}/revisions/${first.id}`), "Revision")).toEqual(
      first,
    );
  });

  it.each(["read", "save", "replay", "advisory"])(
    "denies %s after the websites clock expires while a source or advisory lock blocks",
    async (mode) => {
      const { document } = await createPair(editor);
      const key = randomUUID();
      const body = draft();
      if (mode === "replay")
        await success(
          await request(editor, "POST", draftPath(document.id, editor), body, { key, ifMatch: '"1"' }),
          "Revision",
          201,
        );
      const before = await counts(document.id);
      const blocker = await environment.admin.connect();
      let pending: Promise<Response> | undefined;
      let released = false;
      try {
        await blocker.query("BEGIN");
        if (mode === "advisory") {
          await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `${fixtures.orgA}:${fixtures.agentUser}:cms:cms:save-draft:${document.id}:${key}`,
          ]);
        } else {
          await blocker.query("SELECT id FROM app.content_document WHERE id=$1 FOR UPDATE", [document.id]);
        }
        await environment.admin.query(
          "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '1 second' WHERE tenant_id=$1 AND feature='websites'",
          [fixtures.orgA],
        );
        pending =
          mode === "read"
            ? request(editor, "GET", `${base(editor)}/documents/${document.id}`)
            : request(editor, "POST", draftPath(document.id, editor), body, { key, ifMatch: '"1"' });
        let blocked = false;
        const deadline = Date.now() + 3000;
        while (!blocked && Date.now() < deadline) {
          const state = await environment.admin.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND usename='estate_runtime' AND wait_event_type='Lock' AND query LIKE $2",
            [environment.database, mode === "advisory" ? "%pg_advisory_xact_lock%" : "%content_document%"],
          );
          blocked = state.rows[0].count > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
        let expired = false;
        while (!expired && Date.now() < deadline) {
          const time = await environment.admin.query(
            "SELECT clock_timestamp()>=effective_until AS expired FROM app.entitlement WHERE tenant_id=$1 AND feature='websites'",
            [fixtures.orgA],
          );
          expired = time.rows[0].expired;
          if (!expired) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(expired).toBe(true);
        await blocker.query("ROLLBACK");
        released = true;
        expect(await assertProblem(await pending, 403)).toMatchObject({ code: "entitlement_disabled" });
        expect(await counts(document.id)).toEqual(before);
      } finally {
        if (!released) await blocker.query("ROLLBACK");
        if (pending) await pending;
        blocker.release();
      }
    },
  );

  it("an expired historical key cannot append a second revision with a stale precondition", async () => {
    const { document } = await createPair();
    const key = randomUUID();
    const body = draft();
    await success(
      await request(owner, "POST", draftPath(document.id), body, { key, ifMatch: '"1"' }),
      "Revision",
      201,
    );
    await environment.admin.query(
      "UPDATE app.idempotency_record SET expires_at=now()-interval '1 minute' WHERE key=$1",
      [key],
    );
    await assertProblem(
      await request(owner, "POST", draftPath(document.id), body, { key, ifMatch: '"1"' }),
      412,
    );
    expect(await counts(document.id)).toMatchObject({ row_version: "2", revisions: 1, commands: 1 });
  });

  it("checks the supplied profile resolver's organization binding", async () => {
    await expect(
      withTenantTransaction(
        environment.runtime,
        { userId: fixtures.ownerUser, organizationId: fixtures.orgA },
        (client, context) => {
          const service = new CmsService(client, context, randomUUID(), {
            profiles: {
              async requireActiveReference(id) {
                return { id, organizationId: fixtures.orgB };
              },
            },
            trustedLinkPolicy: cmsTestPolicy,
            storage: new MockStorageProvider(cmsTestOrigin),
          });
          return service.createSite(
            { name: "Wrong port binding", businessProfileId: profileA, templateCode: "agent-introduction" },
            { key: randomUUID() },
          );
        },
      ),
    ).rejects.toMatchObject({ status: 404, code: "resource_unavailable" });
  });

  it("a database audit failure rolls back the earlier version update and revision insert", async () => {
    const { document } = await createPair();
    const before = await counts(document.id);
    await environment.admin.query(`CREATE FUNCTION public.cms_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('cms.test_fail_audit',true)='true' AND NEW.action='content_revision.saved' THEN
          RAISE EXCEPTION 'Synthetic audit failure';
        END IF;
        RETURN NEW;
      END;
    $$;
    CREATE TRIGGER cms_test_audit_failure BEFORE INSERT ON app.audit_event FOR EACH ROW EXECUTE FUNCTION public.cms_test_reject_audit();`);
    try {
      await expect(
        direct(async (service, client) => {
          await client.query("SELECT set_config('cms.test_fail_audit','true',true)");
          return service.saveDraft(document.id, draft(), { key: randomUUID(), ifMatch: '"1"' });
        }),
      ).rejects.toMatchObject({ code: "P0001" });
      expect(await counts(document.id)).toEqual(before);
    } finally {
      await environment.admin.query("DROP TRIGGER cms_test_audit_failure ON app.audit_event");
      await environment.admin.query("DROP FUNCTION public.cms_test_reject_audit()");
    }
  });

  it("holds capability eligibility until the caller commits and then denies historical replay after revocation", async () => {
    const { document } = await createPair(editor);
    const key = randomUUID();
    const body = draft();
    let saved!: () => void;
    let releaseCommit!: () => void;
    const ready = new Promise<void>((resolve) => {
      saved = resolve;
    });
    const commit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const operation = direct(async (service) => {
      const result = await service.saveDraft(document.id, body, { key, ifMatch: '"1"' });
      saved();
      await commit;
      return result;
    }, editor);
    const revoker = await environment.admin.connect();
    let revocation: Promise<pg.QueryResult> | undefined;
    try {
      await Promise.race([ready, operation]);
      const pid = (await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      revocation = revoker.query(
        "UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND feature='websites'",
        [fixtures.orgA],
      );
      let blocked = false;
      const deadline = Date.now() + 3000;
      while (!blocked && Date.now() < deadline) {
        const state = await environment.admin.query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
          [pid],
        );
        blocked = state.rows[0]?.wait_event_type === "Lock";
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      releaseCommit();
      expect((await operation).etag).toBe('"2"');
      await revocation;
      await assertProblem(
        await request(editor, "POST", draftPath(document.id, editor), body, { key, ifMatch: '"1"' }),
        403,
      );
      expect((await counts(document.id)).revisions).toBe(1);
    } finally {
      releaseCommit();
      await Promise.allSettled([operation, ...(revocation ? [revocation] : [])]);
      revoker.release();
    }
  });
});

describe("ADR-053: domain, media and form management", () => {
  it("lists an empty domain set for a new site", async () => {
    const { site } = await createPair();
    const res = await request(owner, "GET", `${base()}/sites/${site.id}/domains`);
    const body = await success(res, "PageDomain");
    expect((body as { items: unknown[] }).items).toHaveLength(0);
  });

  it("creates a domain and returns it with requiredDns pending TXT record", async () => {
    const { site } = await createPair();
    const hostname = `test-${randomUUID()}.example.invalid`;
    const res = await request(owner, "POST", `${base()}/sites/${site.id}/domains`, {
      hostname,
      environment: "preview",
    });
    const body = (await success(res, "Domain", 201)) as Schemas["Domain"];
    expect(body.hostname).toBe(hostname);
    expect(body.verificationState).toBe("pending");
    expect(body.tlsState).toBe("pending");
    expect(body.requiredDns).toHaveLength(1);
    expect(body.requiredDns[0].type).toBe("TXT");
  });

  it("idempotently returns the same domain on repeated create with same key", async () => {
    const { site } = await createPair();
    const hostname = `idem-${randomUUID()}.example.invalid`;
    const key = randomUUID();
    const body1 = (await success(
      await request(owner, "POST", `${base()}/sites/${site.id}/domains`, { hostname, environment: "preview" }, { key }),
      "Domain",
      201,
    )) as Schemas["Domain"];
    const body2 = (await success(
      await request(owner, "POST", `${base()}/sites/${site.id}/domains`, { hostname, environment: "preview" }, { key }),
      "Domain",
      200,
    )) as Schemas["Domain"];
    expect(body1.id).toBe(body2.id);
  });

  it("rejects a duplicate hostname from another site", async () => {
    const { site: siteA } = await createPair();
    const { site: siteB } = await createPair();
    const hostname = `conflict-${randomUUID()}.example.invalid`;
    await success(
      await request(owner, "POST", `${base()}/sites/${siteA.id}/domains`, { hostname, environment: "preview" }),
      "Domain",
      201,
    );
    await assertProblem(
      await request(owner, "POST", `${base()}/sites/${siteB.id}/domains`, { hostname, environment: "production" }),
      409,
    );
  });

  it("verifies a domain transitioning it to verified+active", async () => {
    const { site } = await createPair();
    const hostname = `verify-${randomUUID()}.example.invalid`;
    const created = (await success(
      await request(owner, "POST", `${base()}/sites/${site.id}/domains`, { hostname, environment: "preview" }),
      "Domain",
      201,
    )) as Schemas["Domain"];
    const verified = (await success(
      await request(owner, "POST", `${base()}/domains/${created.id}/verify`),
      "Domain",
    )) as Schemas["Domain"];
    expect(verified.verificationState).toBe("verified");
    expect(verified.tlsState).toBe("active");
    expect(verified.requiredDns).toHaveLength(0);
  });

  it("archives a domain and returns 202 Job", async () => {
    const { site } = await createPair();
    const hostname = `archive-${randomUUID()}.example.invalid`;
    const created = (await success(
      await request(owner, "POST", `${base()}/sites/${site.id}/domains`, { hostname, environment: "preview" }),
      "Domain",
      201,
    )) as Schemas["Domain"];
    const job = (await success(
      await request(owner, "POST", `${base()}/domains/${created.id}/archive`),
      "Job",
      202,
    )) as Schemas["Job"];
    expect(job.state).toBe("succeeded");
    // Archived domain no longer appears in list
    const list = (await success(
      await request(owner, "GET", `${base()}/sites/${site.id}/domains`),
      "PageDomain",
    )) as { items: Schemas["Domain"][] };
    expect(list.items.find((d) => d.id === created.id)).toBeUndefined();
  });

  it("refuses to archive a site with a verified domain", async () => {
    const { site } = await createPair();
    const hostname = `block-${randomUUID()}.example.invalid`;
    const created = (await success(
      await request(owner, "POST", `${base()}/sites/${site.id}/domains`, { hostname, environment: "preview" }),
      "Domain",
      201,
    )) as Schemas["Domain"];
    await success(await request(owner, "POST", `${base()}/domains/${created.id}/verify`), "Domain");
    await assertProblem(await request(owner, "POST", `${base()}/sites/${site.id}/archive`), 409);
  });

  it("archives a site with no verified domains", async () => {
    const { site } = await createPair();
    const job = (await success(
      await request(owner, "POST", `${base()}/sites/${site.id}/archive`),
      "Job",
      202,
    )) as Schemas["Job"];
    expect(job.state).toBe("succeeded");
  });

  it("refuses to archive a site belonging to another tenant", async () => {
    const { site } = await createPair();
    await assertProblem(await request(otherOwner, "POST", `${base(otherOwner)}/sites/${site.id}/archive`), 404);
  });

  it("lists media assets for the tenant", async () => {
    const res = await request(owner, "GET", `${base()}/media`);
    const body = (await success(res, "PageMedia")) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("finalizes a pending media asset", async () => {
    // Insert a pending media_asset directly via admin connection
    const assetId = randomUUID();
    await environment.admin.query(
      "INSERT INTO app.media_asset(tenant_id,id,object_key,mime_type,byte_size,scan_state,rights) VALUES($1,$2,$3,'image/png',1024,'pending','{}'::jsonb)",
      [fixtures.orgA, assetId, `uploads/${assetId}`],
    );
    const res = await request(owner, "POST", `${base()}/media/finalize`, {
      assetId,
      checksum: "sha256-abc123",
      altText: "Test image",
      rightsAttestation: true,
    });
    const body = (await success(res, "Media")) as Schemas["Media"];
    expect(body.id).toBe(assetId);
    expect(body.scanState).toBe("clean");
  });

  it("rejects finalizing a rejected media asset", async () => {
    const assetId = randomUUID();
    await environment.admin.query(
      "INSERT INTO app.media_asset(tenant_id,id,object_key,mime_type,byte_size,scan_state,rights) VALUES($1,$2,$3,'image/png',1024,'rejected','{}'::jsonb)",
      [fixtures.orgA, assetId, `uploads/${assetId}`],
    );
    await assertProblem(
      await request(owner, "POST", `${base()}/media/finalize`, {
        assetId,
        checksum: "sha256-abc123",
        rightsAttestation: true,
      }),
      422,
    );
  });

  it("refuses to finalize a media asset from another tenant", async () => {
    const assetId = randomUUID();
    await environment.admin.query(
      "INSERT INTO app.media_asset(tenant_id,id,object_key,mime_type,byte_size,scan_state,rights) VALUES($1,$2,$3,'image/png',1024,'pending','{}'::jsonb)",
      [fixtures.orgB, assetId, `uploads-b/${assetId}`],
    );
    await assertProblem(
      await request(owner, "POST", `${base()}/media/finalize`, {
        assetId,
        checksum: "sha256-abc123",
        rightsAttestation: true,
      }),
      404,
    );
  });

  it("creates a form for a site", async () => {
    const { site } = await createPair();
    const formBody = {
      name: "Contact Form",
      fields: [{ key: "name", label: "Name", kind: "text", required: true }],
      confirmation: "Thank you for your message.",
      leadSourceId: fixtures.orgA,
      state: "draft",
    };
    const res = await request(owner, "POST", `${base()}/sites/${site.id}/forms`, formBody);
    const body = (await success(res, "Form", 201)) as Schemas["Form"];
    expect(body.name).toBe("Contact Form");
    expect(body.version).toBe(1);
    expect(body.state).toBe("draft");
    expect(body.fields).toHaveLength(1);
  });

  it("lists forms for a site", async () => {
    const { site } = await createPair();
    await success(
      await request(owner, "POST", `${base()}/sites/${site.id}/forms`, {
        name: "Inquiry Form",
        fields: [],
        confirmation: "Got it.",
        leadSourceId: fixtures.orgA,
        state: "draft",
      }),
      "Form",
      201,
    );
    const list = (await success(
      await request(owner, "GET", `${base()}/sites/${site.id}/forms`),
      "PageForm",
    )) as { items: Schemas["Form"][] };
    expect(list.items.length).toBeGreaterThanOrEqual(1);
  });

  it("gets a form by id", async () => {
    const { site } = await createPair();
    const created = (await success(
      await request(owner, "POST", `${base()}/sites/${site.id}/forms`, {
        name: "Get Test Form",
        fields: [],
        confirmation: "Done.",
        leadSourceId: fixtures.orgA,
        state: "draft",
      }),
      "Form",
      201,
    )) as Schemas["Form"];
    const fetched = (await success(
      await request(owner, "GET", `${base()}/forms/${created.id}`),
      "Form",
    )) as Schemas["Form"];
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("Get Test Form");
  });

  it("publishes a new form version", async () => {
    const { site } = await createPair();
    const created = (await success(
      await request(owner, "POST", `${base()}/sites/${site.id}/forms`, {
        name: "Versioned Form",
        fields: [],
        confirmation: "Done.",
        leadSourceId: fixtures.orgA,
        state: "draft",
      }),
      "Form",
      201,
    )) as Schemas["Form"];
    expect(created.version).toBe(1);
    const v2 = (await success(
      await request(owner, "POST", `${base()}/forms/${created.id}/versions`, {
        name: "Versioned Form",
        fields: [{ key: "email", label: "Email", kind: "email", required: true }],
        confirmation: "Thank you.",
        leadSourceId: fixtures.orgA,
        state: "published",
      }),
      "Form",
      201,
    )) as Schemas["Form"];
    expect(v2.version).toBe(2);
    expect(v2.state).toBe("published");
  });

  it("refuses to access another tenant's forms", async () => {
    const { site } = await createPair();
    const form = (await success(
      await request(owner, "POST", `${base()}/sites/${site.id}/forms`, {
        name: "Tenant Isolation Form",
        fields: [],
        confirmation: "Done.",
        leadSourceId: fixtures.orgA,
        state: "draft",
      }),
      "Form",
      201,
    )) as Schemas["Form"];
    await assertProblem(await request(otherOwner, "GET", `${base(otherOwner)}/forms/${form.id}`), 404);
  });

  // ── Publication (ADR-055 / MOD-C-003) ──────────────────────────────────────

  it("publishes a revision, updating the document pointer idempotently", async () => {
    const { document } = await createPair();
    const revision = (await success(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    )) as Schemas["Revision"];

    const key = randomUUID();
    const publishBody = { revisionId: revision.id, expectedDocumentVersion: 2 };

    const res1 = await request(owner, "POST", `${base()}/documents/${document.id}/publish`, publishBody, { key });
    const job1 = (await success(res1, "Job", 202)) as Schemas["Job"];
    expect(job1.state).toBe("succeeded");
    expect(job1.kind).toBe("document.published");
    expect(res1.headers.get("etag")).toBe('"3"');

    // Idempotent replay returns the same job body
    const res2 = await request(owner, "POST", `${base()}/documents/${document.id}/publish`, publishBody, { key });
    const job2 = (await success(res2, "Job", 202)) as Schemas["Job"];
    expect(job2.id).toBe(job1.id);

    // Document pointer is set
    const doc = (await success(await request(owner, "GET", `${base()}/documents/${document.id}`), "Document")) as Schemas["Document"];
    expect(doc.publishedRevisionId).toBe(revision.id);
    expect(doc.version).toBe(3);
  });

  it("returns 412 when expectedDocumentVersion mismatches the current version", async () => {
    const { document } = await createPair();
    const revision = (await success(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    )) as Schemas["Revision"];

    await assertProblem(
      await request(owner, "POST", `${base()}/documents/${document.id}/publish`, {
        revisionId: revision.id,
        expectedDocumentVersion: 1, // wrong — document is now at version 2
      }),
      412,
    );
  });

  it("returns 404 for a revision that does not belong to the document", async () => {
    const { document } = await createPair();
    const other = await createPair();
    const foreignRevision = (await success(
      await request(owner, "POST", draftPath(other.document.id), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    )) as Schemas["Revision"];

    await assertProblem(
      await request(owner, "POST", `${base()}/documents/${document.id}/publish`, {
        revisionId: foreignRevision.id,
        expectedDocumentVersion: 1,
      }),
      404,
    );
  });

  it("rolls back to a previous revision, updating the document pointer", async () => {
    const { document } = await createPair();
    const rev1 = (await success(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    )) as Schemas["Revision"];
    // Publish rev1
    await success(
      await request(owner, "POST", `${base()}/documents/${document.id}/publish`, {
        revisionId: rev1.id,
        expectedDocumentVersion: 2,
      }),
      "Job",
      202,
    );
    // Save rev2
    const changed = draft();
    changed.seo.title = "Rollback target";
    const rev2 = (await success(
      await request(owner, "POST", draftPath(document.id), changed, { ifMatch: '"3"' }),
      "Revision",
      201,
    )) as Schemas["Revision"];
    // Publish rev2
    await success(
      await request(owner, "POST", `${base()}/documents/${document.id}/publish`, {
        revisionId: rev2.id,
        expectedDocumentVersion: 4,
      }),
      "Job",
      202,
    );
    // Roll back to rev1
    const rollbackKey = randomUUID();
    const res = await request(
      owner,
      "POST",
      `${base()}/documents/${document.id}/rollback`,
      { revisionId: rev1.id, expectedDocumentVersion: 5 },
      { key: rollbackKey },
    );
    const job = (await success(res, "Job", 202)) as Schemas["Job"];
    expect(job.state).toBe("succeeded");
    expect(job.kind).toBe("document.rolledback");
    // Idempotent replay
    const res2 = await request(
      owner,
      "POST",
      `${base()}/documents/${document.id}/rollback`,
      { revisionId: rev1.id, expectedDocumentVersion: 5 },
      { key: rollbackKey },
    );
    const job2 = (await success(res2, "Job", 202)) as Schemas["Job"];
    expect(job2.id).toBe(job.id);

    const doc = (await success(await request(owner, "GET", `${base()}/documents/${document.id}`), "Document")) as Schemas["Document"];
    expect(doc.publishedRevisionId).toBe(rev1.id);
    expect(doc.version).toBe(6);
  });

  it("denies publication without content.publish permission", async () => {
    const { document } = await createPair(editor);
    const revision = (await success(
      await request(editor, "POST", draftPath(document.id, editor), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    )) as Schemas["Revision"];
    // editor role currently has content.publish via grants; temporarily remove it
    await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
      JSON.stringify(grants.filter((g) => g.code !== "content.publish")),
      editorRole,
    ]);
    await assertProblem(
      await request(editor, "POST", `${base(editor)}/documents/${document.id}/publish`, {
        revisionId: revision.id,
        expectedDocumentVersion: 2,
      }),
      403,
    );
  });

  it("isolates publish across tenant boundaries", async () => {
    const { document } = await createPair();
    const revision = (await success(
      await request(owner, "POST", draftPath(document.id), draft(), { ifMatch: '"1"' }),
      "Revision",
      201,
    )) as Schemas["Revision"];
    // otherOwner cannot publish owner's document
    await assertProblem(
      await request(otherOwner, "POST", `${base(otherOwner)}/documents/${document.id}/publish`, {
        revisionId: revision.id,
        expectedDocumentVersion: 2,
      }),
      404,
    );
    await assertProblem(
      await request(otherOwner, "POST", `${base()}/documents/${document.id}/publish`, {
        revisionId: revision.id,
        expectedDocumentVersion: 2,
      }),
      403,
    );
  });
});

describe("ADR-057: document archive and site update", () => {
  it("archives a document idempotently and marks it unavailable", async () => {
    const { document } = await createPair();
    const key = randomUUID();
    const archivePath = `${base()}/documents/${document.id}/archive`;

    const res1 = await request(owner, "POST", archivePath, {}, { key });
    const job1 = (await success(res1, "Job", 202)) as Schemas["Job"];
    expect(job1.state).toBe("succeeded");
    expect(job1.kind).toBe("document.archived");
    expect(res1.headers.get("etag")).toBe('"2"');

    // Idempotent replay
    const res2 = await request(owner, "POST", archivePath, {}, { key });
    const job2 = (await success(res2, "Job", 202)) as Schemas["Job"];
    expect(job2.id).toBe(job1.id);

    // Document no longer visible in list
    const list = (await success(
      await request(owner, "GET", `${base()}/sites/${document.siteId ?? "x"}/documents`),
      "PageDocument",
    )) as Schemas["PageDocument"];
    expect(list.items.find((d) => d.id === document.id)).toBeUndefined();
  });

  it("returns 409 when archiving an already-archived document without idempotency key", async () => {
    const { document } = await createPair();
    // First archive succeeds
    await success(await request(owner, "POST", `${base()}/documents/${document.id}/archive`, {}), "Job", 202);
    // Second archive (different key) returns 409
    await assertProblem(
      await request(owner, "POST", `${base()}/documents/${document.id}/archive`, {}),
      409,
    );
  });

  it("updates a site name and profile idempotently", async () => {
    const { site } = await createPair();
    const profileId = site.businessProfileId;
    const key = randomUUID();
    const newName = `Renamed ${randomUUID()}`;
    const patchBody = { name: newName, businessProfileId: profileId, templateCode: "agent-introduction" };
    const patchPath = `${base()}/sites/${site.id}`;

    const res1 = await request(owner, "PATCH", patchPath, patchBody, { key, ifMatch: '"1"' });
    const updated1 = (await success(res1, "Site", 200)) as Schemas["Site"];
    expect(updated1.name).toBe(newName);
    expect(res1.headers.get("etag")).toBe('"2"');

    // Idempotent replay
    const res2 = await request(owner, "PATCH", patchPath, patchBody, { key, ifMatch: '"1"' });
    const updated2 = (await success(res2, "Site", 200)) as Schemas["Site"];
    expect(updated2.id).toBe(updated1.id);
  });

  it("returns 412 when site version mismatches on update", async () => {
    const { site } = await createPair();
    const patchBody = {
      name: `Renamed ${randomUUID()}`,
      businessProfileId: site.businessProfileId,
      templateCode: "agent-introduction",
    };
    await assertProblem(
      await request(owner, "PATCH", `${base()}/sites/${site.id}`, patchBody, { ifMatch: '"99"' }),
      412,
    );
  });

  it("denies archiveDocument without content.write permission", async () => {
    const { document } = await createPair(editor);
    // editor role lacks content.write when grants are cleared to read-only
    const readOnly = [
      { code: "sites.read", scope: "org" },
      { code: "content.read", scope: "org" },
    ];
    await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
      JSON.stringify(readOnly),
      editorRole,
    ]);
    try {
      await assertProblem(
        await request(editor, "POST", `${base(editor)}/documents/${document.id}/archive`, {}),
        403,
      );
    } finally {
      await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
        JSON.stringify(grants),
        editorRole,
      ]);
    }
  });

  it("isolates archiveDocument across tenant boundaries", async () => {
    const { document } = await createPair();
    await assertProblem(
      await request(otherOwner, "POST", `${base(otherOwner)}/documents/${document.id}/archive`, {}),
      404,
    );
  });
});

describe("ADR-058: media upload grant", () => {
  const uploadBody = () => ({
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    bytes: 1024,
    purpose: "media" as const,
  });

  it("creates an upload grant and returns 201 UploadGrant", async () => {
    const grant = await success(
      await request(owner, "POST", `${base()}/uploads`, uploadBody()),
      "UploadGrant",
      201,
    );
    expect(grant.method).toBe("PUT");
    expect(grant.url).toMatch(/\/dev\/uploads\//);
    expect(grant.assetId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof grant.expiresAt).toBe("string");
    expect(grant.requiredHeaders["Content-Type"]).toBe("image/jpeg");
  });

  it("replays the same grant for the same idempotency key", async () => {
    const key = randomUUID();
    const first = await success(
      await request(owner, "POST", `${base()}/uploads`, uploadBody(), { key }),
      "UploadGrant",
      201,
    );
    const second = await success(
      await request(owner, "POST", `${base()}/uploads`, uploadBody(), { key }),
      "UploadGrant",
      201,
    );
    expect(second.assetId).toBe(first.assetId);
    expect(second.url).toBe(first.url);
  });

  it("returns distinct grants for distinct idempotency keys", async () => {
    const first = await success(
      await request(owner, "POST", `${base()}/uploads`, uploadBody()),
      "UploadGrant",
      201,
    );
    const second = await success(
      await request(owner, "POST", `${base()}/uploads`, uploadBody()),
      "UploadGrant",
      201,
    );
    expect(second.assetId).not.toBe(first.assetId);
  });

  it("returns 403 when media.write permission is absent", async () => {
    const readOnly = grants.filter((g) => g.code !== "media.write");
    await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
      JSON.stringify(readOnly),
      editorRole,
    ]);
    try {
      await assertProblem(
        await request(editor, "POST", `${base(editor)}/uploads`, uploadBody()),
        403,
      );
    } finally {
      await environment.admin.query("UPDATE app.role_definition SET permission_grants=$1 WHERE id=$2", [
        JSON.stringify(grants),
        editorRole,
      ]);
    }
  });

  it("isolates upload grants across tenant boundaries by using distinct org prefixes", async () => {
    const grant = await success(
      await request(owner, "POST", `${base()}/uploads`, uploadBody()),
      "UploadGrant",
      201,
    );
    const otherGrant = await success(
      await request(otherOwner, "POST", `${base(otherOwner)}/uploads`, uploadBody()),
      "UploadGrant",
      201,
    );
    expect(otherGrant.assetId).not.toBe(grant.assetId);
  });
});
