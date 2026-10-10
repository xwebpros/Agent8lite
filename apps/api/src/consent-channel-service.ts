import type { PoolClient } from "pg";
import type {
  ConsentChannelPort,
  ScopedConsentChannel,
  SyntheticConsentChannelsResponse,
} from "../../../packages/contracts/internal/consent-port";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { assertUuid, CrmService } from "./crm-service";

/** CRM owns channel identity and contact scope; consent never writes CRM source tables. */
export class ConsentChannelService implements ConsentChannelPort {
  constructor(
    private readonly client: PoolClient,
    private readonly context: TenantContext,
  ) {}

  private contactScope(scope: "own" | "team" | "organization") {
    if (scope === "organization") return "TRUE";
    const owner =
      scope === "own"
        ? "l.owner_member_id=$2"
        : "EXISTS(SELECT 1 FROM app.office_member target JOIN app.office_member mine ON (mine.tenant_id,mine.office_id)=(target.tenant_id,target.office_id) WHERE target.tenant_id=c.tenant_id AND target.member_id=l.owner_member_id AND mine.member_id=$2)";
    return `((c.created_by_member_id=$2 AND NOT EXISTS(SELECT 1 FROM app.lead l WHERE l.tenant_id=c.tenant_id AND l.contact_id=c.id AND l.archived_at IS NULL)) OR EXISTS(SELECT 1 FROM app.lead l WHERE l.tenant_id=c.tenant_id AND l.contact_id=c.id AND l.archived_at IS NULL AND ${owner}))`;
  }

  async resolve(
    channelId: string,
    access: "read" | "write" | "withdraw",
    lock = false,
  ): Promise<ScopedConsentChannel> {
    assertUuid(channelId);
    const scopes = [requirePermission(this.context, "crm.contacts.read")];
    if (access !== "read") scopes.push(requirePermission(this.context, "crm.contacts.write"));
    const predicate = scopes.map((scope) => this.contactScope(scope)).join(" AND ");
    const contacts = await this.client.query(
      `SELECT c.id,c.row_version FROM app.contact c WHERE c.tenant_id=app.current_tenant() AND $2::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM app.contact_channel channel WHERE channel.tenant_id=c.tenant_id AND channel.contact_id=c.id AND channel.id=$1 ${access === "withdraw" ? "" : "AND channel.active"}) AND ${predicate} ${access === "withdraw" ? "" : "AND c.archived_at IS NULL"} ${lock ? "FOR UPDATE OF c" : ""}`,
      [channelId, this.context.memberId],
    );
    if (!contacts.rowCount)
      throw new AccessError(404, "resource_unavailable", "Channel unavailable or out of scope.");
    const contact = contacts.rows[0];
    // Preserve the current lead ownership used by the contact-scope decision until commit.
    if (lock)
      await this.client.query(
        "SELECT id FROM app.lead WHERE tenant_id=app.current_tenant() AND contact_id=$1 AND archived_at IS NULL ORDER BY id FOR SHARE",
        [contact.id],
      );
    if (lock && scopes.includes("team"))
      await this.client.query(
        `SELECT link.office_id,link.member_id FROM app.office_member link WHERE link.tenant_id=app.current_tenant() AND EXISTS(SELECT 1 FROM app.lead l JOIN app.office_member target ON(target.tenant_id,target.member_id)=(l.tenant_id,l.owner_member_id)JOIN app.office_member mine ON(mine.tenant_id,mine.office_id)=(target.tenant_id,target.office_id)WHERE l.tenant_id=link.tenant_id AND l.contact_id=$1 AND l.archived_at IS NULL AND mine.member_id=$2 AND link.office_id=target.office_id AND link.member_id IN(target.member_id,mine.member_id))ORDER BY link.office_id,link.member_id FOR SHARE OF link`,
        [contact.id, this.context.memberId],
      );
    const channels = await this.client.query(
      `SELECT id,kind,normalized_value,row_version FROM app.contact_channel WHERE tenant_id=app.current_tenant() AND id=$1 AND contact_id=$2 ${access === "withdraw" ? "" : "AND active"} ${lock ? "FOR SHARE" : ""}`,
      [channelId, contact.id],
    );
    if (!channels.rowCount)
      throw new AccessError(404, "resource_unavailable", "Channel unavailable or out of scope.");
    // A blocked ownership update may have completed while the source locks were acquired.
    if (lock) {
      const authorized = await this.client.query(
        `SELECT c.id FROM app.contact c WHERE c.tenant_id=app.current_tenant() AND c.id=$1 AND $2::uuid IS NOT NULL AND ${predicate}`,
        [contact.id, this.context.memberId],
      );
      if (!authorized.rowCount)
        throw new AccessError(404, "resource_unavailable", "Channel unavailable or out of scope.");
    }
    const channel = channels.rows[0];
    return {
      channelId,
      contactId: contact.id,
      kind: channel.kind,
      normalizedDestination: channel.normalized_value,
      contactVersion: String(contact.row_version),
      channelVersion: String(channel.row_version),
    };
  }

  async list(contactId: string): Promise<SyntheticConsentChannelsResponse> {
    assertUuid(contactId);
    requirePermission(this.context, "consent.write");
    const crm = new CrmService(this.client, this.context, "channel-selector");
    await crm.row("contacts", contactId);
    await crm.row("contacts", contactId, true);
    const rows = await this.client.query(
      "SELECT id,kind FROM app.contact_channel WHERE tenant_id=app.current_tenant() AND contact_id=$1 AND active ORDER BY kind,created_at,id LIMIT 20",
      [contactId],
    );
    const counts = { email: 0, phone: 0 };
    return {
      contactId,
      channels: rows.rows.map((row) => {
        const kind = row.kind as "email" | "phone";
        return {
          id: row.id,
          kind,
          label: `${kind === "email" ? "Email" : "Phone"} channel ${++counts[kind]}`,
        };
      }),
    };
  }
}
