import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  NativeCaptureDecision,
  NativeCapturePort,
  NativeCaptureV1,
} from "../../../packages/contracts/internal/capture-port";
import { requireEntitlement } from "../../../packages/auth/entitlements";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { CrmService, stable } from "./crm-service";
import { RoutingService, postal } from "./routing-service";
import { validateNativeCapture } from "./contract-validation";

type Row = Record<string, any>;
/** Synthetic capture seam only. Construct inside the invoking module's verified tenant transaction. */
export class NativeCaptureService implements NativeCapturePort {
  readonly foundation: CrmService;
  readonly routing: RoutingService;
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    traceId: string,
  ) {
    this.foundation = new CrmService(client, context, traceId);
    this.routing = new RoutingService(client, context, traceId);
  }
  async capture(command: NativeCaptureV1): Promise<NativeCaptureDecision> {
    validateNativeCapture(command);
    const writeScope = requirePermission(this.context, "crm.leads.write");
    const readScope = requirePermission(this.context, "crm.leads.read");
    const contactWriteScope = requirePermission(this.context, "crm.contacts.write");
    const contactReadScope = requirePermission(this.context, "crm.contacts.read");
    requirePermission(this.context, "crm.sources.read");
    await requireEntitlement(this.client, "crm.leads.write");
    const hash = createHash("sha256").update(stable(command)).digest("hex");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:native-capture:${command.sourceId}:${command.sourceSubmissionId}`,
    ]);
    const source = await this.client.query(
      "SELECT id FROM app.lead_source WHERE tenant_id=app.current_tenant() AND id=$1 FOR SHARE",
      [command.sourceId],
    );
    if (!source.rowCount)
      throw new AccessError(422, "source_invalid", "Source must belong to this organization.");
    await this.foundation.row("contacts", command.contactId);
    await this.foundation.row("contacts", command.contactId, true);
    const previous = await this.client.query(
      "SELECT * FROM app.capture_decision WHERE tenant_id=app.current_tenant() AND source_id=$1 AND source_submission_id=$2",
      [command.sourceId, command.sourceSubmissionId],
    );
    if (previous.rowCount) {
      const decision = previous.rows[0];
      if (decision.request_hash !== hash)
        throw new AccessError(
          409,
          "capture_submission_conflict",
          "This source submission was captured with different input.",
        );
      await this.foundation.row("leads", decision.lead_id, true);
      return {
        lead: (await this.foundation.detail("leads", decision.lead_id)) as NativeCaptureDecision["lead"],
        decisionId: decision.id,
        winningRuleId: decision.winning_rule_id,
        reasonCodes: decision.safe_reason_codes,
      };
    }
    await this.routing.state();
    // Serialize first-touch inspection for concurrent inquiries involving the same contact.
    await this.foundation.row("contacts", command.contactId, true, true);
    const restrictCaller = [writeScope, readScope, contactWriteScope, contactReadScope].some(
      (scope) => scope !== "organization",
    );
    const rules = (await this.routing.rules()).filter((rule) => rule.enabled);
    // Seed supplies the default precedence; configured priorities can deliberately override it.
    rules.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const reasons: string[] = [];
    let owner: string | null = null;
    let winning: Row | null = null;
    for (const rule of rules) {
      const kind = rule.condition.kind;
      if (kind === "first_touch") {
        const first = await this.client.query(
          "SELECT owner_member_id FROM app.lead WHERE tenant_id=app.current_tenant() AND contact_id=$1 AND archived_at IS NULL ORDER BY created_at,id LIMIT 1 FOR SHARE",
          [command.contactId],
        );
        const candidate = first.rows[0]?.owner_member_id;
        const eligible = candidate ? await this.routing.eligible([candidate], restrictCaller) : new Set();
        if (candidate && eligible.has(candidate)) {
          owner = candidate;
          reasons.push("first_touch_selected");
        } else reasons.push("first_touch_unavailable");
      } else if (kind === "listing_agent") {
        reasons.push("listing_attribution_unavailable");
      } else if (kind === "geography") {
        if (command.postalCode && rule.condition.postalCodes?.includes(postal(command.postalCode))) {
          owner = await this.routing.weighted(rule, rule.assignment.memberWeights ?? [], restrictCaller);
          reasons.push(owner ? "geography_selected" : "no_eligible_recipient");
        } else reasons.push("geography_unmatched");
      } else if (kind === "round_robin") {
        owner = await this.routing.weighted(rule, rule.assignment.memberWeights ?? [], restrictCaller);
        reasons.push(owner ? "round_robin_selected" : "no_eligible_recipient");
      }
      if (owner) {
        winning = rule;
        break;
      }
    }
    if (!owner) {
      if (restrictCaller)
        throw new AccessError(
          422,
          "recipient_unavailable",
          "No recipient is eligible within the caller's current scope.",
        );
      reasons.push("unassigned_queue");
    }
    const created = await this.foundation.createCapturedLead(
      {
        contactId: command.contactId,
        sourceId: command.sourceId,
        intent: command.intent,
        ...(command.timeline !== undefined ? { timeline: command.timeline } : {}),
        ownerMemberId: owner,
      },
      {
        attribution: {
          synthetic: true,
          source: "synthetic-native-inquiry",
          sourceId: command.sourceId,
          sourceSubmissionId: command.sourceSubmissionId,
          winningRuleId: winning?.id ?? null,
          reasonCodes: [...new Set(reasons)],
          lastEventAt: new Date().toISOString(),
        },
        score: 10,
        scoreVersion: "synthetic-native-inquiry-v1",
      },
    );
    const lead = created.body as NativeCaptureDecision["lead"];
    const decision = await this.client.query(
      "INSERT INTO app.capture_decision(tenant_id,source_id,source_submission_id,request_hash,lead_id,winning_rule_id,safe_reason_codes)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING id",
      [
        this.context.organizationId,
        command.sourceId,
        command.sourceSubmissionId,
        hash,
        lead.id,
        winning?.id ?? null,
        JSON.stringify([...new Set(reasons)]),
      ],
    );
    await this.foundation.audit("capture.decision_recorded", "capture_decision", decision.rows[0].id, 1);
    // Read/write intersection is rechecked after the assignment creates contact ownership relationships.
    await this.foundation.row("contacts", command.contactId);
    await this.foundation.row("contacts", command.contactId, true);
    await this.foundation.row("leads", lead.id, true);
    return {
      lead: (await this.foundation.detail("leads", lead.id)) as NativeCaptureDecision["lead"],
      decisionId: decision.rows[0].id,
      winningRuleId: winning?.id ?? null,
      reasonCodes: [...new Set(reasons)],
    };
  }
}
