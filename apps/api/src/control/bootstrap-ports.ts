import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  BillingBootstrapPort,
  BootstrapPolicy,
  BootstrapPolicyResolver,
  CrmBootstrapPort,
  VerifiedProvisioningContext,
} from "../../../../packages/contracts/internal/control-plane-port";
import presets from "../../../../packages/contracts/role-presets.json";
import { fixtures } from "../../../../packages/db/fixtures";
import { requireSyntheticStaffMode } from "../../../../packages/db/staff-pools";
import { AccessError } from "../../../../packages/db/tenant-transaction";

export function stableId(tenant: string, reference: string) {
  const value = createHash("sha256").update(`synthetic-bootstrap-v1:${tenant}:${reference}`).digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export class SyntheticBootstrapPolicy implements BootstrapPolicyResolver {
  constructor(private readonly client: PoolClient) {}
  async resolve(): Promise<BootstrapPolicy> {
    requireSyntheticStaffMode();
    await this.client.query(
      "SELECT set_config('app.auth_issuer','urn:estate:synthetic',true),set_config('app.auth_subject','owner',true)",
    );
    const owner = await this.client.query(
      "SELECT id,display_name,row_version FROM app.user_identity WHERE id=$1 AND issuer='urn:estate:synthetic'AND subject='owner'AND email_verified FOR SHARE",
      [fixtures.ownerUser],
    );
    if (owner.rowCount !== 1)
      throw new AccessError(409, "bootstrap_owner_unavailable", "Approved bootstrap owner is unavailable.");
    const plan = await this.client.query(
      "SELECT id FROM app.plan WHERE id='a0000000-0000-4000-8000-000000000001'AND code='synthetic-starter'AND billing_interval='month'AND currency='USD'AND features->>'crm'='true'AND features->>'synthetic'='true'",
    );
    if (plan.rowCount !== 1)
      throw new AccessError(409, "bootstrap_policy_changed", "Approved bootstrap policy requires review.");
    return {
      version: "synthetic-provisioning-v1",
      ownerUserId: owner.rows[0].id,
      ownerDisplayName: owner.rows[0].display_name,
      ownerIdentityVersion: String(owner.rows[0].row_version),
      planId: plan.rows[0].id,
      enabledCapabilities: ["crm", "billing"],
      provenance: "synthetic-local",
    };
  }
  async assertCurrent(policy: BootstrapPolicy) {
    if (canonical(await this.resolve()) !== canonical(policy))
      throw new AccessError(
        409,
        "bootstrap_policy_changed",
        "Approved bootstrap identity or policy changed.",
      );
  }
}
export async function assertSeedAuthority(client: PoolClient, context: VerifiedProvisioningContext) {
  requireSyntheticStaffMode();
  const result = await client.query(
    "SELECT app.control_can_seed($1)AND app.current_tenant()=$1::uuid AND current_setting('app.provision_claim',true)=$2 AS allowed",
    [context.organizationId, context.claimId],
  );
  if (!result.rows[0]?.allowed)
    throw new AccessError(409, "provisioning_lease_lost", "Current provisioning claim required.");
}
/** SaaS owns role presets, initial membership and business profile in the invoking transaction. */
export class SaasBootstrap {
  constructor(
    private readonly client: PoolClient,
    private readonly context: VerifiedProvisioningContext,
  ) {}
  async seedDefaults() {
    await assertSeedAuthority(this.client, this.context);
    for (const preset of presets.presets)
      await this.client.query(
        "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants,builtin)VALUES($1,$2,$3,$4,true)ON CONFLICT(tenant_id,id)DO NOTHING",
        [
          this.context.organizationId,
          stableId(this.context.organizationId, `role:${preset.name}`),
          preset.name,
          JSON.stringify(preset.permissions),
        ],
      );
    const ownerMemberId = stableId(this.context.organizationId, "member:initial-owner");
    await this.client.query(
      "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active',$5)ON CONFLICT(tenant_id,id)DO NOTHING",
      [
        this.context.organizationId,
        ownerMemberId,
        this.context.policy.ownerUserId,
        stableId(this.context.organizationId, "role:Owner"),
        this.context.policy.ownerDisplayName,
      ],
    );
    await this.client.query(
      "INSERT INTO app.business_profile(tenant_id,id,name)SELECT $1,$2,name FROM app.organization WHERE id=$1 ON CONFLICT(tenant_id,id)DO NOTHING",
      [this.context.organizationId, stableId(this.context.organizationId, "business-profile")],
    );
    return ownerMemberId;
  }
  async verifyDefaults(ownerMemberId: string) {
    const roles = await this.client.query(
      "SELECT name,permission_grants,builtin FROM app.role_definition WHERE tenant_id=$1 ORDER BY name",
      [this.context.organizationId],
    );
    if (
      roles.rowCount !== presets.presets.length ||
      roles.rows.some(
        (row) =>
          !row.builtin ||
          canonical(row.permission_grants) !==
            canonical(presets.presets.find((preset) => preset.name === row.name)?.permissions),
      )
    )
      throw new AccessError(409, "bootstrap_defaults_invalid", "Role defaults require review.");
    const owners = await this.client.query(
      "SELECT m.id,m.user_id,m.status FROM app.membership m JOIN app.role_definition r ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1 AND r.name='Owner'",
      [this.context.organizationId],
    );
    const profile = await this.client.query("SELECT id FROM app.business_profile WHERE tenant_id=$1", [
      this.context.organizationId,
    ]);
    if (
      owners.rowCount !== 1 ||
      owners.rows[0].id !== ownerMemberId ||
      owners.rows[0].user_id !== this.context.policy.ownerUserId ||
      owners.rows[0].user_id === this.context.initiatingStaffUserId ||
      owners.rows[0].status !== "active" ||
      profile.rowCount !== 1
    )
      throw new AccessError(
        409,
        "bootstrap_defaults_invalid",
        "Initial owner or profile defaults require review.",
      );
  }
}
const stageNames = ["Uncontacted", "Attempted Contact", "Nurturing", "Dead", "Under Contract", "Closed"];
/** CRM's bootstrap adapter has no independent transaction or provider effects. */
export class CrmBootstrap implements CrmBootstrapPort {
  constructor(
    private readonly client: PoolClient,
    private readonly context: VerifiedProvisioningContext,
  ) {}
  async seedDefaults(ownerMemberId: string) {
    await assertSeedAuthority(this.client, this.context);
    for (const [position, name] of stageNames.entries())
      await this.client.query(
        "INSERT INTO app.pipeline_stage(tenant_id,id,name,position,terminal)VALUES($1,$2,$3,$4,$5)ON CONFLICT(tenant_id,id)DO NOTHING",
        [
          this.context.organizationId,
          stableId(this.context.organizationId, `stage:${position}`),
          name,
          position,
          position === 3 || position === 5,
        ],
      );
    await this.client.query(
      "INSERT INTO app.lead_source(tenant_id,id,code,label)VALUES($1,$2,'website-inquiry','Website inquiry')ON CONFLICT(tenant_id,id)DO NOTHING",
      [this.context.organizationId, stableId(this.context.organizationId, "source:website-inquiry")],
    );
    await this.client.query("INSERT INTO app.crm_routing_state(tenant_id)VALUES($1)ON CONFLICT DO NOTHING", [
      this.context.organizationId,
    ]);
    for (const [index, kind] of ["first_touch", "listing_agent", "round_robin"].entries())
      await this.client.query(
        "INSERT INTO app.routing_rule(tenant_id,id,priority,condition,assignment)VALUES($1,$2,$3,$4,$5)ON CONFLICT(tenant_id,id)DO NOTHING",
        [
          this.context.organizationId,
          stableId(this.context.organizationId, `routing:${kind}`),
          (index + 1) * 10,
          { kind, retired: false },
          kind === "round_robin" ? { memberWeights: [{ memberId: ownerMemberId, weight: 1 }] } : {},
        ],
      );
  }
  async verifyDefaults(ownerMemberId: string) {
    const stages = await this.client.query(
      "SELECT name,position,terminal FROM app.pipeline_stage WHERE tenant_id=$1 ORDER BY position",
      [this.context.organizationId],
    );
    const sources = await this.client.query("SELECT code FROM app.lead_source WHERE tenant_id=$1", [
      this.context.organizationId,
    ]);
    const rules = await this.client.query(
      "SELECT condition,assignment FROM app.routing_rule WHERE tenant_id=$1 ORDER BY priority",
      [this.context.organizationId],
    );
    if (
      stages.rowCount !== 6 ||
      stages.rows.some(
        (row, index) =>
          row.name !== stageNames[index] ||
          row.position !== index ||
          row.terminal !== (index === 3 || index === 5),
      ) ||
      sources.rowCount !== 1 ||
      sources.rows[0].code !== "website-inquiry" ||
      rules.rowCount !== 3 ||
      canonical(rules.rows.map((row) => row.condition.kind)) !==
        canonical(["first_touch", "listing_agent", "round_robin"]) ||
      canonical(rules.rows[2].assignment) !==
        canonical({ memberWeights: [{ memberId: ownerMemberId, weight: 1 }] })
    )
      throw new AccessError(409, "bootstrap_defaults_invalid", "CRM defaults require review.");
  }
}
/** Approved no-charge mock policy only; no billing provider is called and no feed is enabled. */
export class BillingBootstrap implements BillingBootstrapPort {
  constructor(
    private readonly client: PoolClient,
    private readonly context: VerifiedProvisioningContext,
  ) {}
  async seedApprovedPolicy() {
    await assertSeedAuthority(this.client, this.context);
    await this.client.query(
      "INSERT INTO app.subscription(tenant_id,id,plan_id,status,period_end)VALUES($1,$2,$3,'mock_active',clock_timestamp()+interval '30 days')ON CONFLICT(tenant_id,id)DO NOTHING",
      [
        this.context.organizationId,
        stableId(this.context.organizationId, "subscription"),
        this.context.policy.planId,
      ],
    );
    for (const feature of this.context.policy.enabledCapabilities)
      await this.client.query(
        "INSERT INTO app.entitlement(tenant_id,id,feature,state,subscription_id)VALUES($1,$2,$3,'enabled',$4)ON CONFLICT(tenant_id,id)DO NOTHING",
        [
          this.context.organizationId,
          stableId(this.context.organizationId, `entitlement:${feature}`),
          feature,
          stableId(this.context.organizationId, "subscription"),
        ],
      );
    await this.client.query(
      "INSERT INTO app.integration_connection(tenant_id,id,provider,mode,state,safe_config)VALUES($1,$2,'stripe','mock','ready','{\"synthetic\":true,\"realCharges\":false}')ON CONFLICT(tenant_id,id)DO NOTHING",
      [this.context.organizationId, stableId(this.context.organizationId, "integration:stripe")],
    );
  }
  async assertReady() {
    const subscriptions = await this.client.query(
      "SELECT plan_id,status FROM app.subscription WHERE tenant_id=$1",
      [this.context.organizationId],
    );
    const entitlements = await this.client.query(
      "SELECT feature,state FROM app.entitlement WHERE tenant_id=$1 ORDER BY feature",
      [this.context.organizationId],
    );
    const connection = await this.client.query(
      "SELECT id,provider,mode,state FROM app.integration_connection WHERE tenant_id=$1",
      [this.context.organizationId],
    );
    if (
      subscriptions.rowCount !== 1 ||
      subscriptions.rows[0].plan_id !== this.context.policy.planId ||
      subscriptions.rows[0].status !== "mock_active" ||
      entitlements.rowCount !== 2 ||
      entitlements.rows.some(
        (row) => !this.context.policy.enabledCapabilities.includes(row.feature) || row.state !== "enabled",
      ) ||
      connection.rowCount !== 1 ||
      connection.rows[0].provider !== "stripe" ||
      connection.rows[0].mode !== "mock" ||
      connection.rows[0].state !== "ready"
    )
      throw new AccessError(409, "bootstrap_defaults_invalid", "Mock billing defaults require review.");
  }
}
