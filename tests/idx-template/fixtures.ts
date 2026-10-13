import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { components } from "../../packages/contracts/generated/api";
import { fixtures as platform } from "../../packages/db/fixtures";
import { syntheticFeedId } from "../../packages/db/seed-native-read-fixtures";
import { createIdxTemplateDefinition, IDX_TEMPLATE_BLOCK_IDS } from "../../packages/templates/idx-template";

type Schemas = components["schemas"];
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export const fixturePolicyHash = (displayPolicy: unknown, nativeRights: unknown) =>
  createHash("sha256").update(canonical({ displayPolicy, nativeRights })).digest("hex");

export const text = (title: string): Schemas["IdxTemplateText"] => ({
  heroEyebrow: "SYNTHETIC IDX fixture",
  heroTitle: title,
  heroDescription: "Fictional property search.",
  quickSearchEyebrow: "Quick search",
  quickSearchTitle: "Find synthetic homes",
  quickSearchDescription: "Fixture filters.",
  exploreEyebrow: "Explore",
  exploreTitle: "Synthetic communities",
  exploreDescription: "Fixture content.",
  footerDescription: "SYNTHETIC DATA; no real listings or delivery.",
});
export const projectFixtureContent = (revision: Schemas["RevisionWrite"]) => ({
  content: text(String(revision.blocks[0]?.props.heading ?? "Invalid fixture content")),
  brand: { displayName: "Synthetic IDX", initial: "SI", agentDisplayName: "Synthetic Agent" },
});

export interface IdxSiteFixture {
  tenant: string;
  siteId: string;
  documentId: string;
  revisionId: string;
  draftId: string;
  formId: string;
  bindingId: string;
  machineUser: string;
  machineMember: string;
  roleId: string;
  sourceId: string;
  profileId: string;
  feedId: string;
  listingKey: string;
  listingId: string;
  agentMember: string;
  origin: string;
  title: string;
  policyVersion: string;
  templateCode: "las-vegas-idx-agent" | "las-vegas-idx-brokerage";
}

