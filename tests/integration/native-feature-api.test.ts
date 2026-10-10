import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTemplateDraft } from "../../packages/cms";
import { fixtures } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool, createRuntimePool } from "../helpers/database";

// Registered-route acceptance must never mutate or depend on the interactive estate database.
for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"] as const) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Run native feature API acceptance through the disposable isolated batch runner.");
}

const admin = createMigrationPool();
const runtime = createRuntimePool();
let owner: ApiSession;
let agent: ApiSession;
let profileA: string;
let profileB: string;
let template: Schemas["Template"];
const base = (session = owner) => `/v1/orgs/${session.orgId}`;
const listings = (session = owner) => `/dev/orgs/${session.orgId}/mls/listings`;
const drafts = (id: string, session = owner) => `/dev/orgs/${session.orgId}/cms/documents/${id}/drafts`;
const starter = () =>
  prepareTemplateDraft(template.code, template.version, { approvedLinkOrigins: new Set() }).document;

async function success<T extends keyof Schemas>(response: Response, schema: T, status = 200) {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  assertContract(schema, body);
  return { body, etag: response.headers.get("etag") };
}

async function createPair() {
  const site = await success(
    await owner.command(`${base()}/sites`, {
      name: `Synthetic registered CMS ${randomUUID()}`,
      businessProfileId: profileA,
      templateCode: template.code,
    } satisfies Schemas["SiteWrite"]),
    "Site",
    201,
  );
  const document = await success(
    await owner.command(`${base()}/sites/${site.body.id}/documents`, {
      slug: `acceptance-${randomUUID()}`,
      kind: "page",
      title: "Synthetic private draft",
    } satisfies Schemas["DocumentWrite"]),
    "Document",
    201,
  );
  return { site, document };
}

