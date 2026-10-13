import { createHash, randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTemplateDraft } from "../../packages/cms";
import type { RevisionRecovery } from "../../packages/cms/recovery";
import recoverySchema from "../../packages/contracts/internal/native-cms-recovery-v1.schema.json";
import historySchema from "../../packages/contracts/internal/native-cms-revision-history-v1.schema.json";
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
const recoveryPath = (documentId: string, revisionId: string, session = owner) =>
  `/dev/orgs/${session.orgId}/cms/documents/${documentId}/revisions/${revisionId}/recovery`;
const starter = () =>
  prepareTemplateDraft(template.code, template.version, { approvedLinkOrigins: new Set() }).document;
const recoveryAjv = new Ajv2020({ strict: false, allErrors: true });
addFormats(recoveryAjv);
const validateRecovery = recoveryAjv.compile(recoverySchema);
const validateHistory = recoveryAjv.compile(historySchema);
const historyPath = (documentId: string, session = owner) =>
  `/dev/orgs/${session.orgId}/cms/documents/${documentId}/revision-history`;
type RevisionMetadata = Pick<Schemas["Revision"], "id" | "documentId" | "schemaVersion" | "createdAt">;
type RevisionIndex = { items: RevisionMetadata[]; hasMore: boolean; nextCursor: string | null };

function privateRecoveryResponse(response: Response) {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-trace-id")).toBeTruthy();
  expect(response.headers.get("etag")).toBeNull();
}

async function recoveryResponse(response: Response) {
  expect(response.status).toBe(200);
  privateRecoveryResponse(response);
  const body: unknown = await response.json();
  expect(validateRecovery(body), JSON.stringify(validateRecovery.errors)).toBe(true);
  return body as RevisionRecovery;
}

async function historyResponse(response: Response): Promise<RevisionIndex> {
  expect(response.status).toBe(200);
  privateRecoveryResponse(response);
  const bytes = await response.text();
  expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(64 * 1024);
  expect(bytes).not.toContain("PRIVATE_UNSUPPORTED_SYNTHETIC");
  const body: unknown = JSON.parse(bytes);
  expect(validateHistory(body), JSON.stringify(validateHistory.errors)).toBe(true);
  return body as RevisionIndex;
}

async function unavailableRecovery(response: Response, status: number) {
  privateRecoveryResponse(response);
  const problem = await assertProblem(response, status);
  expect(JSON.stringify(problem)).not.toContain("PRIVATE_UNSUPPORTED_SYNTHETIC");
  return problem;
}

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

