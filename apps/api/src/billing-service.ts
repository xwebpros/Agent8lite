import { randomUUID } from "node:crypto";
import { hashToken } from "../../../packages/auth/sessions";
import type { PoolClient } from "pg";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { MockBillingProvider, SYNTHETIC_BILLING_TERMS } from "../../../packages/providers/billing/mock";
import type { BillingPlan } from "../../../packages/providers/billing/port";
import { requireEntitlement } from "../../../packages/auth/entitlements";
import { assertUuid, CrmService, stable } from "./crm-service";

type Schemas = components["schemas"];
type Row = Record<string, any>;
export const localBillingWebhookSecret = "synthetic-billing-webhook-secret-for-loopback-only-v1";
const mode = process.env.APP_ENV === "test" ? "test" : "development";
const configured =
  ["development", "test"].includes(process.env.APP_ENV ?? "") && process.env.DEV_AUTH_ENABLED === "true";
const outcome = ["accepted", "unknown", "failed"].includes(process.env.BILLING_MOCK_OUTCOME ?? "")
  ? (process.env.BILLING_MOCK_OUTCOME as "accepted" | "unknown" | "failed")
  : "accepted";
const provider = configured
  ? new MockBillingProvider({
      mode,
      webhookSecret: process.env.BILLING_MOCK_WEBHOOK_SECRET ?? localBillingWebhookSecret,
      outcome,
    })
  : null;
const plan = (row: Row): BillingPlan => ({
  code: row.code,
  currency: row.currency,
  recurringTotalMinor: Number(row.price_minor),
  interval: row.billing_interval,
});
const job = (row: Row): Schemas["Job"] => ({
  id: row.id,
  state: row.state,
  kind: row.kind,
  createdAt: new Date(row.created_at).toISOString(),
  resultUrl: null,
  error: row.safe_error
    ? {
        type: `https://estate.example/problems/${row.safe_error}`,
        title: "Synthetic billing operation requires attention.",
        status: 503,
        code: row.safe_error,
        traceId: row.id,
      }
    : null,
});