beforeAll(async () => {
  await assertRuntimeRole(runtime);
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
  expect(owner.orgId).toBe(fixtures.orgA);
  const profiles = await admin.query("SELECT tenant_id,id FROM app.business_profile ORDER BY id");
  profileA = profiles.rows.find((row) => row.tenant_id === fixtures.orgA)?.id;
  profileB = profiles.rows.find((row) => row.tenant_id === fixtures.orgB)?.id;
  expect(profileA).toBeTruthy();
  expect(profileB).toBeTruthy();
  // Consume existing seed capabilities; this suite never turns revoked capabilities back on.
  const capabilities = await admin.query(
    "SELECT feature,state FROM app.entitlement WHERE tenant_id=$1 AND feature IN ('mls','websites') ORDER BY feature",
    [fixtures.orgA],
  );
  expect(capabilities.rows).toEqual([
    { feature: "mls", state: "enabled" },
    { feature: "websites", state: "enabled" },
  ]);
  const templates = await owner.read("/v1/templates", "PageTemplate");
  const selected = templates.body.items.find((item) => item.code === "agent-introduction");
  expect(selected).toBeTruthy();
  template = selected!;
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

describe("registered synthetic MLS and CMS application boundaries", () => {
  it("returns frozen synthetic listing pages and freshly authorized details without private metadata", async () => {
    const page = await owner.read(`${listings()}?limit=1`, "PageListing");
    expect(page.body.items).toHaveLength(1);
    const item = page.body.items[0];
    expect(item.synthetic).toBe(true);
    expect(item.attribution.disclaimer).toMatch(/^SYNTHETIC DEMO DATA/);
    expect(item.media).toEqual([]);
    const detail = await owner.read(`${listings()}/${item.id}`, "Listing");
    expect(detail.body).toEqual(item);
    expect(JSON.stringify(detail.body)).not.toMatch(/nativeRights|secret_ref|content_hash|sourceListingKey/);
    expect(page.body.hasMore).toBe(true);
    expect(page.body.nextCursor).toBeTruthy();
    const next = await owner.read(
      `${listings()}?limit=1&cursor=${encodeURIComponent(page.body.nextCursor!)}`,
      "PageListing",
    );
    expect(next.body.items.map((listing) => listing.id)).not.toContain(item.id);
  });

  it("uses root session, current permission, active organization and loopback guards for MLS", async () => {
    await assertProblem(await new ApiSession().request(listings()), 401);
    await assertProblem(await agent.request(listings()), 403);
    await assertProblem(await owner.request(`/dev/orgs/${fixtures.orgB}/mls/listings`), 403);
    await assertProblem(
      await owner.request(listings(), { headers: { "x-forwarded-for": "198.51.100.19" } }),
      403,
    );
    const foreign = await admin.query(
      "SELECT id FROM app.listing WHERE tenant_id=$1 AND synthetic=true ORDER BY id LIMIT 1",
      [fixtures.orgB],
    );
    expect(foreign.rowCount).toBe(1);
    const hidden = await assertProblem(await owner.request(`${listings()}/${foreign.rows[0].id}`), 404);
    const missing = await assertProblem(await owner.request(`${listings()}/${randomUUID()}`), 404);
    expect(hidden.code).toBe(missing.code);
    expect(hidden.title).toBe(missing.title);
  });

  it("rejects malformed and duplicate listing query parameters through the registered parser", async () => {
    for (const suffix of [
      "?limit=1&limit=2",
      "?filter=%7B",
      "?filter=null",
      "?tenantId=forged",
      "?sort=private",
      "?limit=101",
      "?filter=%7B%22priceMin%22%3A%22secret%22%7D",
    ])
      await assertProblem(await owner.request(listings() + suffix), 422);
  });

  it("does not register public/live MLS, inquiries, organizer or publishing commands", async () => {
    for (const path of [
      `/v1/public/sites/${randomUUID()}/listings`,
      `/dev/orgs/${owner.orgId}/mls/live/listings`,
      `/dev/orgs/${owner.orgId}/mls/favorites`,
    ])
      await assertProblem(await owner.request(path), 404);
    await assertProblem(await owner.command(`${listings()}/${randomUUID()}/inquiries`, {}), 404);
    const { document } = await createPair();
    for (const path of [
      `${base()}/documents/${document.body.id}/revisions`,
      `${base()}/documents/${document.body.id}/publish`,
      `${base()}/documents/${document.body.id}/rollback`,
    ])
      await assertProblem(await owner.command(path, starter(), { revision: '"1"' }), 404);
  });

  it("creates a profile-bound site and a private document without saving or publishing implicitly", async () => {
    const { site, document } = await createPair();
    expect(site.body).toMatchObject({
      businessProfileId: profileA,
      state: "draft",
      publishedAt: null,
      themeVersion: `${template.code}@${template.version}`,
      version: 1,
    });
    expect(document.body).toMatchObject({ publishedRevisionId: null, version: 1 });
    expect(document.etag).toBe('"1"');
    expect((await owner.read(`${base()}/sites/${site.body.id}`, "Site")).body).toEqual(site.body);
    expect(
      (await owner.read(`${base()}/documents/${document.body.id}/revisions`, "PageRevision")).body.items,
    ).toEqual([]);
  });

  it("requires revision protection, CSRF, origin and an idempotency key before a draft is persisted", async () => {
    const { document } = await createPair();
    const path = drafts(document.body.id);
    expect(await assertProblem(await owner.command(path, starter()), 400)).toMatchObject({
      code: "revision_required",
    });
    expect(
      await assertProblem(await owner.command(path, starter(), { revision: 'W/"1"' }), 400),
    ).toMatchObject({
      code: "revision_invalid",
    });
    await assertProblem(await owner.command(path, starter(), { revision: '"1"', csrf: "forged" }), 403);
    await assertProblem(
      await owner.request(path, {
        method: "POST",
        headers: {
          origin: "https://unapproved.example",
          "x-csrf-token": owner.csrf,
          "idempotency-key": randomUUID(),
          "if-match": '"1"',
        },
        body: JSON.stringify(starter()),
      }),
      403,
    );
    await assertProblem(
      await owner.request(path, {
        method: "POST",
        headers: { "x-csrf-token": owner.csrf, "if-match": '"1"' },
        body: JSON.stringify(starter()),
      }),
      400,
    );
    expect((await owner.read(`${base()}/documents/${document.body.id}`, "Document")).body.version).toBe(1);
    expect(
      (await owner.read(`${base()}/documents/${document.body.id}/revisions`, "PageRevision")).body.items,
    ).toEqual([]);
  });

  it("replays the historical draft body and ETag after a later save without duplicating or publishing", async () => {
    const { site, document } = await createPair();
    const path = drafts(document.body.id);
    const firstBody = starter();
    const key = randomUUID();
    const first = await success(
      await owner.command(path, firstBody, { key, revision: '"1"' }),
      "Revision",
      201,
    );
    expect(first.etag).toBe('"2"');
    const secondBody = starter();
    secondBody.seo.title = "A later synthetic draft";
    const second = await success(await owner.command(path, secondBody, { revision: '"2"' }), "Revision", 201);
    expect(second.etag).toBe('"3"');
    expect(second.body.id).not.toBe(first.body.id);
    const replay = await success(
      await owner.command(path, firstBody, { key, revision: '"1"' }),
      "Revision",
      201,
    );
    expect(replay).toEqual(first);
    await assertProblem(await owner.command(path, firstBody, { revision: '"1"' }), 412);
    await assertProblem(await owner.command(path, secondBody, { key, revision: '"1"' }), 409);
    const revisions = (await owner.read(`${base()}/documents/${document.body.id}/revisions`, "PageRevision"))
      .body.items;
    expect(revisions.map((revision) => revision.id).sort()).toEqual([first.body.id, second.body.id].sort());
    expect((await owner.read(`${base()}/revisions/${first.body.id}`, "Revision")).body).toEqual(first.body);
    expect((await owner.read(`${base()}/documents/${document.body.id}`, "Document")).body).toMatchObject({
      version: 3,
      publishedRevisionId: null,
    });
    expect((await owner.read(`${base()}/sites/${site.body.id}`, "Site")).body).toMatchObject({
      state: "draft",
      publishedAt: null,
    });
    const durable = await admin.query(
      "SELECT author_member_id,(SELECT count(*)::int FROM app.audit_event WHERE resource_id=$2 AND action='content_revision.saved') AS audit_count FROM app.content_revision WHERE tenant_id=$1 AND document_id=$2::uuid ORDER BY id",
      [owner.orgId, document.body.id],
    );
    expect(durable.rows).toEqual([
      { author_member_id: owner.memberId, audit_count: 2 },
      { author_member_id: owner.memberId, audit_count: 2 },
    ]);
  });

  it("reauthorizes CMS profile, member and resource tenant boundaries in registered routes", async () => {
    const { document } = await createPair();
    // The frozen Agent preset has organization content.read, but no content.write grant.
    expect((await agent.read(`${base()}/documents/${document.body.id}`, "Document")).body).toEqual(
      document.body,
    );
    await assertProblem(await agent.command(drafts(document.body.id), starter(), { revision: '"1"' }), 403);
    await assertProblem(
      await owner.command(`${base()}/sites`, {
        name: "Synthetic foreign profile attempt",
        businessProfileId: profileB,
        templateCode: template.code,
      }),
      404,
    );
    await assertProblem(await owner.request(`/v1/orgs/${fixtures.orgB}/documents/${document.body.id}`), 403);
    const switched = await new ApiSession().signIn("owner");
    expect((await switched.switchOrganization(fixtures.orgB)).status).toBe(200);
    await assertProblem(await switched.request(`${base(switched)}/documents/${document.body.id}`), 404);
    await assertProblem(
      await switched.command(drafts(document.body.id, switched), starter(), { revision: '"1"' }),
      404,
    );
  });
});