async function unsupportedRevision() {
  const pair = await createPair();
  const id = randomUUID();
  const data = {
    schemaVersion: 7,
    blocks: [
      {
        id: randomUUID(),
        type: "future_recovery_block",
        props: { original: ["<script>PRIVATE_UNSUPPORTED_SYNTHETIC()</script>", { keep: [0, false, null] }] },
      },
    ],
    seo: { title: "Synthetic original recovery", future: { preserve: true } },
  };
  const contentHash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  // An owned migration fixture represents a preserved revision from a future writer.
  await admin.query(
    "INSERT INTO app.content_revision(tenant_id,id,document_id,author_member_id,schema_version,block_data,seo,content_hash)VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      owner.orgId,
      id,
      pair.document.body.id,
      owner.memberId,
      data.schemaVersion,
      JSON.stringify(data.blocks),
      JSON.stringify(data.seo),
      contentHash,
    ],
  );
  return { ...pair, id, data, contentHash };
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
  it("discovers mixed revision metadata through the registered index without reading content or changing documents", async () => {
    const fixture = await unsupportedRevision();
    const supported = await success(
      await owner.command(drafts(fixture.document.body.id), starter(), { revision: '"1"' }),
      "Revision",
      201,
    );
    const before = (await owner.read(`${base()}/documents/${fixture.document.body.id}`, "Document")).body;
    const first = await historyResponse(
      await owner.request(historyPath(fixture.document.body.id) + "?limit=1"),
    );
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const second = await historyResponse(
      await owner.request(
        historyPath(fixture.document.body.id) +
          "?" +
          new URLSearchParams({ limit: "1", cursor: first.nextCursor! }),
      ),
    );
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    const items = [...first.items, ...second.items];
    expect(items.map((item) => item.id)).toEqual([fixture.id, supported.body.id].sort());
    expect(items.every((item) => item.documentId === fixture.document.body.id)).toBe(true);
    expect(items.find((item) => item.id === fixture.id)?.schemaVersion).toBe(7);
    expect(items.find((item) => item.id === supported.body.id)?.schemaVersion).toBe(1);
    expect((await owner.read(`${base()}/revisions/${supported.body.id}`, "Revision")).body).toEqual(
      supported.body,
    );
    await unavailableRecovery(await owner.request(`${base()}/revisions/${fixture.id}`), 409);
    expect(
      (await recoveryResponse(await owner.request(recoveryPath(fixture.document.body.id, fixture.id)))).data,
    ).toEqual(fixture.data);
    expect((await owner.read(`${base()}/documents/${fixture.document.body.id}`, "Document")).body).toEqual(
      before,
    );
    expect((await owner.read(`${base()}/sites/${fixture.site.body.id}`, "Site")).body).toEqual(
      fixture.site.body,
    );
  });

  it("binds registered history cursors to document and actor and rejects ambiguous queries", async () => {
    const fixture = await unsupportedRevision();
    await success(
      await owner.command(drafts(fixture.document.body.id), starter(), { revision: '"1"' }),
      "Revision",
      201,
    );
    const page = await historyResponse(
      await owner.request(historyPath(fixture.document.body.id) + "?limit=1"),
    );
    const other = await createPair();
    for (const [session, id, limit] of [
      [owner, other.document.body.id, "1"],
      [agent, fixture.document.body.id, "1"],
    ] as const) {
      await unavailableRecovery(
        await session.request(
          historyPath(id, session) + "?" + new URLSearchParams({ limit, cursor: page.nextCursor! }),
        ),
        422,
      );
    }
    for (const query of ["unexpected=true", "limit=0", "limit=101", "limit=1&limit=2", "cursor=x&cursor=y"])
      await unavailableRecovery(
        await owner.request(historyPath(fixture.document.body.id) + "?" + query),
        422,
      );
    await unavailableRecovery(await owner.command(historyPath(fixture.document.body.id), {}), 404);
    await unavailableRecovery(await owner.request(historyPath(fixture.document.body.id) + "/extra"), 404);
  });

  it("requires current member and loopback authority for registered history without exposing content", async () => {
    const fixture = await unsupportedRevision();
    const path = historyPath(fixture.document.body.id);
    await unavailableRecovery(await new ApiSession().request(path), 401);
    await unavailableRecovery(
      await owner.request(path, { headers: { "x-forwarded-for": "198.51.100.19" } }),
      403,
    );
    await unavailableRecovery(await owner.request(historyPath(randomUUID())), 404);
    const switched = await new ApiSession().signIn("owner");
    expect((await switched.switchOrganization(fixtures.orgB)).status).toBe(200);
    await unavailableRecovery(await switched.request(path), 403);
    await unavailableRecovery(await switched.request(historyPath(fixture.document.body.id, switched)), 404);
    const priorStatus = (
      await admin.query("SELECT status FROM app.membership WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ])
    ).rows[0].status;
    try {
      await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
      await unavailableRecovery(await agent.request(path), 403);
      expect((await historyResponse(await owner.request(path))).items.map((item) => item.id)).toEqual([
        fixture.id,
      ]);
    } finally {
      await admin.query("UPDATE app.membership SET status=$3 WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
        priorStatus,
      ]);
    }
  });
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

  it("does not expose unbound public sites or register live MLS, dev inquiries/organizer and frozen revision save", async () => {
    for (const path of [
      `/v1/public/sites/${randomUUID()}/listings`,
      `/dev/orgs/${owner.orgId}/mls/live/listings`,
      `/dev/orgs/${owner.orgId}/mls/favorites`,
    ])
      await assertProblem(await owner.request(path), 404);
    await assertProblem(await owner.command(`${listings()}/${randomUUID()}/inquiries`, {}), 404);
    const { document } = await createPair();
    await assertProblem(
      await owner.command(`${base()}/documents/${document.body.id}/revisions`, starter(), {
        revision: '"1"',
      }),
      404,
    );
    await assertProblem(
      await owner.command(`${base()}/documents/${document.body.id}/publish/extra`, {}),
      404,
    );
    await assertProblem(
      await owner.command(`${base()}/documents/${document.body.id}/rollback/extra`, {}),
      404,
    );
  });

  it("registers publication commands behind strict generated input and current session/permission/CSRF boundaries", async () => {
    const { document } = await createPair();
    const revision = await success(
      await owner.command(drafts(document.body.id), starter(), { revision: '"1"' }),
      "Revision",
      201,
    );
    const input: Schemas["PublishRequest"] = { revisionId: revision.body.id, expectedDocumentVersion: 2 };
    for (const action of ["publish", "rollback"] as const) {
      const path = `${base()}/documents/${document.body.id}/${action}`;
      for (const invalid of [
        {},
        starter(),
        { ...input, revisionId: "not-a-uuid" },
        { revisionId: input.revisionId },
        { ...input, expectedDocumentVersion: 0 },
        { ...input, expectedDocumentVersion: "2" },
        { ...input, expectedDocumentVersion: 2.5 },
        { ...input, expectedDocumentVersion: null },
        { ...input, undeclared: "not-authorized" },
      ])
        await assertProblem(await owner.command(path, invalid), 422);
      await assertProblem(await new ApiSession().command(path, input), 401);
      await assertProblem(await agent.command(path, input), 403);
      await assertProblem(await owner.command(path, input, { csrf: "forged" }), 403);
      await assertProblem(
        await owner.command(`/v1/orgs/${fixtures.orgB}/documents/${document.body.id}/${action}`, input),
        403,
      );
      await assertProblem(
        await owner.request(path, {
          method: "POST",
          headers: {
            "x-csrf-token": owner.csrf,
            "idempotency-key": randomUUID(),
            "x-forwarded-for": "198.51.100.19",
          },
          body: JSON.stringify(input),
        }),
        403,
      );
      await assertProblem(
        await owner.request(path, {
          method: "POST",
          headers: {
            "x-csrf-token": owner.csrf,
            "idempotency-key": randomUUID(),
            origin: "https://unapproved.example",
          },
          body: JSON.stringify(input),
        }),
        403,
      );
      expect(
        await assertProblem(
          await owner.request(path, {
            method: "POST",
            headers: {
              "x-csrf-token": owner.csrf,
            },
            body: JSON.stringify(input),
          }),
          400,
        ),
      ).toMatchObject({ code: "idempotency_required" });
    }
    expect((await owner.read(`${base()}/documents/${document.body.id}`, "Document")).body).toMatchObject({
      version: 2,
      publishedRevisionId: null,
    });
  });

  it("publishes and rolls back native revision pointers with exact historical replay without activating an external site", async () => {
    const { site, document } = await createPair();
    const first = await success(
      await owner.command(drafts(document.body.id), starter(), { revision: '"1"' }),
      "Revision",
      201,
    );
    const publishPath = `${base()}/documents/${document.body.id}/publish`;
    const firstInput: Schemas["PublishRequest"] = { revisionId: first.body.id, expectedDocumentVersion: 2 };
    const publishKey = randomUUID();
    const firstJob = await success(
      await owner.command(publishPath, firstInput, { key: publishKey }),
      "Job",
      202,
    );
    expect(firstJob.body).toMatchObject({ state: "succeeded", kind: "document.published" });
    expect(firstJob.etag).toBe('"3"');
    const changed = starter();
    changed.seo.title = "Synthetic second published revision";
    const second = await success(
      await owner.command(drafts(document.body.id), changed, { revision: '"3"' }),
      "Revision",
      201,
    );
    await success(
      await owner.command(publishPath, {
        revisionId: second.body.id,
        expectedDocumentVersion: 4,
      } satisfies Schemas["PublishRequest"]),
      "Job",
      202,
    );
    const historical = await success(
      await owner.command(publishPath, firstInput, { key: publishKey }),
      "Job",
      202,
    );
    expect(historical).toEqual(firstJob);
    expect((await owner.read(`${base()}/documents/${document.body.id}`, "Document")).body).toMatchObject({
      version: 5,
      publishedRevisionId: second.body.id,
    });
    await assertProblem(await owner.command(publishPath, firstInput), 412);
    const unrelated = await createPair();
    const unrelatedRevision = await success(
      await owner.command(drafts(unrelated.document.body.id), starter(), { revision: '"1"' }),
      "Revision",
      201,
    );
    await assertProblem(
      await owner.command(publishPath, {
        revisionId: unrelatedRevision.body.id,
        expectedDocumentVersion: 5,
      } satisfies Schemas["PublishRequest"]),
      404,
    );
    const rollbackPath = `${base()}/documents/${document.body.id}/rollback`;
    const rollbackKey = randomUUID();
    const rollbackInput: Schemas["PublishRequest"] = {
      revisionId: first.body.id,
      expectedDocumentVersion: 5,
    };
    const rollback = await success(
      await owner.command(rollbackPath, rollbackInput, { key: rollbackKey }),
      "Job",
      202,
    );
    expect(rollback.body).toMatchObject({ state: "succeeded", kind: "document.rolledback" });
    expect(rollback.etag).toBe('"6"');
    expect(
      await success(await owner.command(rollbackPath, rollbackInput, { key: rollbackKey }), "Job", 202),
    ).toEqual(rollback);
    expect((await owner.read(`${base()}/documents/${document.body.id}`, "Document")).body).toMatchObject({
      version: 6,
      publishedRevisionId: first.body.id,
    });
    expect((await owner.read(`${base()}/sites/${site.body.id}`, "Site")).body).toMatchObject({
      state: "draft",
      publishedAt: null,
    });
    await assertProblem(await owner.request(`/v1/public/sites/${site.body.id}/listings`), 404);
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

  it("preserves one unsupported original revision through the registered closed read-only recovery route", async () => {
    const fixture = await unsupportedRevision();
    const path = recoveryPath(fixture.document.body.id, fixture.id);
    const recovered = await recoveryResponse(await owner.request(path));
    const normal = await unavailableRecovery(await owner.request(`${base()}/revisions/${fixture.id}`), 409);
    expect(normal.code).toBe("revision_recovery_required");
    expect(
      (
        await unavailableRecovery(
          await owner.request(`${base()}/documents/${fixture.document.body.id}/revisions`),
          409,
        )
      ).code,
    ).toBe("revision_recovery_required");
    expect(recovered).toEqual({
      id: fixture.id,
      documentId: fixture.document.body.id,
      data: fixture.data,
      issues: expect.any(Array),
      canSave: false,
      canPublish: false,
    });
    expect(recovered.issues.length).toBeGreaterThan(0);
    expect(await recoveryResponse(await owner.request(path))).toEqual(recovered);
    expect((await owner.read(`${base()}/documents/${fixture.document.body.id}`, "Document")).body).toEqual(
      fixture.document.body,
    );
    expect((await owner.read(`${base()}/sites/${fixture.site.body.id}`, "Site")).body).toEqual(
      fixture.site.body,
    );
    const stored = await admin.query(
      "SELECT schema_version,block_data,seo,content_hash,(SELECT count(*)::int FROM app.content_revision WHERE tenant_id=$1 AND document_id=$2)AS total FROM app.content_revision WHERE tenant_id=$1 AND id=$3",
      [owner.orgId, fixture.document.body.id, fixture.id],
    );
    expect(stored.rows).toEqual([
      {
        schema_version: 7,
        block_data: fixture.data.blocks,
        seo: fixture.data.seo,
        content_hash: fixture.contentHash,
        total: 1,
      },
    ]);
  });

  it("denies wrong recovery bindings and unregistered paths without revealing the stored original", async () => {
    const fixture = await unsupportedRevision();
    const other = await createPair();
    const wrong = await unavailableRecovery(
      await owner.request(recoveryPath(other.document.body.id, fixture.id)),
      404,
    );
    const missing = await unavailableRecovery(
      await owner.request(recoveryPath(fixture.document.body.id, randomUUID())),
      404,
    );
    expect({ code: wrong.code, title: wrong.title }).toEqual({ code: missing.code, title: missing.title });
    await unavailableRecovery(await owner.request(recoveryPath(randomUUID(), fixture.id)), 404);
    const switched = await new ApiSession().signIn("owner");
    expect((await switched.switchOrganization(fixtures.orgB)).status).toBe(200);
    await unavailableRecovery(
      await switched.request(recoveryPath(fixture.document.body.id, fixture.id)),
      403,
    );
    await unavailableRecovery(
      await switched.request(recoveryPath(fixture.document.body.id, fixture.id, switched)),
      404,
    );
    await unavailableRecovery(await owner.request(recoveryPath(fixture.document.body.id, "invalid")), 422);
    const path = recoveryPath(fixture.document.body.id, fixture.id);
    await unavailableRecovery(await owner.request(path + "?unexpected=true"), 422);
    for (const unknown of [
      path + "/extra",
      path.replace(/recovery$/, "recover"),
      `${base()}/revisions/${fixture.id}/recovery`,
    ])
      await unavailableRecovery(await owner.request(unknown), 404);
    await unavailableRecovery(await owner.command(path, {}), 404);
  });

  it("requires current member and loopback authority for retained recovery reads", async () => {
    const fixture = await unsupportedRevision();
    const path = recoveryPath(fixture.document.body.id, fixture.id);
    await unavailableRecovery(await new ApiSession().request(path), 401);
    await unavailableRecovery(
      await owner.request(path, { headers: { "x-forwarded-for": "127.0.0.1, 198.51.100.19" } }),
      403,
    );
    const initial = await recoveryResponse(await agent.request(path));
    expect(initial.data).toEqual(fixture.data);
    const priorStatus = (
      await admin.query("SELECT status FROM app.membership WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ])
    ).rows[0].status;
    try {
      await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
      await unavailableRecovery(await agent.request(path), 403);
      expect((await recoveryResponse(await owner.request(path))).data).toEqual(fixture.data);
    } finally {
      await admin.query("UPDATE app.membership SET status=$3 WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
        priorStatus,
      ]);
    }
    expect((await recoveryResponse(await agent.request(path))).data).toEqual(fixture.data);
  });
});
