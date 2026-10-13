import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createCmsProfileReferencePort } from "../../apps/api/src/admin-profile-reference";
import { CmsService } from "../../apps/api/src/cms";
import type { components } from "../../packages/contracts/generated/api";
import { fixtures as platform } from "../../packages/db/fixtures";
import { withTenantTransaction } from "../../packages/db/tenant-transaction";
import { MockStorageProvider } from "../../packages/providers/storage/mock";
import { projectIdxTemplateContent } from "../../packages/templates/idx-template";
import { createSiteFixture, type IdxSiteFixture } from "./fixtures";
import { createIdxPools } from "./isolation";

type Schemas = components["schemas"];
const { admin, runtime } = createIdxPools();
afterAll(async () => {
  await Promise.all([admin.end(), runtime.end()]);
});

function command<T>(
  fixture: IdxSiteFixture,
  action: (service: CmsService, client: PoolClient) => Promise<T>,
) {
  return withTenantTransaction(
    runtime,
    { userId: platform.ownerUser, organizationId: fixture.tenant },
    (client, context) =>
      action(
        new CmsService(client, context, randomUUID(), {
          profiles: createCmsProfileReferencePort(client, context),
          trustedLinkPolicy: { approvedLinkOrigins: new Set() },
          storage: new MockStorageProvider("http://localhost:3000"),
        }),
        client,
      ),
  );
}
async function pointer(fixture: IdxSiteFixture) {
  return (
    await admin.query(
      "SELECT published_revision_id,row_version FROM app.content_document WHERE tenant_id=$1 AND id=$2",
      [fixture.tenant, fixture.documentId],
    )
  ).rows[0];
}
async function selectedTitle(fixture: IdxSiteFixture) {
  const row = (
    await admin.query(
      "SELECT r.schema_version,r.block_data,r.seo FROM app.content_document d JOIN app.content_revision r ON(r.tenant_id,r.id)=(d.tenant_id,d.published_revision_id) WHERE d.tenant_id=$1 AND d.id=$2",
      [fixture.tenant, fixture.documentId],
    )
  ).rows[0];
  return projectIdxTemplateContent({
    schemaVersion: row.schema_version,
    blocks: row.block_data,
    seo: row.seo,
  }).content.heroTitle;
}
async function invalidRevision(
  fixture: IdxSiteFixture,
  kind: "missing-slot" | "empty-slot" | "unsafe-brand",
) {
  const row = (
    await admin.query("SELECT block_data,seo FROM app.content_revision WHERE tenant_id=$1 AND id=$2", [
      fixture.tenant,
      fixture.draftId,
    ])
  ).rows[0];
  const blocks = row.block_data as Schemas["Block"][];
  if (kind === "missing-slot") blocks.pop();
  if (kind === "empty-slot") blocks[0].props.heading = "";
  if (kind === "unsafe-brand")
    blocks[0].props.brand = {
      displayName: "<script>fixture</script>",
      initial: "S",
      agentDisplayName: "Synthetic",
    };
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.content_revision(tenant_id,id,document_id,author_member_id,schema_version,block_data,seo,content_hash) VALUES($1,$2,$3,$4,1,$5,$6,$7)",
    [
      fixture.tenant,
      id,
      fixture.documentId,
      platform.ownerMemberA,
      JSON.stringify(blocks),
      JSON.stringify(row.seo),
      createHash("sha256").update(JSON.stringify(blocks)).digest("hex"),
    ],
  );
  return id;
}

describe("native CMS publication of the preserved IDX content slots", () => {
  it.each(["missing-slot", "empty-slot", "unsafe-brand"] as const)(
    "rejects publishing and rollback of %s without changing the selected revision",
    async (kind) => {
      const fixture = await createSiteFixture(admin);
      const id = await invalidRevision(fixture, kind);
      const before = await pointer(fixture);
      for (const method of ["publishDocument", "rollbackDocument"] as const) {
        await expect(
          command(fixture, (service) =>
            service[method](
              fixture.documentId,
              { revisionId: id, expectedDocumentVersion: Number(before.row_version) },
              { key: randomUUID() },
            ),
          ),
        ).rejects.toMatchObject({ status: 422, code: "idx_template_content_invalid" });
        expect(await pointer(fixture)).toEqual(before);
        expect(await selectedTitle(fixture)).toBe(fixture.title);
      }
    },
  );

  it("publishes and rolls back complete immutable native revisions with durable idempotency", async () => {
    const fixture = await createSiteFixture(admin);
    const key = randomUUID();
    const published = await command(fixture, (service) =>
      service.publishDocument(
        fixture.documentId,
        { revisionId: fixture.draftId, expectedDocumentVersion: 1 },
        { key },
      ),
    );
    expect(published).toMatchObject({
      status: 202,
      body: { state: "succeeded", kind: "document.published" },
    });
    expect(await selectedTitle(fixture)).toBe(`PRIVATE DRAFT ${fixture.siteId}`);
    const rolledBack = await command(fixture, (service) =>
      service.rollbackDocument(
        fixture.documentId,
        { revisionId: fixture.revisionId, expectedDocumentVersion: 2 },
        { key: randomUUID() },
      ),
    );
    expect(rolledBack).toMatchObject({
      status: 202,
      body: { state: "succeeded", kind: "document.rolledback" },
    });
    expect(await selectedTitle(fixture)).toBe(fixture.title);
    const after = await pointer(fixture);
    const replay = await command(fixture, (service) =>
      service.publishDocument(
        fixture.documentId,
        { revisionId: fixture.draftId, expectedDocumentVersion: 1 },
        { key },
      ),
    );
    expect(replay.body).toEqual(published.body);
    expect(await pointer(fixture)).toEqual(after);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM app.content_revision WHERE tenant_id=$1 AND document_id=$2",
          [fixture.tenant, fixture.documentId],
        )
      ).rows[0].count,
    ).toBe(2);
  });
});
