import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { components } from "../../packages/contracts/generated/api";
import { databaseConnectionString } from "../../packages/db/pool";
import { isNativeRights } from "../../packages/mls";
import { IDX_TEMPLATE_VERSION, projectIdxTemplateContent } from "../../packages/templates/idx-template";
import { validateSchema } from "../../apps/api/src/contract-validation";
import { assertUuid, stable } from "../../apps/api/src/crm-service";
import { idxTemplatePolicyHash } from "../../apps/api/src/idx-template";

type Schemas = components["schemas"];
export type MockIdxProvisionOptions = {
  tenantId: string;
  siteId: string;
  documentId: string;
  feedId: string;
  profileId: string;
  origin: string;
  sourceId?: string;
  formId?: string;
  createSource?: boolean;
  createForm?: boolean;
  siteAgentMemberId?: string;
  brokerageOfficeId?: string;
  ttlSeconds?: number;
};
export type MockIdxProvisionResult = {
  synthetic: true;
  mode: "mock";
  tenantId: string;
  siteId: string;
  documentId: string;
  formId: string;
  sourceId: string;
  feedId: string;
  profileId: string;
  bindingId: string;
  captureMemberId: string;
  origin: string;
  state: "disabled" | "active";
  expiresAt: string;
  pending: string[];
  limitations: string[];
};
export class MockIdxProvisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const deny = (code: string, message: string): never => {
  throw new MockIdxProvisionError(code, message);
};
const id = (namespace: string) => {
  const hex = createHash("sha256").update(`idx-template-local-provision-v1:${namespace}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const captureGrants = [
  "sites.read",
  "content.read",
  "forms.read",
  "published.site",
  "mls.read",
  "crm.contacts.read",
  "crm.contacts.write",
  "crm.leads.read",
  "crm.leads.write",
  "crm.sources.read",
  "crm.routing.read",
].map((code) => ({ code, scope: "organization" }));
const fields: Schemas["FormField"][] = [
  { key: "name", label: "Name", kind: "text", required: true, maxLength: 100 },
  { key: "email", label: "Email", kind: "email", required: true, maxLength: 254 },
  { key: "phone", label: "Phone", kind: "phone", required: false, maxLength: 30 },
  { key: "message", label: "Message", kind: "textarea", required: true, maxLength: 2000 },
];
const confirmation = "Your inquiry was received. Follow-up is managed by the site team.";
const clock = async (client: PoolClient) => {
  const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    deny("clock_unavailable", "Current database clock required.");
  return now;
};

/** Local migration-identity tool only. Never imported or invoked by API/worker runtime. */
export async function provisionIdxTemplateMock(
  input: MockIdxProvisionOptions,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MockIdxProvisionResult> {
  if (!["development", "test"].includes(environment.APP_ENV ?? "") || environment.DEV_AUTH_ENABLED !== "true")
    deny("local_mode_required", "Explicit synthetic development/test mode required.");
  if (!environment.MIGRATION_DATABASE_URL?.trim())
    deny("explicit_database_required", "An explicit local migration database is required.");
  const connectionString = databaseConnectionString("migration", environment);
  const target = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.search || target.hash)
    deny("loopback_database_required", "Only an explicit loopback database is supported.");
  if (["estate_runtime", "estate_worker", "estate_control"].includes(decodeURIComponent(target.username)))
    deny("migration_identity_required", "Use the separate migration identity.");
  const options = { ...input };
  for (const key of ["tenantId", "siteId", "documentId", "feedId", "profileId", "origin"] as const)
    if (typeof options[key] !== "string" || !options[key])
      deny("argument_required", `Required argument: ${key}.`);
  for (const key of [
    "tenantId",
    "siteId",
    "documentId",
    "feedId",
    "profileId",
    "sourceId",
    "formId",
    "siteAgentMemberId",
    "brokerageOfficeId",
  ] as const)
    if (options[key] !== undefined) {
      assertUuid(options[key]);
      options[key] = options[key]!.toLowerCase();
    }
  if (
    !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(options.origin) ||
    new URL(options.origin).origin !== options.origin
  )
    deny("loopback_origin_required", "A normalized HTTP loopback origin is required.");
  if (
    (options.sourceId && options.createSource) ||
    (!options.sourceId && !options.createSource) ||
    (options.formId && options.createForm) ||
    (!options.formId && !options.createForm)
  )
    deny(
      "explicit_form_source_required",
      "Choose an existing ID or explicit creation flag for each source and form.",
    );
  const ttl = options.ttlSeconds ?? 3600;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400)
    deny("ttl_invalid", "Lifetime must be 60–86400 seconds.");
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const client = await pool.connect().catch(async (error) => {
    await pool.end();
    throw error;
  });
  try {
    await client.query("BEGIN");
    const migration = await client.query<{ permitted: boolean }>(
      `SELECT current_user=session_user AND current_user=$1 AND current_user NOT IN ('estate_runtime','estate_worker','estate_control')
       AND pg_has_role(current_user,pg_get_userbyid(c.relowner),'USAGE') AS permitted
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname='idx_template_binding'`,
      [decodeURIComponent(target.username)],
    );
    if (migration.rows[0]?.permitted !== true)
      deny("migration_identity_required", "The local migration/table-owner identity is required.");
    // The CLI operator is the privileged provisioning authority. Keep FORCE RLS
    // enabled and bind its one explicit tenant/non-login principal transactionally.
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [
      options.tenantId,
      id(`${options.siteId}:user`),
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `idx-template-local-provision:${options.tenantId}:${options.siteId}`,
    ]);
    const site = (
      await client.query(
        `SELECT s.*,d.published_revision_id,d.archived_at AS document_archived_at FROM app.site s
       JOIN app.organization o ON o.id=s.tenant_id JOIN app.business_profile p ON(p.tenant_id,p.id)=(s.tenant_id,s.business_profile_id)
       JOIN app.content_document d ON(d.tenant_id,d.site_id)=(s.tenant_id,s.id)
       WHERE s.tenant_id=$1 AND s.id=$2 AND d.id=$3 AND p.id=$4 AND o.status='active' FOR SHARE OF s,o,p,d`,
        [options.tenantId, options.siteId, options.documentId, options.profileId],
      )
    ).rows[0];
    if (!site || !["draft", "published"].includes(site.state) || site.document_archived_at !== null)
      deny(
        "site_reference_invalid",
        "Active tenant, profile and nonarchived site/document references must agree.",
      );
    const theme = /^(las-vegas-idx-agent|las-vegas-idx-brokerage)@(.+)$/.exec(site.theme_version);
    if (!theme || theme[2] !== IDX_TEMPLATE_VERSION)
      deny("template_pin_invalid", "Choose the currently registered IDX family/version in CMS.");
    if (theme![1] === "las-vegas-idx-agent" && !options.siteAgentMemberId)
      deny("site_agent_required", "Agent family requires an explicit current eligible site member.");
    if (
      options.brokerageOfficeId &&
      !(
        await client.query("SELECT 1 FROM app.office WHERE tenant_id=$1 AND id=$2 FOR SHARE", [
          options.tenantId,
          options.brokerageOfficeId,
        ])
      ).rowCount
    )
      deny("office_invalid", "The explicit brokerage office must belong to the tenant.");
    if (options.siteAgentMemberId) {
      const member = (
        await client.query(
          `SELECT m.id,r.permission_grants
         FROM app.membership m JOIN app.role_definition r ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)
         WHERE m.tenant_id=$1 AND m.id=$2 AND m.status='active' FOR SHARE OF m,r`,
          [options.tenantId, options.siteAgentMemberId],
        )
      ).rows[0];
      if (!member) deny("site_agent_ineligible", "The explicit site member must be active in this tenant.");
      const memberOffices = await client.query(
        `SELECT om.office_id FROM app.office_member om JOIN app.office o ON(o.tenant_id,o.id)=(om.tenant_id,om.office_id)
         WHERE om.tenant_id=$1 AND om.member_id=$2 AND($3::uuid IS NULL OR om.office_id=$3) FOR SHARE OF om,o`,
        [options.tenantId, options.siteAgentMemberId, options.brokerageOfficeId ?? null],
      );
      if (
        !member ||
        !["crm.leads.read", "crm.leads.write"].every(
          (code) =>
            Array.isArray(member.permission_grants) &&
            member.permission_grants.some(
              (grant: { code: string; scope: string }) =>
                grant.code === code &&
                ["own", "team", "organization"].includes(grant.scope) &&
                (grant.scope !== "team" || memberOffices.rowCount! > 0),
            ),
        )
      )
        deny(
          "site_agent_ineligible",
          "The explicit site member must have current CRM lead read/write scope.",
        );
      if (options.brokerageOfficeId && !memberOffices.rowCount)
        deny("site_agent_office_mismatch", "The site member must belong to the explicit brokerage office.");
    }
    const feed = (
      await client.query(
        `SELECT f.*,c.provider,c.mode AS connection_mode,c.state AS connection_state,c.secret_ref,c.safe_config
       FROM app.mls_feed f JOIN app.integration_connection c ON(c.tenant_id,c.id)=(f.tenant_id,f.connection_id)
       WHERE f.tenant_id=$1 AND f.id=$2 FOR SHARE OF f,c`,
        [options.tenantId, options.feedId],
      )
    ).rows[0];
    const now = await clock(client);
    if (
      !feed ||
      feed.mode !== "mock" ||
      feed.transport !== "mock" ||
      feed.state !== "ready" ||
      feed.provider !== "trestle" ||
      feed.connection_mode !== "mock" ||
      feed.connection_state !== "mock" ||
      feed.secret_ref !== null ||
      feed.safe_config?.synthetic !== true ||
      feed.safe_config.liveFeedRights !== "unapproved" ||
      !isNativeRights(feed.native_rights) ||
      feed.native_rights.approvalState !== "approved" ||
      feed.native_rights.rights.display !== "allowed" ||
      !feed.native_rights.disclaimerVersion ||
      feed.native_rights.disclaimerVersion.length > 80 ||
      feed.native_rights.maxDataAgeSeconds === null ||
      feed.native_rights.maxDataAgeSeconds <= 0 ||
      !(feed.policy_approved_at instanceof Date) ||
      !Number.isFinite(feed.policy_approved_at.getTime()) ||
      feed.policy_approved_at.getTime() > now.getTime()
    )
      deny(
        "synthetic_feed_required",
        "A currently approved, explicitly synthetic mock feed without a credential reference is required.",
      );
    validateSchema("DisplayPolicy", feed.display_policy, true);
    if (
      !feed.display_policy.approved ||
      !feed.display_policy.displayFields.includes("status") ||
      !feed.native_rights.allowedFields.includes("status")
    )
      deny("display_policy_invalid", "Approved mock display/status rights are required.");
    const sourceId = options.sourceId ?? id(`${options.tenantId}:${options.siteId}:source`);
    const formId = options.formId ?? id(`${options.tenantId}:${options.siteId}:form`);
    if (options.createSource) {
      const code = `idx-${options.siteId}`;
      await client.query(
        "INSERT INTO app.lead_source(tenant_id,id,code,label)VALUES($1,$2,$3,'Synthetic IDX property inquiry')ON CONFLICT DO NOTHING",
        [options.tenantId, sourceId, code],
      );
      const source = (
        await client.query("SELECT code FROM app.lead_source WHERE tenant_id=$1 AND id=$2 FOR SHARE", [
          options.tenantId,
          sourceId,
        ])
      ).rows[0];
      if (source?.code !== code)
        deny("source_conflict", "Existing synthetic source configuration differs; nothing was replaced.");
    } else if (
      !(
        await client.query("SELECT 1 FROM app.lead_source WHERE tenant_id=$1 AND id=$2 FOR SHARE", [
          options.tenantId,
          sourceId,
        ])
      ).rowCount
    )
      deny("source_reference_invalid", "The explicit source must belong to this tenant.");
    if (options.createForm)
      await client.query(
        "INSERT INTO app.form_schema(tenant_id,id,site_id,name,version,definition,state)VALUES($1,$2,$3,'Synthetic property inquiry',1,$4,'draft')ON CONFLICT DO NOTHING",
        [
          options.tenantId,
          formId,
          options.siteId,
          JSON.stringify({ fields, confirmation, leadSourceId: sourceId }),
        ],
      );
    const form = (
      await client.query("SELECT * FROM app.form_schema WHERE tenant_id=$1 AND id=$2 FOR SHARE", [
        options.tenantId,
        formId,
      ])
    ).rows[0];
    if (
      !form ||
      form.site_id !== options.siteId ||
      form.definition?.leadSourceId !== sourceId ||
      !["draft", "published"].includes(form.state) ||
      !Array.isArray(form.definition.fields) ||
      form.definition.fields.length !== fields.length ||
      new Set(form.definition.fields.map((field: Schemas["FormField"]) => field.key)).size !== fields.length
    )
      deny(
        "form_reference_invalid",
        "The inquiry form must match this site/source and the four bounded source fields.",
      );
    for (const expected of fields) {
      const actual = form.definition.fields.find((field: Schemas["FormField"]) => field.key === expected.key);
      validateSchema("FormField", actual, true);
      if (
        actual.kind !== expected.kind ||
        actual.required !== expected.required ||
        actual.maxLength !== expected.maxLength
      )
        deny(
          "form_shape_invalid",
          "The inquiry form must retain exact source field types and bounds; no consent is inferred.",
        );
    }
    if (site.published_revision_id) {
      const revision = (
        await client.query(
          "SELECT schema_version,block_data,seo FROM app.content_revision WHERE tenant_id=$1 AND id=$2 AND document_id=$3",
          [options.tenantId, site.published_revision_id, options.documentId],
        )
      ).rows[0];
      if (!revision)
        deny("published_revision_invalid", "Published revision must belong to the configured document.");
      projectIdxTemplateContent({
        schemaVersion: revision.schema_version,
        blocks: revision.block_data,
        seo: revision.seo,
      });
    }
    const bindingId = id(`${options.tenantId}:${options.siteId}:binding`);
    const userId = id(`${options.siteId}:user`);
    const roleId = id(`${options.tenantId}:${options.siteId}:role`);
    const memberId = id(`${options.tenantId}:${options.siteId}:member`);
    const roleName = `Synthetic site capture ${options.siteId}`;
    await client.query(
      "INSERT INTO app.user_identity(id,issuer,subject,display_name,email,email_verified)VALUES($1,'urn:estate:idx-template-capture',$2,'Synthetic non-login site capture',$3,true)ON CONFLICT DO NOTHING",
      [userId, options.siteId, `capture-${options.siteId}@example.test`],
    );
    const user = (
      await client.query("SELECT issuer,subject FROM app.user_identity WHERE id=$1 FOR SHARE", [userId])
    ).rows[0];
    if (user?.issuer !== "urn:estate:idx-template-capture" || user?.subject !== options.siteId)
      deny("principal_conflict", "Existing capture identity differs; nothing was replaced.");
    await client.query(
      "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants)VALUES($1,$2,$3,$4)ON CONFLICT DO NOTHING",
      [options.tenantId, roleId, roleName, JSON.stringify(captureGrants)],
    );
    const role = (
      await client.query(
        "SELECT name,permission_grants FROM app.role_definition WHERE tenant_id=$1 AND id=$2 FOR SHARE",
        [options.tenantId, roleId],
      )
    ).rows[0];
    if (role?.name !== roleName || stable(role.permission_grants) !== stable(captureGrants))
      deny("capture_role_conflict", "Existing capture role differs or was revoked; nothing was replaced.");
    await client.query(
      "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active','Synthetic non-login site capture')ON CONFLICT DO NOTHING",
      [options.tenantId, memberId, userId, roleId],
    );
    const member = (
      await client.query(
        "SELECT user_id,role_id,status FROM app.membership WHERE tenant_id=$1 AND id=$2 FOR SHARE",
        [options.tenantId, memberId],
      )
    ).rows[0];
    if (member?.user_id !== userId || member?.role_id !== roleId || member?.status !== "active")
      deny(
        "capture_member_conflict",
        "Existing capture membership differs or was revoked; nothing was replaced.",
      );
    const pending: string[] = [];
    const limitations: string[] = [];
    const entitlementExpiries: number[] = [];
    if (site.state !== "published" || !site.published_revision_id)
      pending.push("Explicitly publish the CMS document revision and site.");
    if (form.state !== "published") pending.push("Explicitly publish the inquiry form through CMS.");
    for (const feature of ["websites", "mls", "crm"]) {
      const enabled = await client.query(
        "SELECT effective_until FROM app.entitlement WHERE tenant_id=$1 AND feature=$2 AND state='enabled' AND(effective_until IS NULL OR effective_until>clock_timestamp())FOR SHARE",
        [options.tenantId, feature],
      );
      if (!enabled.rowCount)
        pending.push(`Enable the ${feature} entitlement through the approved administrative path.`);
      else if (enabled.rows[0].effective_until instanceof Date)
        entitlementExpiries.push(enabled.rows[0].effective_until.getTime());
    }
    if (
      !(
        await client.query("SELECT 1 FROM app.crm_routing_state WHERE tenant_id=$1 FOR SHARE", [
          options.tenantId,
        ])
      ).rowCount
    )
      pending.push("Initialize native CRM routing through its approved path.");
    if (
      !(
        await client.query("SELECT 1 FROM app.pipeline_stage WHERE tenant_id=$1 LIMIT 1 FOR SHARE", [
          options.tenantId,
        ])
      ).rowCount
    )
      pending.push("Configure a native CRM pipeline before capture.");
    if (theme![1] === "las-vegas-idx-brokerage") {
      const rules = await client.query(
        "SELECT 1 FROM app.routing_rule WHERE tenant_id=$1 AND enabled AND NOT coalesce((condition->>'retired')::boolean,false)",
        [options.tenantId],
      );
      if (!rules.rowCount)
        limitations.push(
          "No enabled brokerage routing rule; unmatched inquiries enter the native unassigned queue.",
        );
    }
    const state = pending.length ? "disabled" : "active";
    const policyHash = idxTemplatePolicyHash(feed.display_policy, feed.native_rights);
    const expiry = new Date(Math.min((await clock(client)).getTime() + ttl * 1000, ...entitlementExpiries));
    const inserted = await client.query(
      `INSERT INTO app.idx_template_binding(tenant_id,id,site_id,origin,document_id,form_id,source_id,capture_member_id,business_profile_id,agent_member_id,brokerage_office_id,feed_id,template_code,template_version,mode,policy_version,policy_sha256,policy_expires_at,state,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'mock',$15,$16,$17,$18,$17)ON CONFLICT DO NOTHING RETURNING id`,
      [
        options.tenantId,
        bindingId,
        options.siteId,
        options.origin,
        options.documentId,
        formId,
        sourceId,
        memberId,
        options.profileId,
        options.siteAgentMemberId ?? null,
        options.brokerageOfficeId ?? null,
        options.feedId,
        theme![1],
        theme![2],
        feed.native_rights.disclaimerVersion,
        policyHash,
        expiry,
        state,
      ],
    );
    const binding = (
      await client.query(
        "SELECT * FROM app.idx_template_binding WHERE tenant_id=$1 AND site_id=$2 FOR UPDATE",
        [options.tenantId, options.siteId],
      )
    ).rows[0];
    const expected = {
      id: bindingId,
      origin: options.origin,
      domain_id: null,
      document_id: options.documentId,
      form_id: formId,
      source_id: sourceId,
      capture_member_id: memberId,
      business_profile_id: options.profileId,
      agent_member_id: options.siteAgentMemberId ?? null,
      brokerage_office_id: options.brokerageOfficeId ?? null,
      feed_id: options.feedId,
      template_code: theme![1],
      template_version: theme![2],
      mode: "mock",
      policy_version: feed.native_rights.disclaimerVersion,
      policy_sha256: policyHash,
    };
    if (
      !binding ||
      Object.entries(expected).some(([key, value]) => binding[key] !== value) ||
      !["disabled", "active"].includes(binding.state)
    )
      deny(
        "binding_conflict",
        "Existing binding differs, is revoked, or is not tool-owned; nothing was replaced.",
      );
    const currentNow = await clock(client);
    if (
      !(binding.expires_at instanceof Date) ||
      !(binding.policy_expires_at instanceof Date) ||
      binding.expires_at.getTime() <= currentNow.getTime() ||
      binding.policy_expires_at.getTime() <= currentNow.getTime()
    )
      deny(
        "binding_expired",
        "An expired binding requires separate reviewed recovery; this tool cannot renew it.",
      );
    if (binding.state === "active" && state !== "active")
      deny(
        "active_binding_unready",
        "Current prerequisites no longer pass; this tool cannot rewrite an active binding.",
      );
    const activated = binding.state === "disabled" && state === "active";
    if (activated) {
      await client.query(
        "UPDATE app.idx_template_binding SET state='active',row_version=row_version+1,updated_at=clock_timestamp()WHERE tenant_id=$1 AND id=$2 AND state='disabled'",
        [options.tenantId, bindingId],
      );
      binding.state = "active";
    }
    if (inserted.rowCount || activated)
      await client.query(
        "INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff)VALUES($1,'local-migration:idx-template-provision-v1','idx_template.mock_provisioned','idx_template_binding',$2,$3,$4)",
        [
          options.tenantId,
          bindingId,
          randomUUID(),
          JSON.stringify({ synthetic: true, mode: "mock", state: binding.state }),
        ],
      );
    const finalNow = await clock(client);
    if (entitlementExpiries.some((until) => until <= finalNow.getTime()))
      deny("entitlement_expired", "A prerequisite entitlement expired; no activation was accepted.");
    if (
      binding.expires_at.getTime() <= finalNow.getTime() ||
      binding.policy_expires_at.getTime() <= finalNow.getTime()
    )
      deny("binding_expired", "Binding expired before commit; no activation was accepted.");
    await client.query("COMMIT");
    return {
      synthetic: true,
      mode: "mock",
      tenantId: options.tenantId,
      siteId: options.siteId,
      documentId: options.documentId,
      formId,
      sourceId,
      feedId: options.feedId,
      profileId: options.profileId,
      bindingId,
      captureMemberId: memberId,
      origin: options.origin,
      state: binding.state,
      expiresAt: binding.expires_at.toISOString(),
      pending,
      limitations,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export function parseMockIdxProvisionArgs(args: string[]): MockIdxProvisionOptions {
  const names: Record<string, keyof MockIdxProvisionOptions> = {
    "tenant-id": "tenantId",
    "site-id": "siteId",
    "document-id": "documentId",
    "feed-id": "feedId",
    "profile-id": "profileId",
    origin: "origin",
    "source-id": "sourceId",
    "form-id": "formId",
    "site-agent-member-id": "siteAgentMemberId",
    "brokerage-office-id": "brokerageOfficeId",
    "ttl-seconds": "ttlSeconds",
  };
  const value: Record<string, unknown> = {};
  for (let offset = 0; offset < args.length; offset++) {
    const flag = args[offset];
    if (flag === "--create-source" || flag === "--create-form") {
      const key = flag === "--create-source" ? "createSource" : "createForm";
      if (Object.hasOwn(value, key)) deny("argument_invalid", "Duplicate argument.");
      value[key] = true;
      continue;
    }
    const key = names[flag.replace(/^--/, "")];
    const raw = args[++offset];
    if (!flag.startsWith("--") || !key || !raw || raw.startsWith("--") || Object.hasOwn(value, key))
      deny("argument_invalid", "Use documented, unique arguments with explicit values.");
    value[key] = key === "ttlSeconds" ? Number(raw) : raw;
  }
  for (const key of ["tenantId", "siteId", "documentId", "feedId", "profileId", "origin"])
    if (typeof value[key] !== "string" || !value[key])
      deny("argument_required", `Required argument: ${key}.`);
  return value as MockIdxProvisionOptions;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/idx-template/provision-mock.ts"))
  Promise.resolve()
    .then(() => provisionIdxTemplateMock(parseMockIdxProvisionArgs(process.argv.slice(2))))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(
        error instanceof MockIdxProvisionError
          ? `${error.code}: ${error.message}`
          : "Mock IDX provisioning failed; no activation was accepted.",
      );
      process.exitCode = 1;
    });
