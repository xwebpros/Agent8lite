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
import type {
  PublicInquiryCaptureCommand,
  PublicInquiryCapturePort,
  PublicInquiryCaptureResult,
  PublicInquirySource,
  PublicInquirySourcePort,
} from "../../../packages/contracts/internal/public-inquiry-capture";
import type { components } from "../../../packages/contracts/generated/api";
import { assertUuid } from "./crm-service";

type Row = Record<string, any>;
/** CRM capture ports. Construct inside the invoking module's verified tenant transaction. */
export class NativeCaptureService implements NativeCapturePort, PublicInquiryCapturePort {
  readonly foundation: CrmService;
  readonly routing: RoutingService;
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    traceId: string,
    private readonly publicSource?: PublicInquirySourcePort,
  ) {
    this.foundation = new CrmService(client, context, traceId);
    this.routing = new RoutingService(client, context, traceId);
  }

  /** CRM-owned public command; the invoking CMS receipt transaction owns commit. */
  async capturePublicInquiry(command: PublicInquiryCaptureCommand): Promise<PublicInquiryCaptureResult> {
    if (!this.publicSource)
      throw new AccessError(503, "public_capture_unconfigured", "Public capture is unavailable.");
    for (const id of [command.sourceSubmissionId, command.siteId, command.bindingId]) assertUuid(id);
    for (const code of [
      "crm.contacts.read",
      "crm.contacts.write",
      "crm.leads.read",
      "crm.leads.write",
      "crm.sources.read",
      "crm.routing.read",
    ])
      if (requirePermission(this.context, code) !== "organization")
        throw new AccessError(
          403,
          "public_capture_scope_denied",
          "Current site capture authority is unavailable.",
        );
    const sourceRequest = {
      siteId: command.siteId,
      bindingId: command.bindingId,
      expectedBindingVersion: command.expectedBindingVersion,
      listingKey: command.listingKey,
    };
    let source: PublicInquirySource | undefined;
    const currentSource = async () => {
      const actor = await this.client.query<{ allowed: boolean }>(
        "SELECT current_user='estate_runtime' AND app.current_tenant()=$1::uuid AND app.current_actor()=$2::uuid AS allowed",
        [this.context.organizationId, this.context.userId],
      );
      if (actor.rows[0]?.allowed !== true)
        throw new AccessError(
          403,
          "public_capture_context_denied",
          "Current site capture authority is unavailable.",
        );
      await requireEntitlement(this.client, "crm.leads.write");
      const next = await this.publicSource!.requireCurrent(sourceRequest);
      if (
        next.siteId !== command.siteId ||
        next.bindingId !== command.bindingId ||
        next.bindingVersion !== command.expectedBindingVersion ||
        next.providerListingKey !== command.listingKey
      )
        throw new AccessError(403, "public_capture_source_denied", "Current inquiry source is unavailable.");
      if (command.listingId !== undefined && command.listingId !== next.providerListingId)
        throw new AccessError(
          422,
          "listing_identifier_mismatch",
          "The listing identifier changed. Reload the listing.",
        );
      if (source && stable(next) !== stable(source))
        throw new AccessError(
          409,
          "public_capture_source_changed",
          "The inquiry source changed. Retry the original command.",
        );
      source = next;
      return next;
    };
    await currentSource();
    const email = command.email.trim().toLowerCase();
    if (!email || !command.name.trim() || !command.message.trim())
      throw new AccessError(422, "inquiry_fields_invalid", "Name, email and message are required.");
    // Serialize normalized identity before lookup; household phones never merge contacts.
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:public-contact-email:${email}`,
    ]);
    await currentSource();
    const contacts = await this.client.query<{ contact_id: string }>(
      `SELECT DISTINCT c.id AS contact_id FROM app.contact c JOIN app.contact_channel channel
       ON (channel.tenant_id,channel.contact_id)=(c.tenant_id,c.id)
       WHERE c.tenant_id=app.current_tenant() AND c.archived_at IS NULL
       AND channel.kind='email' AND channel.active AND channel.normalized_value=$1 ORDER BY c.id LIMIT 2`,
      [email],
    );
    if (contacts.rowCount! > 1)
      throw new AccessError(409, "contact_match_ambiguous", "The inquiry contact requires review.");
    let contactId = contacts.rows[0]?.contact_id;
    if (!contactId) {
      const contact = await this.foundation.create("contacts", {
        displayName: command.name,
        emails: [email],
        ...(command.phone?.trim() ? { phones: [command.phone] } : {}),
      });
      contactId = (contact.body as components["schemas"]["Contact"]).id;
    }
    await this.foundation.row("contacts", contactId, true, true);
    await currentSource();
    const requestHash = createHash("sha256").update(stable(command)).digest("hex");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:public-capture:${source!.sourceId}:${command.sourceSubmissionId}`,
    ]);
    await currentSource();
    const prior = await this.client.query(
      "SELECT request_hash FROM app.capture_decision WHERE tenant_id=app.current_tenant() AND source_id=$1 AND source_submission_id=$2",
      [source!.sourceId, command.sourceSubmissionId],
    );
    // The CMS durable receipt handles historical replay and note identity. Calling
    // this port twice without its receipt must never append another private note.
    if (prior.rowCount)
      throw new AccessError(
        409,
        "capture_already_recorded",
        "Reconcile this inquiry through its original receipt.",
      );
    await this.routing.state();
    const rules = (await this.routing.rules())
      .filter((rule) => rule.enabled)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    let owner: string | null = null;
    let winningRule: Row | null = null;
    const reasons: string[] = [];
    const eligible = async (ids: string[]) => {
      let allowed = await this.routing.eligible(ids);
      if (allowed.size) {
        const offices = await this.client.query<{ member_id: string }>(
          `SELECT om.member_id FROM app.office_member om JOIN app.office office
           ON (office.tenant_id,office.id)=(om.tenant_id,om.office_id)
           WHERE om.tenant_id=app.current_tenant() AND($1::uuid IS NULL OR om.office_id=$1) AND om.member_id=ANY($2::uuid[])
           ORDER BY om.member_id FOR SHARE OF om,office`,
          [source!.brokerageOfficeId, [...allowed]],
        );
        const officeMembers = new Set(offices.rows.map((row) => row.member_id));
        const recipients = await this.client.query<{
          id: string;
          permission_grants: Array<{ code: string; scope: string }>;
        }>(
          `SELECT m.id,r.permission_grants FROM app.membership m JOIN app.role_definition r
           ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)
           WHERE m.tenant_id=app.current_tenant() AND m.id=ANY($1::uuid[]) AND m.status='active'
           ORDER BY m.id FOR SHARE OF m,r`,
          [[...allowed]],
        );
        allowed = new Set(
          recipients.rows
            .filter(
              (row) =>
                (!source!.brokerageOfficeId || officeMembers.has(row.id)) &&
                ["crm.leads.read", "crm.leads.write"].every((code) =>
                  row.permission_grants.some(
                    (grant) =>
                      grant.code === code &&
                      ["own", "team", "organization"].includes(grant.scope) &&
                      (grant.scope !== "team" || officeMembers.has(row.id)),
                  ),
                ),
            )
            .map((row) => row.id),
        );
      }
      await currentSource();
      return allowed;
    };
    for (const rule of rules) {
      const kind = rule.condition.kind;
      if (kind === "first_touch") {
        const first = await this.client.query<{ owner_member_id: string | null }>(
          `SELECT owner_member_id FROM app.lead WHERE tenant_id=app.current_tenant()
           AND contact_id=$1 AND archived_at IS NULL ORDER BY created_at,id LIMIT 1 FOR SHARE`,
          [contactId],
        );
        const candidate = first.rows[0]?.owner_member_id;
        owner = candidate && (await eligible([candidate])).has(candidate) ? candidate : null;
        reasons.push(owner ? "first_touch_selected" : "first_touch_unavailable");
      } else if (kind === "listing_agent") {
        const candidate = source!.listingAgentMemberId ?? source!.siteAgentMemberId;
        owner = candidate && (await eligible([candidate])).has(candidate) ? candidate : null;
        reasons.push(
          owner
            ? source!.listingAgentMemberId
              ? "listing_agent_selected"
              : "site_agent_selected"
            : "listing_attribution_unavailable",
        );
      } else if (kind === "geography" || kind === "round_robin") {
        if (
          kind === "geography" &&
          (!source!.postalCode || !rule.condition.postalCodes?.includes(postal(source!.postalCode)))
        ) {
          reasons.push("geography_unmatched");
          continue;
        }
        const weights = rule.assignment.memberWeights ?? [];
        const allowed = await eligible(weights.map((weight: { memberId: string }) => weight.memberId));
        owner = await this.routing.weighted(
          rule,
          weights.filter((weight: { memberId: string }) => allowed.has(weight.memberId)),
          false,
        );
        await currentSource();
        reasons.push(
          owner
            ? kind === "geography"
              ? "geography_selected"
              : "round_robin_selected"
            : "no_eligible_recipient",
        );
      }
      if (owner) {
        winningRule = rule;
        break;
      }
    }
    if (!owner) reasons.push("unassigned_queue");
    await currentSource();
    const created = await this.foundation.createCapturedLead(
      { contactId, sourceId: source!.sourceId, intent: "unknown", ownerMemberId: owner },
      {
        attribution: {
          synthetic: source!.providerCode === "mock-synthetic",
          source: "public-idx-template-inquiry-v1",
          siteId: source!.siteId,
          bindingId: source!.bindingId,
          bindingVersion: source!.bindingVersion,
          sourceId: source!.sourceId,
          sourceSubmissionId: command.sourceSubmissionId,
          feedId: source!.feedId,
          provider: source!.providerCode,
          listingKey: source!.providerListingKey,
          listingId: source!.providerListingId ?? null,
          policyVersion: source!.policyVersion,
          winningRuleId: winningRule?.id ?? null,
          reasonCodes: [...new Set(reasons)],
        },
        score: null,
        scoreVersion: "public-inquiry-unscored-v1",
      },
    );
    const lead = created.body as components["schemas"]["Lead"];
    const note = (await this.foundation.notes(lead.id, { body: command.message }, `"${lead.version}"`)) as {
      body: components["schemas"]["Note"];
    };
    await currentSource();
    const decision = await this.client.query<{ id: string }>(
      `INSERT INTO app.capture_decision(tenant_id,source_id,source_submission_id,request_hash,lead_id,winning_rule_id,safe_reason_codes)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        this.context.organizationId,
        source!.sourceId,
        command.sourceSubmissionId,
        requestHash,
        lead.id,
        winningRule?.id ?? null,
        JSON.stringify([...new Set(reasons)]),
      ],
    );
    await this.foundation.audit("capture.decision_recorded", "capture_decision", decision.rows[0].id, 1);
    const currentLead = (await this.foundation.detail("leads", lead.id)) as components["schemas"]["Lead"];
    await currentSource();
    return {
      lead: currentLead,
      contactId,
      noteId: note.body.id,
      decisionId: decision.rows[0].id,
      winningRuleId: winningRule?.id ?? null,
      reasonCodes: [...new Set(reasons)],
    };
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
