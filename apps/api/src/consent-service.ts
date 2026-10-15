import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { components } from "../../../packages/contracts/generated/api";
import type {
  ConsentChannelPort,
  ConsentCommandIdentity,
  ConsentEvidencePort,
  ConsentPurpose,
  ConsentSnapshot,
  NativeConsentPort,
  ScopedConsentChannel,
  SyntheticEvidenceRequest,
  SyntheticEvidenceResponse,
  VerifiedConsentEvidence,
} from "../../../packages/contracts/internal/consent-port";
import { requireEntitlement } from "../../../packages/auth/entitlements";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { jobModel } from "./admin-service";
import { ConsentChannelService } from "./consent-channel-service";
import { CrmService, stable } from "./crm-service";
import { validateSchema, validateSyntheticConsent } from "./contract-validation";

type Consent = components["schemas"]["ConsentWrite"];
type Row = Record<string, any>;
const policy = "synthetic-communication-v1" as const;
const purposes = ["email_marketing", "sms_marketing", "listing_alert"] as const;
const canonicalUuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const evidencePattern = new RegExp(`^synthetic-evidence:(${canonicalUuid})$`);
const withdrawalPattern = new RegExp(`^staff-withdrawal:${canonicalUuid}$`);
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");

/** Consent-owned commands and eligibility decisions use the invoking verified transaction. */
export class ConsentService implements NativeConsentPort, ConsentEvidencePort {
  readonly foundation: CrmService;
  readonly channelPort: ConsentChannelPort;
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    readonly traceId: string,
    channels?: ConsentChannelPort,
  ) {
    this.foundation = new CrmService(client, context, traceId);
    this.channelPort = channels ?? new ConsentChannelService(client, context);
  }
  private syntheticEnabled() {
    const env = process.env.APP_ENV ?? process.env.NODE_ENV ?? "";
    return (
      ["development", "test"].includes(env) && (process.env.DEV_AUTH_ENABLED === "true" || env === "test")
    );
  }
  private permission() {
    if (requirePermission(this.context, "consent.write") !== "organization")
      throw new AccessError(403, "consent_scope_unavailable", "Organization consent authority is required.");
  }
  private purpose(channel: ScopedConsentChannel, purpose: ConsentPurpose) {
    if (!purposes.includes(purpose))
      throw new AccessError(422, "consent_purpose_invalid", "Consent purpose is invalid.");
    if ((purpose === "sms_marketing") !== (channel.kind === "phone"))
      throw new AccessError(
        422,
        "consent_channel_mismatch",
        "This channel is not approved for that purpose.",
      );
  }
  private async source(
    channelId: string,
    purpose: ConsentPurpose,
    access: "read" | "write" | "withdraw",
    shared = false,
  ) {
    const initial = await this.channelPort.resolve(channelId, access);
    this.purpose(initial, purpose);
    const lock = digest({
      tenantId: this.context.organizationId,
      kind: initial.kind,
      destination: initial.normalizedDestination,
      purpose,
    });
    await this.client.query(
      `SELECT ${shared ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock"}(hashtextextended($1,0))`,
      [lock],
    );
    const current = await this.channelPort.resolve(channelId, access, true);
    if (stable(current) !== stable(initial))
      throw new AccessError(409, "consent_source_changed", "The source changed. Reload before retrying.");
    return current;
  }
  private async state(channelId: string, purpose: ConsentPurpose, create = false) {
    if (create)
      await this.client.query(
        "INSERT INTO app.consent_state(tenant_id,contact_channel_id,purpose)VALUES($1,$2,$3)ON CONFLICT DO NOTHING",
        [this.context.organizationId, channelId, purpose],
      );
    const result = await this.client.query(
      `SELECT * FROM app.consent_state WHERE tenant_id=app.current_tenant() AND contact_channel_id=$1 AND purpose=$2 ${create ? "FOR UPDATE" : ""}`,
      [channelId, purpose],
    );
    return (
      result.rows[0] ?? {
        state: "unknown",
        row_version: "1",
        last_event_id: null,
        verified_evidence_id: null,
      }
    );
  }
  /** Durable command records do not expire into duplicate consent ledger commands. */
  private async durable<T>(
    namespace: string,
    key: string,
    body: unknown,
    command: () => Promise<T>,
    replay: () => Promise<void>,
  ): Promise<T> {
    if (!key || key.length > 100 || !/^[\x21-\x7e]+$/.test(key))
      throw new AccessError(
        400,
        "idempotency_required",
        "A printable Idempotency-Key of at most 100 characters is required.",
      );
    const routeKey = `consent:${namespace}:${this.context.memberId}`;
    const hash = digest(body);
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${routeKey}:${key}`,
    ]);
    const prior = await this.client.query(
      "SELECT request_hash,response_body FROM app.idempotency_record WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3",
      [this.context.userId, routeKey, key],
    );
    if (prior.rowCount) {
      if (prior.rows[0].request_hash !== hash)
        throw new AccessError(
          409,
          "idempotency_conflict",
          "This idempotency key was used with a different request.",
        );
      await replay();
      return prior.rows[0].response_body as T;
    }
    const result = await command();
    await this.client.query(
      "INSERT INTO app.idempotency_record(tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,expires_at)VALUES($1,$2,$3,$4,$5,$6,$7,'infinity')",
      [
        this.context.organizationId,
        this.context.userId,
        routeKey,
        key,
        hash,
        JSON.stringify(result),
        namespace === "evidence" ? 201 : 202,
      ],
    );
    return result;
  }
  private async authorizeGrant() {
    this.permission();
    if (!this.syntheticEnabled())
      throw new AccessError(
        403,
        "consent_provenance_unavailable",
        "Approved consent evidence is unavailable.",
      );
    await requireEntitlement(this.client, "crm.contacts.write");
  }
  async issueEvidence(request: SyntheticEvidenceRequest, key: string): Promise<SyntheticEvidenceResponse> {
    validateSyntheticConsent("EvidenceRequest", request);
    await this.authorizeGrant();
    return this.durable(
      "evidence",
      key,
      request,
      async () => {
        const channel = await this.source(request.contactChannelId, request.purpose, "write");
        const state = await this.state(channel.channelId, request.purpose, true);
        const proof = await this.client.query(
          `WITH clock AS(SELECT clock_timestamp() AS at) INSERT INTO app.consent_evidence(tenant_id,contact_channel_id,purpose,policy_version,provenance,state_version,channel_version,contact_version,initiating_member_id,created_at,expires_at) SELECT $1,$2,$3,$4,'synthetic-local',$5,$6,$7,$8,at,at+interval '15 minutes' FROM clock RETURNING id,expires_at`,
          [
            this.context.organizationId,
            channel.channelId,
            request.purpose,
            policy,
            state.row_version,
            channel.channelVersion,
            channel.contactVersion,
            this.context.memberId,
          ],
        );
        const response: SyntheticEvidenceResponse = {
          evidenceRef: `synthetic-evidence:${proof.rows[0].id}`,
          policyVersion: policy,
          expiresAt: new Date(proof.rows[0].expires_at).toISOString(),
          synthetic: true,
        };
        validateSyntheticConsent("EvidenceResponse", response, true);
        await this.foundation.audit("consent.evidence_issued", "consent_evidence", proof.rows[0].id, 1);
        return response;
      },
      async () => {
        await this.source(request.contactChannelId, request.purpose, "write");
      },
    );
  }
  async resolveGrant(command: Consent): Promise<VerifiedConsentEvidence> {
    await this.authorizeGrant();
    const matched = evidencePattern.exec(command.evidenceRef);
    if (!matched || command.policyVersion !== policy)
      throw new AccessError(
        422,
        "consent_evidence_unverified",
        "A verified current proof is required for a grant.",
      );
    const proof = await this.client.query(
      "SELECT *,expires_at>clock_timestamp() AS current FROM app.consent_evidence WHERE tenant_id=app.current_tenant() AND id=$1",
      [matched[1]],
    );
    const row = proof.rows[0];
    if (row && row.initiating_member_id !== this.context.memberId)
      throw new AccessError(
        403,
        "consent_evidence_actor_denied",
        "The proof is not authorized for this member.",
      );
    if (
      !row ||
      row.initiating_member_id !== this.context.memberId ||
      row.contact_channel_id !== command.contactChannelId ||
      row.purpose !== command.purpose ||
      row.policy_version !== command.policyVersion ||
      row.action !== "grant" ||
      row.provenance !== "synthetic-local"
    )
      throw new AccessError(422, "consent_evidence_unverified", "The proof does not authorize this grant.");
    if (!row.current)
      throw new AccessError(409, "consent_evidence_expired", "The proof expired. Obtain a new proof.");
    return {
      evidenceId: row.id,
      tenantId: row.tenant_id,
      initiatingMemberId: row.initiating_member_id,
      channelId: row.contact_channel_id,
      purpose: row.purpose,
      action: "grant",
      policyVersion: row.policy_version,
      stateVersion: String(row.state_version),
      channelVersion: String(row.channel_version),
      contactVersion: String(row.contact_version),
      expiresAt: new Date(row.expires_at).toISOString(),
      provenance: row.provenance,
    };
  }
  async record(command: Consent, identity: ConsentCommandIdentity): Promise<components["schemas"]["Job"]> {
    validateSchema("ConsentWrite", command);
    this.permission();
    if (!["staff", "form"].includes(identity.producer))
      throw new AccessError(422, "consent_command_invalid", "Consent command identity is invalid.");
    if (command.action === "grant") await this.authorizeGrant();
    else if (
      !withdrawalPattern.test(command.evidenceRef) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(command.policyVersion)
    )
      throw new AccessError(
        422,
        "consent_withdrawal_invalid",
        "A bounded withdrawal trace and policy identifier are required.",
      );
    return this.durable(
      `record:${identity.producer}`,
      identity.key,
      command,
      async () => {
        const channel = await this.source(
          command.contactChannelId,
          command.purpose,
          command.action === "withdraw" ? "withdraw" : "write",
        );
        const state = await this.state(channel.channelId, command.purpose, true);
        let proof: VerifiedConsentEvidence | undefined;
        if (command.action === "grant") {
          proof = await this.resolveGrant(command);
          if (
            proof.stateVersion !== String(state.row_version) ||
            proof.channelVersion !== channel.channelVersion ||
            proof.contactVersion !== channel.contactVersion
          )
            throw new AccessError(
              409,
              "consent_evidence_stale",
              "The proof no longer matches current consent and source state.",
            );
          const used = await this.client.query(
            "SELECT id FROM app.consent_event WHERE tenant_id=app.current_tenant() AND evidence_id=$1",
            [proof.evidenceId],
          );
          if (used.rowCount)
            throw new AccessError(409, "consent_evidence_consumed", "The proof was already consumed.");
        }
        const eventId = randomUUID();
        const version = BigInt(state.row_version);
        const recorded = await this.client.query(
          "INSERT INTO app.consent_event(tenant_id,id,contact_channel_id,purpose,action,policy_version,evidence_ref,occurred_at,consent_sequence,initiating_member_id,evidence_id)SELECT $1,$2,$3,$4,$5,$6,$7,clock_timestamp(),$8,$9,$10 WHERE($10::uuid IS NULL OR EXISTS(SELECT 1 FROM app.consent_evidence WHERE tenant_id=app.current_tenant() AND id=$10 AND expires_at>clock_timestamp()))RETURNING id",
          [
            this.context.organizationId,
            eventId,
            channel.channelId,
            command.purpose,
            command.action,
            command.policyVersion,
            command.evidenceRef,
            version.toString(),
            this.context.memberId,
            proof?.evidenceId ?? null,
          ],
        );
        if (!recorded.rowCount)
          throw new AccessError(
            409,
            "consent_evidence_expired",
            "The proof expired before recording. Obtain a new proof.",
          );
        await this.client.query(
          "UPDATE app.consent_state SET state=$1,row_version=row_version+1,last_event_id=$2,verified_evidence_id=$3,updated_at=clock_timestamp()WHERE tenant_id=app.current_tenant() AND contact_channel_id=$4 AND purpose=$5",
          [
            command.action === "grant" ? "granted" : "withdrawn",
            eventId,
            proof?.evidenceId ?? null,
            channel.channelId,
            command.purpose,
          ],
        );
        if (command.action === "withdraw")
          await this.client.query(
            `INSERT INTO app.suppression(tenant_id,channel_kind,normalized_destination,purpose,reason)VALUES($1,$2,$3,$4,'consent_withdrawal')ON CONFLICT(tenant_id,channel_kind,normalized_destination,purpose)DO UPDATE SET expires_at=NULL,row_version=app.suppression.row_version+1,updated_at=clock_timestamp()`,
            [this.context.organizationId, channel.kind, channel.normalizedDestination, command.purpose],
          );
        else {
          const unresolved = await this.unresolved(channel, command.purpose);
          if (!unresolved)
            await this.client.query(
              "UPDATE app.suppression SET expires_at=clock_timestamp(),row_version=row_version+1,updated_at=clock_timestamp()WHERE tenant_id=app.current_tenant() AND channel_kind=$1 AND normalized_destination=$2 AND purpose=$3 AND reason='consent_withdrawal'",
              [channel.kind, channel.normalizedDestination, command.purpose],
            );
        }
        const job = await this.client.query(
          "INSERT INTO app.integration_job(tenant_id,kind,state,result_ref,requesting_member_id)VALUES($1,'consent.record','succeeded',$2,$3)RETURNING *",
          [this.context.organizationId, eventId, this.context.memberId],
        );
        await this.foundation.audit("consent.recorded", "consent_event", eventId, Number(version));
        await this.foundation.event(
          "consent.changed",
          "consent_event",
          eventId,
          Number(version),
          [channel.channelId],
          "consent",
        );
        const body = jobModel(job.rows[0]);
        validateSchema("Job", body, true);
        return body;
      },
      async () => {
        await this.source(
          command.contactChannelId,
          command.purpose,
          command.action === "withdraw" ? "withdraw" : "write",
        );
      },
    );
  }
  private async unresolved(channel: ScopedConsentChannel, purpose: ConsentPurpose) {
    const states = await this.client.query(
      "SELECT state.contact_channel_id FROM app.consent_state state JOIN app.contact_channel channel ON(channel.tenant_id,channel.id)=(state.tenant_id,state.contact_channel_id)WHERE state.tenant_id=app.current_tenant() AND channel.kind=$1 AND channel.normalized_value=$2 AND state.purpose=$3 AND state.state='withdrawn' LIMIT 1",
      [channel.kind, channel.normalizedDestination, purpose],
    );
    return !!states.rowCount;
  }
  async readEligibility(channelId: string, purpose: ConsentPurpose): Promise<ConsentSnapshot> {
    const channel = await this.source(channelId, purpose, "read", true);
    const state = await this.state(channelId, purpose);
    const proof = state.verified_evidence_id
      ? await this.client.query(
          "SELECT evidence.id,evidence.provenance,evidence.policy_version,event.id AS event_id,event.action FROM app.consent_evidence evidence JOIN app.consent_event event ON(event.tenant_id,event.evidence_id)=(evidence.tenant_id,evidence.id)WHERE evidence.tenant_id=app.current_tenant() AND evidence.id=$1 AND event.id=$2 AND event.contact_channel_id=$3 AND event.purpose=$4",
          [state.verified_evidence_id, state.last_event_id, channelId, purpose],
        )
      : { rows: [] as Row[] };
    const provenance = proof.rows[0] ?? null;
    const suppression = await this.client.query(
      "SELECT id,row_version,reason,expires_at,(expires_at IS NULL OR expires_at>clock_timestamp()) AS blocking FROM app.suppression WHERE tenant_id=app.current_tenant() AND channel_kind=$1 AND normalized_destination=$2 AND purpose=$3",
      [channel.kind, channel.normalizedDestination, purpose],
    );
    const block = suppression.rows[0] ?? null;
    const withdrawnDestination = await this.unresolved(channel, purpose);
    const syntheticApproved =
      provenance?.provenance === "synthetic-local" &&
      provenance?.policy_version === policy &&
      provenance?.action === "grant";
    const reasons: string[] = [];
    if (state.state !== "granted")
      reasons.push(state.state === "withdrawn" ? "consent_withdrawn" : "consent_unknown");
    else if (!syntheticApproved) reasons.push("consent_provenance_unavailable");
    if (withdrawnDestination) reasons.push("destination_withdrawn");
    if (block?.blocking) reasons.push("destination_suppressed");
    const revision = digest({
      tenantId: this.context.organizationId,
      memberId: this.context.memberId,
      permissions: this.context.permissions,
      purpose,
      channel,
      state,
      provenance,
      suppression: block,
      withdrawnDestination,
      syntheticApproved,
    });
    return {
      contactChannelId: channelId,
      purpose,
      state: state.state,
      consentEligible: reasons.length === 0,
      revision,
      reasonCodes: reasons,
    };
  }
  async assertCurrent(snapshot: ConsentSnapshot): Promise<ConsentSnapshot> {
    const current = await this.readEligibility(snapshot.contactChannelId, snapshot.purpose);
    if (current.revision !== snapshot.revision)
      throw new AccessError(
        409,
        "consent_snapshot_stale",
        "Consent eligibility changed. Reload before dispatch.",
      );
    if (!current.consentEligible)
      throw new AccessError(403, "consent_ineligible", "Current consent does not allow this action.");
    return current;
  }
}