export class BillingService {
  constructor(
    private readonly client: PoolClient,
    private readonly context: TenantContext,
    private readonly traceId: string,
  ) {}
  private ready() {
    if (!provider)
      throw new AccessError(
        503,
        "billing_provider_unconfigured",
        "A permitted synthetic billing adapter is required.",
      );
    return provider;
  }
  private async subscription(lock = false) {
    const result = await this.client.query(
      `SELECT s.*,p.code,p.currency,p.price_minor,p.billing_interval,p.features,p.limits FROM app.subscription s JOIN app.plan p ON p.id=s.plan_id WHERE s.tenant_id=$1 ${lock ? "FOR UPDATE OF s" : ""}`,
      [this.context.organizationId],
    );
    if (!result.rowCount)
      throw new AccessError(503, "subscription_unconfigured", "No subscription has been configured.");
    return result.rows[0];
  }
  private async entitlementSnapshot() {
    const result = await this.client.query(
      "SELECT feature,state,row_version,effective_until FROM app.entitlement ORDER BY feature FOR SHARE",
    );
    return result.rows.map((row) => ({
      feature: row.feature,
      state: row.state,
      version: String(row.row_version),
      effectiveUntil: row.effective_until ? new Date(row.effective_until).toISOString() : null,
    }));
  }
  async overview(): Promise<Schemas["BillingOverview"]> {
    requirePermission(this.context, "billing.read");
    this.ready();
    const current = await this.subscription();
    const entitlements = await this.client.query("SELECT * FROM app.entitlement ORDER BY feature LIMIT 101");
    if (entitlements.rows.length > 100)
      throw new AccessError(
        503,
        "entitlement_overview_limit",
        "Entitlement overview exceeds the supported limit.",
      );
    return {
      subscriptionId: current.id,
      planCode: current.code,
      status: current.status,
      currency: current.currency,
      annualTotalMinor: current.billing_interval === "year" ? Number(current.price_minor) : null,
      monthlyEquivalentMinor:
        current.billing_interval === "year"
          ? Math.round(Number(current.price_minor) / 12)
          : Number(current.price_minor),
      periodEnd: current.period_end ? new Date(current.period_end).toISOString() : null,
      entitlements: entitlements.rows.map((row) => ({
        feature: row.feature,
        state:
          row.effective_until && new Date(row.effective_until).getTime() < Date.now()
            ? "disabled"
            : row.state,
        limit: row.limit_value === null ? null : Number(row.limit_value),
        expiresAt: row.effective_until ? new Date(row.effective_until).toISOString() : null,
      })),
    };
  }
  async preview(
    body: Schemas["BillingPreviewRequest"],
    key: string,
  ): Promise<{ body: Schemas["BillingPreview"]; status: number; termsVersion: string }> {
    requirePermission(this.context, "billing.manage");
    const adapter = this.ready();
    const current = await this.subscription(true);
    let target: Row | undefined;
    if (body.action === "change_plan") {
      const rows = await this.client.query(
        "SELECT * FROM app.plan WHERE code=$1 AND billing_interval=$2 AND active",
        [body.planCode, body.billingInterval],
      );
      target = rows.rows[0];
      if (!target)
        throw new AccessError(
          422,
          "plan_invalid",
          "Select a registered synthetic plan and billing interval.",
        );
    } else if (body.planCode || body.billingInterval)
      throw new AccessError(422, "billing_action_invalid", "Plan selection applies only to change_plan.");
    const quote = await adapter.preview({
      action: body.action,
      currentPlan: plan(current),
      targetPlan: target ? plan(target) : undefined,
      now: new Date(),
    });
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const preview: Schemas["BillingPreview"] = {
      id,
      expiresAt,
      currency: quote.currency,
      dueNowMinor: quote.dueNowMinor,
      recurringTotalMinor: quote.recurringTotalMinor,
      interval: quote.interval,
      effectiveAt: quote.effectiveAt,
      terms: [...quote.terms, `Terms version: ${quote.termsVersion}`],
    };
    await this.client.query(
      `INSERT INTO app.billing_change(tenant_id,id,subscription_id,state,preview,expires_at,idempotency_key,requesting_member_id,subscription_version,entitlement_snapshot,request_body,terms_version)VALUES($1,$2,$3,'preview',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        this.context.organizationId,
        id,
        current.id,
        JSON.stringify(preview),
        expiresAt,
        `${this.context.userId}:${key}`,
        this.context.memberId,
        current.row_version,
        JSON.stringify(await this.entitlementSnapshot()),
        JSON.stringify({
          ...body,
          currentPlan: plan(current),
          targetPlan: target ? plan(target) : null,
          targetPlanId: target?.id ?? current.plan_id,
        }),
        quote.termsVersion,
      ],
    );
    await new CrmService(this.client, this.context, this.traceId).audit(
      "billing.preview_created",
      "billing_change",
      id,
      1,
    );
    return { body: preview, status: 201, termsVersion: quote.termsVersion };
  }
  async confirm(body: Schemas["PreviewConfirm"]) {
    requirePermission(this.context, "billing.manage");
    const adapter = this.ready();
    assertUuid(body.previewId);
    const current = await this.subscription(true);
    const rows = await this.client.query(
      "SELECT * FROM app.billing_change WHERE tenant_id=app.current_tenant() AND id=$1 AND requesting_member_id=$2 FOR UPDATE",
      [body.previewId, this.context.memberId],
    );
    if (!rows.rowCount)
      throw new AccessError(404, "preview_unavailable", "Preview unavailable or outside your request scope.");
    const preview = rows.rows[0];
    if (preview.state !== "preview")
      throw new AccessError(409, "preview_consumed", "This preview has already been confirmed.");
    if (new Date(preview.expires_at).getTime() < Date.now())
      throw new AccessError(409, "preview_expired", "Create a new preview before confirming.");
    if (
      body.acceptedTermsVersion !== preview.terms_version ||
      body.acceptedTermsVersion !== SYNTHETIC_BILLING_TERMS
    )
      throw new AccessError(
        409,
        "billing_terms_changed",
        "Explicit acceptance of the current terms version is required.",
      );
    if (
      String(current.row_version) !== String(preview.subscription_version) ||
      stable(await this.entitlementSnapshot()) !== stable(preview.entitlement_snapshot)
    )
      throw new AccessError(
        409,
        "billing_preview_stale",
        "Subscription or capabilities changed after this preview.",
      );
    const pending = await this.client.query(
      `SELECT id FROM app.billing_change WHERE subscription_id=$1 AND id<>$2 AND state IN('pending','unknown')`,
      [current.id, preview.id],
    );
    if (pending.rowCount)
      throw new AccessError(
        409,
        "billing_reconciliation_pending",
        "Reconcile the pending operation before starting another change.",
      );
    const command = preview.request_body;
    const acceptance = await adapter.confirm({
      tenantId: this.context.organizationId,
      commandId: preview.id,
      action: command.action,
      currentPlan: command.currentPlan,
      targetPlan: command.targetPlan ?? undefined,
    });
    const state =
      acceptance.state === "accepted" ? "queued" : acceptance.state === "unknown" ? "unknown" : "failed";
    const operation = await this.client.query(
      `INSERT INTO app.integration_job(tenant_id,kind,state,result_ref,requesting_member_id,safe_error,safe_result)VALUES($1,'billing.synthetic.confirmation',$2,$3,$4,$5,$6)RETURNING *`,
      [
        this.context.organizationId,
        state,
        preview.id,
        this.context.memberId,
        state === "failed" ? "synthetic_billing_failed" : null,
        JSON.stringify({ externalCharge: false, reconciliationRequired: state !== "failed" }),
      ],
    );
    await this.client.query(
      "UPDATE app.billing_change SET state=$1,job_id=$2,request_body=jsonb_set(request_body,'{providerReference}',COALESCE(to_jsonb($4::text),'null'::jsonb),true),row_version=row_version+1,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$3",
      [
        acceptance.state === "accepted" ? "pending" : acceptance.state,
        operation.rows[0].id,
        preview.id,
        acceptance.providerReference,
      ],
    );
    await new CrmService(this.client, this.context, this.traceId).audit(
      "billing.confirmation_requested",
      "billing_change",
      preview.id,
      Number(preview.row_version) + 1,
    );
    return { body: job(operation.rows[0]), status: 202 };
  }
  async termsVersionForPreview(id: string) {
    const result = await this.client.query(
      "SELECT terms_version FROM app.billing_change WHERE id=$1 AND requesting_member_id=$2",
      [id, this.context.memberId],
    );
    return result.rows[0]?.terms_version as string | undefined;
  }
  async reconcile(previewId: string, expectedProviderReference?: string) {
    requirePermission(this.context, "billing.manage");
    const adapter = this.ready();
    assertUuid(previewId);
    const current = await this.subscription(true);
    const rows = await this.client.query(
      "SELECT * FROM app.billing_change WHERE tenant_id=app.current_tenant() AND id=$1 AND requesting_member_id=$2 FOR UPDATE",
      [previewId, this.context.memberId],
    );
    if (!rows.rowCount)
      throw new AccessError(
        404,
        "billing_operation_unavailable",
        "Billing operation unavailable or outside your request scope.",
      );
    const change = rows.rows[0];
    if (!change.job_id)
      throw new AccessError(409, "billing_not_confirmed", "The preview has not been confirmed.");
    // Re-read the authoritative mock state on every webhook/replay, even for duplicate events.
    const authoritative = await adapter.readCurrentState(this.context.organizationId, previewId);
    if (
      expectedProviderReference &&
      ((change.request_body.providerReference &&
        change.request_body.providerReference !== expectedProviderReference) ||
        (authoritative && authoritative.providerReference !== expectedProviderReference))
    )
      throw new AccessError(
        409,
        "billing_provider_reference_conflict",
        "Webhook reference does not match this authoritative command.",
      );
    const jobs = await this.client.query("SELECT * FROM app.integration_job WHERE id=$1", [change.job_id]);
    if (change.state === "reconciled" || change.state === "failed")
      return { body: job(jobs.rows[0]), status: 202 };
    if (!authoritative) {
      await this.client.query(
        `UPDATE app.integration_job SET state='unknown',safe_error='synthetic_provider_state_unavailable',row_version=row_version+1,updated_at=now() WHERE id=$1`,
        [change.job_id],
      );
      const unknown = await this.client.query("SELECT * FROM app.integration_job WHERE id=$1", [
        change.job_id,
      ]);
      return { body: job(unknown.rows[0]), status: 202 };
    }
    if (
      authoritative.externalCharge !== false ||
      authoritative.tenantId !== this.context.organizationId ||
      authoritative.commandId !== previewId
    )
      throw new AccessError(503, "billing_state_invalid", "Provider state cannot be reconciled safely.");
    if (authoritative.status === "failed") {
      await this.client.query(
        `UPDATE app.billing_change SET state='failed',row_version=row_version+1,updated_at=now() WHERE id=$1`,
        [previewId],
      );
      await this.client.query(
        `UPDATE app.integration_job SET state='failed',safe_error='synthetic_billing_failed',row_version=row_version+1,updated_at=now() WHERE id=$1`,
        [change.job_id],
      );
    } else {
      if (String(current.row_version) !== String(change.subscription_version))
        throw new AccessError(
          409,
          "billing_reconciliation_conflict",
          "Subscription changed; this operation requires review.",
        );
      if (stable(await this.entitlementSnapshot()) !== stable(change.entitlement_snapshot))
        throw new AccessError(
          409,
          "billing_entitlement_conflict",
          "Capabilities changed after confirmation; this operation requires review.",
        );
      const plans = await this.client.query(
        "SELECT * FROM app.plan WHERE code=$1 AND billing_interval=$2 AND currency=$3 AND active",
        [authoritative.plan.code, authoritative.plan.interval, authoritative.plan.currency],
      );
      const observedPlan = plans.rows[0];
      if (!observedPlan || Number(observedPlan.price_minor) !== authoritative.plan.recurringTotalMinor)
        throw new AccessError(
          503,
          "billing_plan_unrecognized",
          "Authoritative plan does not match a registered plan.",
        );
      await this.client.query(
        `UPDATE app.subscription SET plan_id=$1,status=$2,period_end=NULL,reconciled_at=now(),row_version=row_version+1,updated_at=now() WHERE id=$3`,
        [observedPlan.id, `mock_${authoritative.status}`, current.id],
      );
      // Only the implemented CRM capability is reconciled. Payment cannot mark provisioning ready.
      await this.client.query(
        `UPDATE app.entitlement SET state=$1,row_version=row_version+1,updated_at=now() WHERE feature='crm'`,
        [authoritative.status === "active" && observedPlan.features.crm === true ? "enabled" : "disabled"],
      );
      await this.client.query(
        `UPDATE app.billing_change SET state='reconciled',row_version=row_version+1,updated_at=now() WHERE id=$1`,
        [previewId],
      );
      await this.client.query(
        `UPDATE app.integration_job SET state='succeeded',safe_error=NULL,row_version=row_version+1,updated_at=now() WHERE id=$1`,
        [change.job_id],
      );
      const foundation = new CrmService(this.client, this.context, this.traceId);
      await foundation.audit(
        "subscription.reconciled",
        "subscription",
        current.id,
        Number(current.row_version) + 1,
      );
      await foundation.event(
        "subscription.reconciled",
        "subscription",
        current.id,
        Number(current.row_version) + 1,
        [previewId],
        "billing",
      );
    }
    const updated = await this.client.query("SELECT * FROM app.integration_job WHERE id=$1", [change.job_id]);
    return { body: job(updated.rows[0]), status: 202 };
  }
  async webhook(rawBody: string, signature: string) {
    requirePermission(this.context, "billing.manage");
    const adapter = this.ready();
    let event;
    try {
      event = adapter.verifyWebhook(rawBody, signature);
    } catch {
      throw new AccessError(
        403,
        "billing_webhook_signature_invalid",
        "Synthetic webhook signature is invalid or expired.",
      );
    }
    if (event.tenantId !== this.context.organizationId)
      throw new AccessError(403, "billing_webhook_scope_denied", "Webhook belongs to another organization.");
    const connection = await this.client.query(
      `SELECT id FROM app.integration_connection WHERE provider='stripe' AND mode='mock' AND state='ready'`,
    );
    if (!connection.rowCount)
      throw new AccessError(
        503,
        "billing_provider_unconfigured",
        "Synthetic billing connection is not ready.",
      );
    const payloadReference = `billing-change:${event.commandId}:${hashToken(JSON.stringify([event.type, event.tenantId, event.commandId, event.providerReference]))}`;
    const recorded = await this.client.query(
      "SELECT payload_ref FROM app.webhook_inbox WHERE connection_id=$1 AND provider_event_id=$2",
      [connection.rows[0].id, event.id],
    );
    if (recorded.rowCount && recorded.rows[0].payload_ref !== payloadReference)
      throw new AccessError(
        409,
        "billing_webhook_event_conflict",
        "This provider event ID was already used for a different command or reference.",
      );
    await this.client.query(
      `INSERT INTO app.webhook_inbox(tenant_id,connection_id,provider_event_id,payload_ref,signature_verified,state,expires_at)VALUES($1,$2,$3,$4,true,'verified',now()+interval '90 days')ON CONFLICT(tenant_id,connection_id,provider_event_id)DO NOTHING`,
      [this.context.organizationId, connection.rows[0].id, event.id, payloadReference],
    );
    // The unique insert can race with another valid delivery; verify its committed fingerprint too.
    const after = await this.client.query(
      "SELECT payload_ref FROM app.webhook_inbox WHERE connection_id=$1 AND provider_event_id=$2",
      [connection.rows[0].id, event.id],
    );
    if (after.rows[0].payload_ref !== payloadReference)
      throw new AccessError(
        409,
        "billing_webhook_event_conflict",
        "This provider event ID was already used for a different command or reference.",
      );
    return this.reconcile(event.commandId, event.providerReference);
  }
  async openPortal(): Promise<{ body: Schemas["HostedFlow"]; status: number }> {
    requirePermission(this.context, "billing.manage");
    const adapter = this.ready();
    await requireEntitlement(this.client, "billing.manage");
    const session = await adapter.createPortalSession(this.context.organizationId);
    await new CrmService(this.client, this.context, this.traceId).audit(
      "billing.portal_opened",
      "organization",
      this.context.organizationId,
      1,
    );
    return { body: { url: session.url, expiresAt: session.expiresAt }, status: 201 };
  }
}