export async function createSiteFixture(
  admin: Pool,
  options: {
    tenant?: string;
    origin?: string;
    title?: string;
    brokerage?: boolean;
    siteId?: string;
    machineUser?: string;
    unbound?: boolean;
  } = {},
): Promise<IdxSiteFixture> {
  const tenant = options.tenant ?? platform.orgA;
  const siteId = options.siteId ?? randomUUID();
  const documentId = randomUUID();
  const revisionId = randomUUID();
  const draftId = randomUUID();
  const formId = randomUUID();
  const bindingId = randomUUID();
  const machineUser = options.machineUser ?? randomUUID();
  const machineMember = randomUUID();
  const roleId = randomUUID();
  const profileId = randomUUID();
  const sourceId = randomUUID();
  const feedId = syntheticFeedId(tenant);
  const title = options.title ?? `Public ${siteId}`;
  const origin = options.origin ?? "http://localhost:3000";
  const agentMember = tenant === platform.orgA ? platform.agentMemberA : platform.agentMemberB;
  const templateCode = options.brokerage ? "las-vegas-idx-brokerage" : "las-vegas-idx-agent";
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    const feed = (
      await client.query(
        "SELECT display_policy,native_rights FROM app.mls_feed WHERE tenant_id=$1 AND id=$2",
        [tenant, feedId],
      )
    ).rows[0];
    if (!feed) throw new Error("idx_test_synthetic_feed_required");
    // This fixture explicitly approves URL display, never media storage/cache.
    feed.display_policy.displayFields = [
      ...new Set([...feed.display_policy.displayFields, "photos", "pool", "hoa"]),
    ];
    feed.native_rights.allowedFields = [
      ...new Set([...feed.native_rights.allowedFields, "photos", "pool", "hoa"]),
    ];
    feed.native_rights.addressRule = "visible";
    feed.native_rights.locationRule = "exact";
    await client.query(
      "UPDATE app.mls_feed SET display_policy=$1,native_rights=$2 WHERE tenant_id=$3 AND id=$4",
      [feed.display_policy, feed.native_rights, tenant, feedId],
    );
    const listing = (
      await client.query(
        "SELECT source_listing_key,source_listing_id FROM app.listing WHERE tenant_id=$1 AND feed_id=$2 AND synthetic AND status='active' AND display_allowed AND expires_at>clock_timestamp() ORDER BY source_listing_key LIMIT 1",
        [tenant, feedId],
      )
    ).rows[0];
    if (!listing) throw new Error("idx_test_current_synthetic_listing_required");
    const policyHash = fixturePolicyHash(feed.display_policy, feed.native_rights);
    const policyVersion = feed.native_rights.disclaimerVersion;
    const grants = [
      "crm.contacts.read",
      "crm.contacts.write",
      "crm.leads.read",
      "crm.leads.write",
      "crm.sources.read",
      "crm.routing.read",
      "sites.read",
      "content.read",
      "forms.read",
      "mls.read",
      "published.site",
    ].map((code) => ({ code, scope: "organization" }));
    if (!options.machineUser)
      await client.query(
        "INSERT INTO app.user_identity(id,issuer,subject,display_name,email,email_verified) VALUES($1,$4,$2,'Synthetic non-login site capture',$3,true)",
        [
          machineUser,
          siteId,
          `capture-${siteId}@example.test`,
          options.unbound ? "urn:estate:idx-template-fixture-author" : "urn:estate:idx-template-capture",
        ],
      );
    await client.query(
      "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants) VALUES($1,$2,$3,$4)",
      [
        tenant,
        roleId,
        `Synthetic ${options.unbound ? "fixture author" : "site capture"} ${siteId}`,
        JSON.stringify(grants),
      ],
    );
    await client.query(
      "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name) VALUES($1,$2,$3,$4,'active','Synthetic site capture')",
      [tenant, machineMember, machineUser, roleId],
    );
    await client.query(
      "INSERT INTO app.business_profile(tenant_id,id,name) VALUES($1,$2,'Synthetic IDX business')",
      [tenant, profileId],
    );
    await client.query(
      "INSERT INTO app.lead_source(tenant_id,id,code,label) VALUES($1,$2,$3,'Synthetic IDX inquiry')",
      [tenant, sourceId, `${options.unbound ? "fixture-" : ""}idx-${siteId}`],
    );
    await client.query(
      "INSERT INTO app.site(tenant_id,id,business_profile_id,name,state,theme_version) VALUES($1,$2,$3,$4,'published',$5)",
      [tenant, siteId, profileId, title, `${templateCode}@1.0.0`],
    );
    await client.query(
      "INSERT INTO app.content_document(tenant_id,id,site_id,slug,kind,title) VALUES($1,$2,$3,'home','page',$4)",
      [tenant, documentId, siteId, title],
    );
    for (const [id, revisionTitle] of [
      [revisionId, title],
      [draftId, `PRIVATE DRAFT ${siteId}`],
    ]) {
      const blocks = createIdxTemplateDefinition(options.brokerage ? "brokerage" : "agent").document.blocks;
      const copy = text(revisionTitle);
      for (const block of blocks) {
        if (block.id === IDX_TEMPLATE_BLOCK_IDS.hero)
          block.props = {
            heading: copy.heroTitle,
            summary: copy.heroDescription,
            eyebrow: copy.heroEyebrow,
            brand: { displayName: "Synthetic IDX", initial: "SI", agentDisplayName: "Synthetic Agent" },
          };
        if (block.id === IDX_TEMPLATE_BLOCK_IDS.quickSearch)
          block.props = {
            heading: copy.quickSearchTitle,
            summary: copy.quickSearchDescription,
            eyebrow: copy.quickSearchEyebrow,
          };
        if (block.id === IDX_TEMPLATE_BLOCK_IDS.explore)
          block.props = {
            heading: copy.exploreTitle,
            summary: copy.exploreDescription,
            eyebrow: copy.exploreEyebrow,
          };
        if (block.id === IDX_TEMPLATE_BLOCK_IDS.footer) block.props = { text: copy.footerDescription };
      }
      const seo = { title: "Synthetic IDX fixture", description: "Fictional public content", noindex: true };
      await client.query(
        "INSERT INTO app.content_revision(tenant_id,id,document_id,author_member_id,schema_version,block_data,seo,content_hash) VALUES($1,$2,$3,$4,1,$5,$6,$7)",
        [
          tenant,
          id,
          documentId,
          machineMember,
          JSON.stringify(blocks),
          JSON.stringify(seo),
          createHash("sha256").update(JSON.stringify(blocks)).digest("hex"),
        ],
      );
    }
    await client.query(
      "UPDATE app.content_document SET published_revision_id=$1 WHERE tenant_id=$2 AND id=$3",
      [revisionId, tenant, documentId],
    );
    const fields = [
      { key: "name", label: "Name", kind: "text", required: true, maxLength: 100 },
      { key: "email", label: "Email", kind: "email", required: true, maxLength: 254 },
      { key: "phone", label: "Phone", kind: "phone", required: false, maxLength: 30 },
      { key: "message", label: "Message", kind: "textarea", required: true, maxLength: 2000 },
    ];
    await client.query(
      "INSERT INTO app.form_schema(tenant_id,id,site_id,name,version,definition,state) VALUES($1,$2,$3,$5,1,$4,'published')",
      [
        tenant,
        formId,
        siteId,
        JSON.stringify({ fields, leadSourceId: sourceId }),
        options.unbound ? "Fixture original inquiry" : "Synthetic property inquiry",
      ],
    );
    if (!options.unbound)
      await client.query(
        `INSERT INTO app.idx_template_binding(tenant_id,id,site_id,origin,document_id,form_id,source_id,capture_member_id,business_profile_id,agent_member_id,feed_id,template_code,template_version,mode,policy_version,policy_sha256,policy_expires_at,state,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'1.0.0','mock',$13,$14,clock_timestamp()+interval '1 hour','active',clock_timestamp()+interval '1 hour')`,
        [
          tenant,
          bindingId,
          siteId,
          origin,
          documentId,
          formId,
          sourceId,
          machineMember,
          profileId,
          options.brokerage ? null : agentMember,
          feedId,
          templateCode,
          policyVersion,
          policyHash,
        ],
      );
    await client.query("COMMIT");
    return {
      tenant,
      siteId,
      documentId,
      revisionId,
      draftId,
      formId,
      bindingId,
      machineUser,
      machineMember,
      roleId,
      sourceId,
      profileId,
      feedId,
      listingKey: listing.source_listing_key,
      listingId: listing.source_listing_id,
      agentMember,
      origin,
      title,
      policyVersion,
      templateCode,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
