import type { PoolClient } from "pg";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { assertUuid, CrmService } from "./crm-service";
import { cursorBinding, decodeCursor, encodeCursor } from "./cursors";

type Schemas = components["schemas"];
type Row = Record<string, any>;
const model = (row: Row): Schemas["Ticket"] => ({
  id: row.id,
  subject: row.subject,
  category: row.category,
  description: row.description,
  state: row.state,
  version: Number(row.row_version),
});
export class SupportService {
  constructor(
    private readonly client: PoolClient,
    private readonly context: TenantContext,
    private readonly traceId: string,
  ) {}
  async list(query: Record<string, unknown>) {
    requirePermission(this.context, "support.read");
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
    const binding = cursorBinding(this.context, "support.tickets", "own", {});
    const cursor = decodeCursor(query.cursor, binding);
    if (cursor) assertUuid(cursor);
    const result = await this.client.query(
      "SELECT * FROM app.ticket WHERE requester_member_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3",
      [this.context.memberId, cursor, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map(model),
      nextCursor: hasMore ? encodeCursor(rows.at(-1)!.id, binding) : null,
      hasMore,
    };
  }
  async get(id: string) {
    requirePermission(this.context, "support.read");
    assertUuid(id);
    const result = await this.client.query(
      "SELECT * FROM app.ticket WHERE id=$1 AND requester_member_id=$2",
      [id, this.context.memberId],
    );
    if (!result.rowCount)
      throw new AccessError(404, "resource_unavailable", "Ticket unavailable or outside your request scope.");
    return model(result.rows[0]);
  }
  async create(body: Schemas["TicketWrite"]) {
    requirePermission(this.context, "support.write");
    if (!body.subject.trim() || !body.description.trim())
      throw new AccessError(422, "empty_text", "Subject and description cannot be empty.");
    const result = await this.client.query(
      `INSERT INTO app.ticket(tenant_id,requester_member_id,subject,category,description,state)VALUES($1,$2,$3,$4,$5,'open')RETURNING *`,
      [
        this.context.organizationId,
        this.context.memberId,
        body.subject.trim(),
        body.category,
        body.description.trim(),
      ],
    );
    const ticket = result.rows[0];
    await this.client.query(
      `INSERT INTO app.ticket_event(tenant_id,ticket_id,actor_ref,kind)VALUES($1,$2,$3,'created')`,
      [this.context.organizationId, ticket.id, this.context.userId],
    );
    await new CrmService(this.client, this.context, this.traceId).audit(
      "ticket.created",
      "ticket",
      ticket.id,
      1,
    );
    return { body: model(ticket), status: 201, etag: '"1"' };
  }
}
