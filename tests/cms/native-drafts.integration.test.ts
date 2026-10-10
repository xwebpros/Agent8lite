import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CmsService } from "../../apps/api/src/cms";
import { createSyntheticSession } from "../../packages/auth/sessions";
import { prepareTemplateDraft } from "../../packages/cms";
import { fixtures } from "../../packages/db/fixtures";
import { withTenantTransaction } from "../../packages/db/tenant-transaction";
import { assertContract, assertProblem, type Schemas } from "../helpers/api";
import { cmsTestOrigin, cmsTestPolicy, createIsolatedCms, testProfilePort } from "./isolated";

let environment: Awaited<ReturnType<typeof createIsolatedCms>>;
type Session = { token: string; csrfToken: string; org: string; user: string };
let owner: Session;
let otherOwner: Session;
let editor: Session;
let profileA: string;
let profileB: string;
const editorRole = randomUUID();
const grants = ["sites.read", "sites.write", "content.read", "content.write"].map((code) => ({
  code,
  scope: "organization",
}));
const base = (session = owner) => `/v1/orgs/${session.org}`;
const draftPath = (id: string, session = owner) => `/dev/orgs/${session.org}/cms/documents/${id}/drafts`;
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

  it("enforces session, CSRF, origin, selected organization and unavailable publication/frozen save routes", async () => {
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
    await assertProblem(
      await request(owner, "POST", `${base()}/documents/${document.id}/revisions`, draft(), {
        ifMatch: '"1"',
      }),
      404,
    );
    await assertProblem(
      await request(owner, "POST", `${base()}/documents/${document.id}/publish`, {
        revisionId: randomUUID(),
        expectedDocumentVersion: 1,
      }),
      404,
    );
    await assertProblem(
      await request(owner, "POST", `${base()}/documents/${document.id}/rollback`, {
        revisionId: randomUUID(),
        expectedDocumentVersion: 1,
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
    const recovered = await direct((service) => service.getRevisionRecovery(id));
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
  });

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
