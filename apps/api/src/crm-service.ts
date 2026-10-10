import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import type { PoolClient } from "pg";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { validateSchema } from "./contract-validation";
import * as models from "./models";
import { cursorBinding, decodeCursor, encodeCursor } from "./cursors";
import { assertDelegation } from "../../../packages/auth/permissions";
import { requireEntitlement } from "../../../packages/auth/entitlements";
import { dashboardClockInstant, dashboardUtcPeriod } from "./dashboard-time";
import { parseContactQuery } from "./contact-query";
import { contactCommandJson, contactReceipt, contactRevision, prepareContactPatch } from "./contact-command";
import {
  capturePostJson,
  contactPostReceipt,
  leadPostReceipt,
  prepareCapturePost,
  type CapturePostCommand,
} from "./capture-post-command";

type Row = Record<string, any>;
type Body = Record<string, any>;
type Scope = "own" | "team" | "organization";
type Mutation = { body: unknown; status: number; etag?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function assertUuid(value: string) {
  if (!uuid.test(value)) throw new AccessError(422, "uuid_invalid", "Valid UUID required.");
}
function notFound(): never {
  throw new AccessError(404, "resource_unavailable", "Resource unavailable or out of scope.");
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stable(val)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function requireVersion(row: Row, supplied: string | undefined) {
  if (!supplied) throw new AccessError(400, "revision_required", "If-Match revision required.");
  const matched = /^(?:"(\d+)"|(\d+))$/.exec(supplied);
  if (!matched || supplied.length > 100)
    throw new AccessError(400, "revision_invalid", "Invalid If-Match revision.");
  const value = matched[1] ?? matched[2];
  if (Number(value) !== Number(row.row_version))
    throw new AccessError(412, "revision_changed", "Resource changed. Reload before retrying.");
}
function text(value: string) {
  if (!value.trim()) throw new AccessError(422, "empty_text", "Text cannot be empty.");
  return value.trim();
}
function timezone(value: string) {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    (value !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))
  )
    throw new AccessError(422, "timezone_invalid", "A valid named IANA timezone is required.");
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    if (typeof resolved !== "string" || (resolved !== "UTC" && !resolved.includes("/"))) throw new Error();
  } catch {
    throw new AccessError(422, "timezone_invalid", "A valid named IANA timezone is required.");
  }
  return value;
}

function detachedReadContext(value: TenantContext, subject: "reporting" | "contact"): TenantContext {
  const invalid = (): never => {
    throw new AccessError(403, "permission_denied", `Current ${subject} authority is required.`);
  };
  const ownObject = (input: unknown): input is Record<string, unknown> => {
    if (!input || typeof input !== "object" || types.isProxy(input)) return false;
    const prototype = Object.getPrototypeOf(input);
    return prototype === null || prototype === Object.prototype;
  };
  const data = (input: Record<string, unknown>, names: string[], exact = true) => {
    const result: Record<string, unknown> = Object.create(null);
    if (exact) {
      const keys = Reflect.ownKeys(input);
      if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !names.includes(key)))
        return invalid();
    }
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
      result[name] = descriptor.value;
    }
    return result;
  };
  if (!ownObject(value)) return invalid();
  // Verified request contexts can also contain session metadata; copy only the tenant authority fields.
  const context = data(
    value,
    ["userId", "organizationId", "memberId", "roleId", "roleName", "permissions", "timezone"],
    false,
  );
  for (const key of ["userId", "organizationId", "memberId", "roleId"])
    if (typeof context[key] !== "string" || !uuid.test(context[key])) return invalid();
  if (
    typeof context.roleName !== "string" ||
    !context.roleName ||
    context.roleName.length > 255 ||
    typeof context.timezone !== "string" ||
    !context.timezone ||
    context.timezone.length > 80
  )
    return invalid();
  const raw = context.permissions;
  if (types.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
    return invalid();
  const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
  if (!Number.isInteger(length) || length < 0 || length > 100 || Reflect.ownKeys(raw).length !== length + 1)
    return invalid();
  const permissions: TenantContext["permissions"] = [];
  const codes = new Set<string>();
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !ownObject(descriptor.value))
      return invalid();
    const grant = data(descriptor.value, ["code", "scope"]);
    if (
      typeof grant.code !== "string" ||
      !grant.code ||
      grant.code.length > 120 ||
      codes.has(grant.code) ||
      (grant.scope !== "own" && grant.scope !== "team" && grant.scope !== "organization")
    )
      return invalid();
    codes.add(grant.code);
    permissions.push({ code: grant.code, scope: grant.scope });
  }
  // Freeze the private detached context so source helpers cannot observe caller mutations after waits.
  for (const grant of permissions) Object.freeze(grant);
  Object.freeze(permissions);
  return Object.freeze({ ...context, permissions }) as TenantContext;
}

function permissionGrantJson(permissions: TenantContext["permissions"]): string {
  // Only validated primitive fields enter JSON encoding; inherited object/array hooks are never read.
  let result = "[";
  for (let index = 0; index < permissions.length; index++) {
    const grant = permissions[index];
    if (index) result += ",";
    result += `{"code":${JSON.stringify(grant.code)},"scope":${JSON.stringify(grant.scope)}}`;
  }
  return `${result}]`;
}

export class CrmService {
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    readonly traceId: string,
  ) {}

  private memberScope(column: string, scope: Scope, memberPlaceholder: string) {
    if (scope === "organization") return "TRUE";
    if (scope === "own") return `${column}=${memberPlaceholder}`;
    return `EXISTS(SELECT 1 FROM app.office_member target JOIN app.office_member mine ON mine.tenant_id=target.tenant_id AND mine.office_id=target.office_id WHERE target.member_id=${column} AND mine.member_id=${memberPlaceholder})`;
  }

  private scopeSql(resource: string, scope: Scope, memberPlaceholder: string) {
    if (resource === "leads") return this.memberScope("r.owner_member_id", scope, memberPlaceholder);
    if (resource === "tasks") return this.memberScope("r.assignee_member_id", scope, memberPlaceholder);
    if (resource === "contacts" && scope !== "organization") {
      const assigned = this.memberScope("l.owner_member_id", scope, memberPlaceholder);
      return `((r.created_by_member_id=${memberPlaceholder} AND NOT EXISTS(SELECT 1 FROM app.lead l WHERE l.contact_id=r.id AND l.archived_at IS NULL)) OR EXISTS(SELECT 1 FROM app.lead l WHERE l.contact_id=r.id AND l.archived_at IS NULL AND ${assigned}))`;
    }
    return "TRUE";
  }

  private taskLeadScope(permission: "crm.leads.read" | "crm.leads.write"): Scope | null {
    const scope = this.context.permissions.find((grant) => grant.code === permission)?.scope;
    return scope === "own" || scope === "team" || scope === "organization" ? scope : null;
  }

  private taskLeadPredicate(memberPlaceholder: string, writing = false) {
    const permissions = writing
      ? (["crm.leads.read", "crm.leads.write"] as const)
      : (["crm.leads.read"] as const);
    const clauses = ["l.archived_at IS NULL", "c.archived_at IS NULL"];
    for (const permission of permissions) {
      const scope = this.taskLeadScope(permission);
      if (!scope) return "FALSE";
      clauses.push(this.memberScope("l.owner_member_id", scope, memberPlaceholder));
      // A supplied/stale source scope cannot stand in for the current actor's actual role grant.
      clauses.push(`EXISTS(SELECT 1 FROM app.membership source_member
        JOIN app.role_definition source_role ON(source_role.tenant_id,source_role.id)=(source_member.tenant_id,source_member.role_id)
        WHERE source_member.tenant_id=l.tenant_id AND source_member.user_id=app.current_actor()
          AND source_member.id=${memberPlaceholder} AND source_member.status='active'
          AND source_role.permission_grants @> '[{"code":"${permission}","scope":"${scope}"}]'::jsonb)`);
    }
    return clauses.join(" AND ");
  }

  private taskSourceSql(memberPlaceholder: string, writing = false) {
    return `(r.lead_id IS NULL OR EXISTS(SELECT 1 FROM app.lead l
      JOIN app.contact c ON(c.tenant_id,c.id)=(l.tenant_id,l.contact_id)
      WHERE(l.tenant_id,l.id)=(r.tenant_id,r.lead_id) AND ${this.taskLeadPredicate(memberPlaceholder, writing)}))`;
  }

  private async taskAuthority(writing = false): Promise<Scope> {
    const permission = writing ? "crm.tasks.write" : "crm.tasks.read";
    const scope = requirePermission(this.context, permission);
    if (!["own", "team", "organization"].includes(scope))
      throw new AccessError(403, "permission_denied", "Current task authority is required.");
    const current = await this.client.query(
      `SELECT 1 FROM app.membership m
       JOIN app.role_definition task_role ON(task_role.tenant_id,task_role.id)=(m.tenant_id,m.role_id)
       JOIN app.organization o ON o.id=m.tenant_id
       WHERE current_user='estate_runtime' AND session_user='estate_runtime'
         AND app.current_tenant()=$1::uuid AND app.current_actor()=$2::uuid
         AND m.tenant_id=$1 AND m.user_id=$2 AND m.id=$3 AND m.role_id=$4
         AND m.status='active' AND o.status='active' AND task_role.permission_grants @> $5::jsonb
       FOR SHARE OF m,task_role,o`,
      [
        this.context.organizationId,
        this.context.userId,
        this.context.memberId,
        this.context.roleId,
        permissionGrantJson([{ code: permission, scope }]),
      ],
    );
    if (!current.rowCount)
      throw new AccessError(403, "permission_denied", "Current task authority is unavailable.");
    await requireEntitlement(this.client, permission);
    await requireEntitlement(this.client, permission, { lock: false });
    return scope;
  }

  private async lockTaskSources(ids: (string | null | undefined)[]) {
    const sources = [...new Set(ids.filter((id): id is string => id != null))].sort();
    for (const id of sources) {
      assertUuid(id);
      const statement = `SELECT l.id,l.owner_member_id FROM app.lead l
        JOIN app.contact c ON(c.tenant_id,c.id)=(l.tenant_id,l.contact_id)
        WHERE l.tenant_id=app.current_tenant() AND l.id=$1 AND $2::uuid IS NOT NULL
          AND ${this.taskLeadPredicate("$2", true)}`;
      const parameters = [id, this.context.memberId];
      const locked = await this.client.query(`${statement} FOR SHARE OF l,c`, parameters);
      const source = locked.rows[0] ?? notFound();
      if ([this.taskLeadScope("crm.leads.read"), this.taskLeadScope("crm.leads.write")].includes("team"))
        await this.client.query(
          `SELECT office_id,member_id FROM app.office_member WHERE tenant_id=app.current_tenant()
           AND member_id=ANY($1::uuid[]) ORDER BY office_id,member_id FOR SHARE`,
          [[this.context.memberId, source.owner_member_id]],
        );
      // Re-evaluate after waited source/office locks; an earlier WHERE test is not use-time proof.
      if (!(await this.client.query(statement, parameters)).rowCount) notFound();
    }
    await requireEntitlement(this.client, "crm.tasks.write", { lock: false });
  }

  private resource(resource: string) {
    const resources: Record<
      string,
      { table: string; mapper: (row: Row) => unknown; read: string; write: string }
    > = {
      contacts: {
        table: "contact",
        mapper: models.contact,
        read: "crm.contacts.read",
        write: "crm.contacts.write",
      },
      leads: { table: "lead", mapper: models.lead, read: "crm.leads.read", write: "crm.leads.write" },
      tasks: { table: "task", mapper: models.task, read: "crm.tasks.read", write: "crm.tasks.write" },
      members: { table: "membership", mapper: models.member, read: "members.read", write: "members.manage" },
      roles: { table: "role_definition", mapper: models.role, read: "roles.read", write: "roles.write" },
      "pipeline-stages": {
        table: "pipeline_stage",
        mapper: models.stage,
        read: "crm.pipeline.read",
        write: "crm.pipeline.write",
      },
      "lead-sources": {
        table: "lead_source",
        mapper: models.source,
        read: "crm.sources.read",
        write: "crm.sources.write",
      },
    };
    return resources[resource] ?? notFound();
  }

  private select(resource: string) {
    return resource === "contacts"
      ? `r.*, ARRAY(SELECT c.normalized_value FROM app.contact_channel c WHERE c.contact_id=r.id AND c.kind='email' AND c.active ORDER BY c.is_primary DESC,c.created_at,c.id) AS emails, ARRAY(SELECT c.normalized_value FROM app.contact_channel c WHERE c.contact_id=r.id AND c.kind='phone' AND c.active ORDER BY c.is_primary DESC,c.created_at,c.id) AS phones`
      : "r.*";
  }

  async row(resource: string, id: string, writing = false, lock = false) {
    assertUuid(id);
    const configuration = this.resource(resource);
    const scope =
      resource === "tasks"
        ? await this.taskAuthority(writing)
        : requirePermission(this.context, writing ? configuration.write : configuration.read);
    const archived = ["contacts", "leads"].includes(resource) ? "AND r.archived_at IS NULL" : "";
    const statement = `SELECT ${this.select(resource)} FROM app.${configuration.table} r WHERE r.tenant_id=app.current_tenant() AND r.id=$1 AND $2::uuid IS NOT NULL AND ${this.scopeSql(resource, scope, "$2")} ${resource === "tasks" ? `AND ${this.taskSourceSql("$2", writing)}` : ""} ${archived}`;
    const parameters = [id, this.context.memberId];
    const result = await this.client.query(`${statement} ${lock ? "FOR UPDATE OF r" : ""}`, parameters);
    let row = result.rows[0] ?? notFound();
    if (resource === "tasks") {
      if (writing && lock) {
        if (scope === "team")
          await this.client.query(
            `SELECT office_id,member_id FROM app.office_member WHERE tenant_id=app.current_tenant()
             AND member_id=ANY($1::uuid[]) ORDER BY office_id,member_id FOR SHARE`,
            [[this.context.memberId, row.assignee_member_id]],
          );
        await this.lockTaskSources([row.lead_id]);
        // A lock wait can outlive the current assignee's team relationship, even for standalone tasks.
        // Recheck the original task before any proposed replacement assignee can be considered.
        row = (await this.client.query(statement, parameters)).rows[0] ?? notFound();
      }
      await requireEntitlement(this.client, writing ? configuration.write : configuration.read, {
        lock: false,
      });
    }
    return row;
  }

  async detail(resource: string, id: string) {
    return this.resource(resource).mapper(await this.row(resource, id));
  }

  async list(resource: string, query: Record<string, unknown>) {
    if (resource === "contacts") return this.listContacts(query);
    const configuration = this.resource(resource);
    const scope =
      resource === "tasks" ? await this.taskAuthority() : requirePermission(this.context, configuration.read);
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
    let filter: Body = {};
    if (query.filter) {
      try {
        filter = JSON.parse(String(query.filter));
      } catch {
        throw new AccessError(422, "filter_invalid", "Filter must be valid JSON.");
      }
      validateSchema("LeadFilter", filter);
    }
    const supportedFilters: Record<string, string[]> = {
      contacts: ["q", "ownerMemberId", "tagIds"],
      leads: ["q", "ownerMemberId", "stageId", "sourceId", "intent", "tagIds"],
      tasks: ["q", "ownerMemberId"],
    };
    if (
      Object.keys(filter).some(
        (key) =>
          !(supportedFilters[resource] ?? []).includes(key) && !(key === "tagIds" && !filter[key]?.length),
      )
    )
      throw new AccessError(422, "filter_not_available", "This filter is not implemented for this resource.");
    const binding = cursorBinding(this.context, resource, scope, filter);
    const cursor = decodeCursor(query.cursor, binding);
    if (cursor) assertUuid(cursor);
    const params: unknown[] = [this.context.memberId, cursor, limit + 1];
    const where = [
      "r.tenant_id=app.current_tenant()",
      "$1::uuid IS NOT NULL",
      this.scopeSql(resource, scope, "$1"),
      "($2::uuid IS NULL OR r.id>$2::uuid)",
    ];
    if (["contacts", "leads"].includes(resource)) where.push("r.archived_at IS NULL");
    if (resource === "tasks") where.push(this.taskSourceSql("$1"));
    if (filter.q) {
      params.push(`%${String(filter.q).replace(/[\\%_]/g, "\\$&")}%`);
      where.push(
        resource === "leads"
          ? `EXISTS(SELECT 1 FROM app.contact c WHERE c.id=r.contact_id AND c.display_name ILIKE $${params.length} ESCAPE '\\')`
          : resource === "contacts"
            ? `r.display_name ILIKE $${params.length} ESCAPE '\\'`
            : resource === "tasks"
              ? `r.title ILIKE $${params.length} ESCAPE '\\'`
              : "TRUE",
      );
    }
    for (const [field, column] of [
      ["stageId", "stage_id"],
      ["ownerMemberId", "owner_member_id"],
      ["sourceId", "source_id"],
      ["intent", "intent"],
    ]) {
      if (filter[field] && resource === "leads") {
        params.push(filter[field]);
        where.push(`r.${column}=$${params.length}`);
      }
    }
    if (filter.ownerMemberId && resource === "tasks") {
      params.push(filter.ownerMemberId);
      where.push(`r.assignee_member_id=$${params.length}`);
    }
    if (filter.ownerMemberId && resource === "contacts") {
      params.push(filter.ownerMemberId);
      where.push(
        `((r.created_by_member_id=$${params.length} AND NOT EXISTS(SELECT 1 FROM app.lead l WHERE l.contact_id=r.id AND l.archived_at IS NULL)) OR EXISTS(SELECT 1 FROM app.lead l WHERE l.contact_id=r.id AND l.archived_at IS NULL AND l.owner_member_id=$${params.length}))`,
      );
    }
    if (filter.tagIds?.length) {
      requirePermission(this.context, "crm.tags.read");
      if (new Set(filter.tagIds).size !== filter.tagIds.length)
        throw new AccessError(422, "tag_duplicate", "Each tag filter may appear once.");
      const tags = await this.client.query(
        "SELECT id FROM app.tag WHERE tenant_id=app.current_tenant() AND id=ANY($1::uuid[])",
        [filter.tagIds],
      );
      if (tags.rowCount !== filter.tagIds.length)
        throw new AccessError(422, "tag_invalid", "Tag filters must belong to this organization.");
      params.push(filter.tagIds);
      const tagsParam = `$${params.length}::uuid[]`;
      if (resource === "leads")
        where.push(
          `(SELECT count(*) FROM app.lead_tag lt WHERE lt.tenant_id=app.current_tenant() AND lt.lead_id=r.id AND lt.tag_id=ANY(${tagsParam}))=cardinality(${tagsParam})`,
        );
      else if (resource === "contacts") {
        const leadScope = requirePermission(this.context, "crm.leads.read");
        where.push(
          `EXISTS(SELECT 1 FROM app.lead l WHERE l.tenant_id=app.current_tenant() AND l.contact_id=r.id AND l.archived_at IS NULL AND ${this.scopeSql("leads", leadScope, "$1").replaceAll("r.owner_member_id", "l.owner_member_id")} AND (SELECT count(*) FROM app.lead_tag lt WHERE lt.tenant_id=l.tenant_id AND lt.lead_id=l.id AND lt.tag_id=ANY(${tagsParam}))=cardinality(${tagsParam}))`,
        );
      }
    }
    const result = await this.client.query(
      `SELECT ${this.select(resource)} FROM app.${configuration.table} r WHERE ${where.join(" AND ")} ORDER BY r.id LIMIT $3`,
      params,
    );
    if (resource === "tasks") await requireEntitlement(this.client, configuration.read, { lock: false });
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    if (resource === "pipeline-stages") rows.sort((a, b) => a.position - b.position);
    return {
      items: rows.map(configuration.mapper),
      nextCursor: hasMore ? encodeCursor(rows.at(-1)!.id, binding) : null,
      hasMore,
    };
  }

  private async listContacts(query: unknown): Promise<components["schemas"]["PageContact"]> {
    const { limit, cursor: suppliedCursor, filter } = parseContactQuery(query);
    const context = detachedReadContext(this.context, "contact");
    const current = new CrmService(this.client, context, this.traceId);
    const scope = requirePermission(context, "crm.contacts.read");
    const leadScope = filter.tagIds?.length ? requirePermission(context, "crm.leads.read") : null;
    if (filter.tagIds?.length) requirePermission(context, "crm.tags.read");
    const authority = `SELECT 1 FROM app.membership m
      JOIN app.role_definition r ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)
      JOIN app.organization o ON o.id=m.tenant_id
      WHERE session_user='estate_runtime' AND current_user='estate_runtime'
        AND app.current_tenant()=$1::uuid AND app.current_actor()=$2::uuid
        AND m.tenant_id=$1 AND m.user_id=$2 AND m.id=$3 AND m.role_id=$4
        AND m.status='active' AND o.status='active' AND r.permission_grants=$5::jsonb
        AND r.name=$6 AND o.timezone=$7`;
    const parameters = [
      context.organizationId,
      context.userId,
      context.memberId,
      context.roleId,
      permissionGrantJson(context.permissions),
      context.roleName,
      context.timezone,
    ];
    const assertAuthority = async (lock = false) => {
      if (!(await this.client.query(`${authority}${lock ? " FOR SHARE OF m,r,o" : ""}`, parameters)).rowCount)
        throw new AccessError(403, "permission_denied", "Current contact authority is unavailable.");
    };
    await assertAuthority(true);
    await requireEntitlement(this.client, "crm.contacts.read");
    if (scope === "team" || leadScope === "team")
      await this.client.query(
        `SELECT office_id,member_id FROM app.office_member WHERE tenant_id=app.current_tenant()
         AND member_id=$1 ORDER BY office_id,member_id FOR SHARE`,
        [context.memberId],
      );
    await assertAuthority();
    await requireEntitlement(this.client, "crm.contacts.read", { lock: false });
    // Version the contact binding only. Own detached data enters a primitive-only canonical serializer.
    const binding = createHash("sha256")
      .update(
        stable({
          binding: "contact-list:v2",
          tenant: context.organizationId,
          actor: context.userId,
          member: context.memberId,
          role: context.roleId,
          permissions: context.permissions,
          resource: "contacts",
          scope,
          sort: "id:asc",
          filter,
        }),
      )
      .digest("hex");
    const cursor = decodeCursor(suppliedCursor, binding);
    if (cursor) assertUuid(cursor);
    const params: unknown[] = [context.memberId, cursor, limit + 1];
    const where = [
      "r.tenant_id=app.current_tenant()",
      "$1::uuid IS NOT NULL",
      current.scopeSql("contacts", scope, "$1"),
      "r.archived_at IS NULL",
      "($2::uuid IS NULL OR r.id>$2::uuid)",
    ];
    if (filter.q) {
      params.push(`%${filter.q.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(`r.display_name ILIKE $${params.length} ESCAPE '\\'`);
    }
    if (filter.ownerMemberId) {
      params.push(filter.ownerMemberId);
      where.push(
        `((r.created_by_member_id=$${params.length} AND NOT EXISTS(SELECT 1 FROM app.lead l WHERE l.contact_id=r.id AND l.archived_at IS NULL)) OR EXISTS(SELECT 1 FROM app.lead l WHERE l.contact_id=r.id AND l.archived_at IS NULL AND l.owner_member_id=$${params.length}))`,
      );
    }
    if (filter.tagIds?.length) {
      if (new Set(filter.tagIds).size !== filter.tagIds.length)
        throw new AccessError(422, "tag_duplicate", "Each tag filter may appear once.");
      const tags = await this.client.query(
        "SELECT id FROM app.tag WHERE tenant_id=app.current_tenant() AND id=ANY($1::uuid[])",
        [filter.tagIds],
      );
      if (tags.rowCount !== filter.tagIds.length)
        throw new AccessError(422, "tag_invalid", "Tag filters must belong to this organization.");
      params.push(filter.tagIds);
      const tagsParam = `$${params.length}::uuid[]`;
      where.push(
        `EXISTS(SELECT 1 FROM app.lead l WHERE l.tenant_id=app.current_tenant() AND l.contact_id=r.id AND l.archived_at IS NULL AND ${current.scopeSql("leads", leadScope!, "$1").replaceAll("r.owner_member_id", "l.owner_member_id")} AND (SELECT count(*) FROM app.lead_tag lt WHERE lt.tenant_id=l.tenant_id AND lt.lead_id=l.id AND lt.tag_id=ANY(${tagsParam}))=cardinality(${tagsParam}))`,
      );
    }
    const result = await this.client.query(
      `SELECT ${current.select("contacts")} FROM app.contact r WHERE ${where.join(" AND ")} ORDER BY r.id LIMIT $3`,
      params,
    );
    await assertAuthority();
    await requireEntitlement(this.client, "crm.contacts.read", { lock: false });
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map(models.contact),
      nextCursor: hasMore ? encodeCursor(rows.at(-1)!.id, binding) : null,
      hasMore,
    };
  }

  private async contactCommandAuthority(lock = false) {
    const context = this.context;
    const result = await this.client.query(
      `SELECT 1 FROM app.membership m
       JOIN app.role_definition r ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)
       JOIN app.organization o ON o.id=m.tenant_id
       WHERE session_user='estate_runtime' AND current_user='estate_runtime'
         AND app.current_tenant()=$1::uuid AND app.current_actor()=$2::uuid
         AND m.tenant_id=$1 AND m.user_id=$2 AND m.id=$3 AND m.role_id=$4
         AND m.status='active' AND o.status='active' AND r.permission_grants=$5::jsonb
         AND r.name=$6 AND o.timezone=$7 ${lock ? "FOR SHARE OF m,r,o" : ""}`,
      [
        context.organizationId,
        context.userId,
        context.memberId,
        context.roleId,
        permissionGrantJson(context.permissions),
        context.roleName,
        context.timezone,
      ],
    );
    if (!result.rowCount)
      throw new AccessError(403, "permission_denied", "Current contact authority is unavailable.");
  }

  /** Contact PATCH owns its exact request/receipt boundary; other generic commands retain their protocol. */
  async patchContact(
    id: string,
    body: unknown,
    expectedVersion: string | undefined,
    key: string | undefined,
    routeKey: string,
  ): Promise<Mutation> {
    const context = detachedReadContext(this.context, "contact");
    const command = prepareContactPatch(id, body, expectedVersion, key, routeKey, context.organizationId);
    const current = new CrmService(this.client, context, this.traceId);
    const readScope = requirePermission(context, "crm.contacts.read");
    const writeScope = requirePermission(context, "crm.contacts.write");
    const source = `SELECT r.* FROM app.contact r
      WHERE r.tenant_id=app.current_tenant() AND r.id=$1 AND r.archived_at IS NULL
        AND ${current.scopeSql("contacts", readScope, "$2")}
        AND ${current.scopeSql("contacts", writeScope, "$2")} AND $2::uuid IS NOT NULL`;
    const sourceParameters = [command.id, context.memberId];
    await current.contactCommandAuthority(true);
    await requireEntitlement(this.client, "crm.contacts.write");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${context.organizationId}:${context.userId}:${command.routeKey}:${command.key}`,
    ]);
    // Explicit FOR UPDATE also prevents a new lead's FK from changing creator/no-active-lead scope.
    if (!(await this.client.query(`${source} FOR UPDATE OF r`, sourceParameters)).rowCount) notFound();
    const leads = await this.client.query(
      "SELECT id,owner_member_id FROM app.lead WHERE tenant_id=app.current_tenant() AND contact_id=$1 ORDER BY id FOR SHARE",
      [command.id],
    );
    if (readScope === "team" || writeScope === "team") {
      const members = new Set<string>([context.memberId]);
      for (const lead of leads.rows) if (lead.owner_member_id) members.add(lead.owner_member_id);
      await this.client.query(
        `SELECT office_id,member_id FROM app.office_member WHERE tenant_id=app.current_tenant()
         AND member_id=ANY($1::uuid[]) ORDER BY office_id,member_id FOR SHARE`,
        [[...members]],
      );
    }
    const authorized = (await this.client.query(source, sourceParameters)).rows[0] ?? notFound();
    await current.contactCommandAuthority();
    await requireEntitlement(this.client, "crm.contacts.write", { lock: false });
    const version = contactRevision(authorized.row_version);
    const receipts = await this.client.query(
      `SELECT request_hash,response_body,status_code,response_etag,
              expires_at>clock_timestamp() AS unexpired
       FROM app.idempotency_record WHERE tenant_id=app.current_tenant()
         AND actor_ref=$1 AND route_key=$2 AND key=$3`,
      [context.userId, command.routeKey, command.key],
    );
    if (receipts.rowCount) {
      const receipt = receipts.rows[0];
      if (receipt.request_hash !== command.requestHash)
        throw new AccessError(
          409,
          "idempotency_conflict",
          "This idempotency key was used with a different request.",
        );
      if (!receipt.unexpired)
        throw new AccessError(
          409,
          "receipt_expired",
          "The original command receipt has expired. Review the current record.",
        );
      const historical = contactReceipt(receipt.response_body, command);
      const etag = `"${historical.version}"`;
      if (receipt.status_code !== 200 || (receipt.response_etag !== null && receipt.response_etag !== etag))
        throw new AccessError(503, "receipt_unavailable", "The saved command receipt is unavailable.");
      await current.contactCommandAuthority();
      await requireEntitlement(this.client, "crm.contacts.write", { lock: false });
      const expiry = await this.client.query(
        `SELECT receipt.expires_at>clock_timestamp() AS unexpired,
          EXISTS(SELECT 1 FROM app.entitlement capability WHERE capability.tenant_id=app.current_tenant()
            AND capability.feature='crm' AND capability.state='enabled'
            AND(capability.effective_until IS NULL OR capability.effective_until>clock_timestamp())) AS crm_enabled
         FROM app.idempotency_record receipt WHERE receipt.tenant_id=app.current_tenant()
         AND receipt.actor_ref=$1 AND receipt.route_key=$2 AND receipt.key=$3`,
        [context.userId, command.routeKey, command.key],
      );
      if (expiry.rowCount && !expiry.rows[0].crm_enabled)
        throw new AccessError(
          403,
          "entitlement_disabled",
          "This organization does not have an active capability for this operation.",
        );
      if (!expiry.rowCount || !expiry.rows[0].unexpired)
        throw new AccessError(
          409,
          "receipt_expired",
          "The original command receipt has expired. Review the current record.",
        );
      return { body: historical, status: 200, etag };
    }
    if (version !== command.version)
      throw new AccessError(412, "revision_changed", "Resource changed. Reload before retrying.");
    if (version >= Number.MAX_SAFE_INTEGER)
      throw new AccessError(409, "revision_exhausted", "Contact revision cannot be advanced.");
    const updated = await this.client.query(
      `UPDATE app.contact SET display_name=$1,birthday=$2,updated_at=now(),row_version=row_version+1
       WHERE tenant_id=app.current_tenant() AND id=$3 AND row_version=$4 RETURNING row_version`,
      [
        command.body.displayName.trim(),
        command.body.birthday === undefined ? authorized.birthday : command.body.birthday,
        command.id,
        String(version),
      ],
    );
    if (updated.rowCount !== 1 || contactRevision(updated.rows[0]?.row_version) !== version + 1)
      throw new AccessError(412, "revision_changed", "Resource changed. Reload before retrying.");
    await current.channels(command.id, command.body, true);
    const projection =
      (
        await this.client.query(
          `SELECT ${current.select("contacts")} FROM app.contact r WHERE r.tenant_id=app.current_tenant()
       AND r.id=$1 AND r.archived_at IS NULL AND ${current.scopeSql("contacts", readScope, "$2")}
       AND ${current.scopeSql("contacts", writeScope, "$2")} AND $2::uuid IS NOT NULL`,
          sourceParameters,
        )
      ).rows[0] ?? notFound();
    const contact = contactReceipt(models.contact(projection), command);
    const etag = `"${contact.version}"`;
    await this.client.query(
      `INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff)
       VALUES($1,$2,'contact.updated','contact',$3,$4,$5)`,
      [
        context.organizationId,
        context.userId,
        contact.id,
        current.traceId,
        `{"resourceVersion":${JSON.stringify(contact.version)}}`,
      ],
    );
    await this.client.query(
      `INSERT INTO app.idempotency_record
       (tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,200,$7,now()+interval '1 day')`,
      [
        context.organizationId,
        context.userId,
        command.routeKey,
        command.key,
        command.requestHash,
        contactCommandJson(contact),
        etag,
      ],
    );
    await current.contactCommandAuthority();
    await requireEntitlement(this.client, "crm.contacts.write", { lock: false });
    return { body: contact, status: 200, etag };
  }

  private async beginCapturePost(command: CapturePostCommand) {
    await this.contactCommandAuthority(true);
    await requireEntitlement(this.client, `crm.${command.resource}.write`);
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${command.routeKey}:${command.key}`,
    ]);
    await this.contactCommandAuthority();
    await requireEntitlement(this.client, `crm.${command.resource}.write`, { lock: false });
    const receipts = await this.client.query(
      `SELECT request_hash,response_body,status_code,response_etag,expires_at>clock_timestamp() AS unexpired
       FROM app.idempotency_record WHERE tenant_id=app.current_tenant()
         AND actor_ref=$1 AND route_key=$2 AND key=$3`,
      [this.context.userId, command.routeKey, command.key],
    );
    const receipt = receipts.rows[0];
    if (!receipt) return null;
    if (receipt.request_hash !== command.requestHash)
      throw new AccessError(
        409,
        "idempotency_conflict",
        "This idempotency key was used with a different request.",
      );
    if (!receipt.unexpired)
      throw new AccessError(409, "receipt_expired", "The original command receipt has expired.");
    if (receipt.status_code !== 201 || (receipt.response_etag !== null && receipt.response_etag !== '"1"'))
      throw new AccessError(503, "receipt_unavailable", "The saved command receipt is unavailable.");
    return receipt;
  }

  private async finishCapturePost(command: CapturePostCommand) {
    await this.contactCommandAuthority();
    const result = await this.client.query(
      `SELECT receipt.expires_at>clock_timestamp() AS unexpired,
        EXISTS(SELECT 1 FROM app.entitlement capability WHERE capability.tenant_id=app.current_tenant()
          AND capability.feature='crm' AND capability.state='enabled'
          AND(capability.effective_until IS NULL OR capability.effective_until>clock_timestamp())) AS crm_enabled
       FROM app.idempotency_record receipt WHERE receipt.tenant_id=app.current_tenant()
         AND receipt.actor_ref=$1 AND receipt.route_key=$2 AND receipt.key=$3`,
      [this.context.userId, command.routeKey, command.key],
    );
    if (result.rowCount && !result.rows[0].crm_enabled)
      throw new AccessError(
        403,
        "entitlement_disabled",
        "This organization does not have an active capability.",
      );
    if (!result.rowCount || !result.rows[0].unexpired)
      throw new AccessError(409, "receipt_expired", "The original command receipt has expired.");
  }

  private async recordCapturePost(command: CapturePostCommand, body: unknown) {
    await this.client.query(
      `INSERT INTO app.idempotency_record
        (tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,201,'"1"',now()+interval '1 day')`,
      [
        this.context.organizationId,
        this.context.userId,
        command.routeKey,
        command.key,
        command.requestHash,
        capturePostJson(body),
      ],
    );
  }

  private captureContactStatement(scope: Scope) {
    return `SELECT r.* FROM app.contact r WHERE r.tenant_id=app.current_tenant()
      AND r.id=$1 AND r.archived_at IS NULL AND $2::uuid IS NOT NULL
      AND ${this.scopeSql("contacts", scope, "$2")}`;
  }

  private async lockCaptureContact(id: string, scope: Scope) {
    const statement = this.captureContactStatement(scope);
    const parameters = [id, this.context.memberId];
    if (!(await this.client.query(`${statement} FOR UPDATE OF r`, parameters)).rowCount) notFound();
    // Contact FOR UPDATE also blocks new lead FK references; all existing links stay stable after SHARE.
    const leads = await this.client.query(
      `SELECT id,contact_id,source_id,stage_id,owner_member_id,archived_at FROM app.lead
       WHERE tenant_id=app.current_tenant() AND contact_id=$1 ORDER BY id FOR SHARE`,
      [id],
    );
    if (scope === "team") {
      const members = new Set<string>([this.context.memberId]);
      for (const lead of leads.rows) if (lead.owner_member_id) members.add(lead.owner_member_id);
      await this.lockCaptureOffices([...members]);
    }
    if (!(await this.client.query(statement, parameters)).rowCount) notFound();
    return leads.rows;
  }

  private async lockCaptureOffices(members: string[]) {
    await this.client.query(
      `SELECT office_id,member_id FROM app.office_member WHERE tenant_id=app.current_tenant()
       AND member_id=ANY($1::uuid[]) ORDER BY office_id,member_id FOR SHARE`,
      [members],
    );
  }

  private captureOwnerStatement(scope: Scope) {
    return `SELECT r.id FROM app.membership r WHERE r.tenant_id=app.current_tenant()
      AND r.id=$1 AND r.status='active' AND $2::uuid IS NOT NULL
      AND ${this.memberScope("r.id", scope, "$2")}`;
  }

  private async captureAudit(resource: "contact" | "lead", id: string) {
    await this.client.query(
      `INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff)
       VALUES($1,$2,$3,$4,$5,$6,'{"resourceVersion":1}')`,
      [this.context.organizationId, this.context.userId, `${resource}.created`, resource, id, this.traceId],
    );
  }

  /** Published Contact POST: a durable creation receipt is independent of current detail. */
  async postContact(
    body: unknown,
    key: string | undefined,
    routeKey: string,
    legacyExpectedVersion?: string,
  ): Promise<Mutation> {
    const context = detachedReadContext(this.context, "contact");
    const command = prepareCapturePost(
      "contacts",
      body,
      key,
      routeKey,
      context.organizationId,
      legacyExpectedVersion,
    );
    const current = new CrmService(this.client, context, this.traceId);
    const scope = requirePermission(context, "crm.contacts.write");
    const saved = await current.beginCapturePost(command);
    if (saved) {
      const receipt = contactPostReceipt(saved.response_body, command);
      await current.lockCaptureContact(receipt.id, scope);
      await current.finishCapturePost(command);
      return { body: receipt, status: 201, etag: '"1"' };
    }
    const inserted = await this.client.query(
      `INSERT INTO app.contact(tenant_id,display_name,birthday,created_by_member_id)
       VALUES($1,$2,$3,$4) RETURNING id`,
      [
        context.organizationId,
        command.body.displayName.trim(),
        command.body.birthday ?? null,
        context.memberId,
      ],
    );
    const id = inserted.rows[0].id;
    await current.channels(id, command.body);
    const projection =
      (
        await this.client.query(
          `SELECT ${current.select("contacts")} FROM app.contact r
       WHERE r.tenant_id=app.current_tenant() AND r.id=$1 AND r.archived_at IS NULL
         AND $2::uuid IS NOT NULL AND ${current.scopeSql("contacts", scope, "$2")}`,
          [id, context.memberId],
        )
      ).rows[0] ?? notFound();
    const receipt = contactPostReceipt(models.contact(projection), command);
    await current.captureAudit("contact", id);
    await current.recordCapturePost(command, receipt);
    await current.finishCapturePost(command);
    return { body: receipt, status: 201, etag: '"1"' };
  }

  /** Published Lead POST; the approved native/import create ports retain their separate transactions. */
  async postLead(
    body: unknown,
    key: string | undefined,
    routeKey: string,
    legacyExpectedVersion?: string,
  ): Promise<Mutation> {
    const context = detachedReadContext(this.context, "contact");
    const command = prepareCapturePost(
      "leads",
      body,
      key,
      routeKey,
      context.organizationId,
      legacyExpectedVersion,
    );
    const current = new CrmService(this.client, context, this.traceId);
    const scope = requirePermission(context, "crm.leads.write");
    const contactScope = requirePermission(context, "crm.contacts.write");
    const saved = await current.beginCapturePost(command);
    const receipt = saved ? leadPostReceipt(saved.response_body, command, context.memberId) : null;
    const leadStatement = `SELECT r.* FROM app.lead r WHERE r.tenant_id=app.current_tenant()
      AND r.id=$1 AND r.archived_at IS NULL AND $2::uuid IS NOT NULL
      AND ${current.scopeSql("leads", scope, "$2")}`;
    const peek = receipt
      ? ((await this.client.query(leadStatement, [receipt.id, context.memberId])).rows[0] ?? notFound())
      : null;
    if (
      peek &&
      (peek.contact_id !== command.body.contactId.toLowerCase() ||
        peek.source_id !== command.body.sourceId.toLowerCase())
    )
      notFound();
    const links = await current.lockCaptureContact(command.body.contactId, contactScope);
    const locked = peek ? (links.find((lead) => lead.id === peek.id) ?? notFound()) : null;
    if (
      locked &&
      (locked.archived_at !== null ||
        locked.contact_id !== peek!.contact_id ||
        locked.source_id !== peek!.source_id ||
        locked.owner_member_id !== peek!.owner_member_id ||
        locked.stage_id !== peek!.stage_id)
    )
      notFound();
    // Historical receipts may retain an earlier owner/stage; only current source authority is used.
    const owner = locked
      ? locked.owner_member_id
      : command.body.ownerMemberId === undefined
        ? context.memberId
        : command.body.ownerMemberId;
    const ownerParameters = [owner, context.memberId];
    const ownerStatement = current.captureOwnerStatement(scope);
    if (owner) {
      assertUuid(owner);
      if (!(await this.client.query(`${ownerStatement} FOR SHARE OF r`, ownerParameters)).rowCount) {
        if (receipt) notFound();
        throw new AccessError(
          422,
          "assignee_invalid",
          "Owner must be an active eligible organization member.",
        );
      }
    } else if (scope !== "organization") {
      if (receipt) notFound();
      throw new AccessError(422, "owner_required", "Own scope requires an assigned owner.");
    }
    if (scope === "team")
      await current.lockCaptureOffices(owner ? [context.memberId, owner] : [context.memberId]);
    const source = await this.client.query(
      "SELECT id FROM app.lead_source WHERE tenant_id=app.current_tenant() AND id=$1 FOR SHARE",
      [command.body.sourceId],
    );
    if (!source.rowCount) {
      if (receipt) notFound();
      throw new AccessError(422, "source_invalid", "Source must belong to this organization.");
    }
    if (!receipt)
      await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${context.organizationId}:pipeline-configuration`,
      ]);
    const stage = await this.client.query(
      receipt
        ? "SELECT id FROM app.pipeline_stage WHERE tenant_id=app.current_tenant() AND id=$1 FOR SHARE"
        : "SELECT id FROM app.pipeline_stage WHERE tenant_id=app.current_tenant() ORDER BY position,id LIMIT 1 FOR SHARE",
      receipt ? [locked!.stage_id] : [],
    );
    if (!stage.rowCount) {
      if (receipt) notFound();
      throw new AccessError(409, "pipeline_unavailable", "Configure a pipeline before capturing leads.");
    }
    if (
      !(
        await this.client.query(current.captureContactStatement(contactScope), [
          command.body.contactId,
          context.memberId,
        ])
      ).rowCount
    )
      notFound();
    if (owner && !(await this.client.query(ownerStatement, ownerParameters)).rowCount) {
      if (receipt) notFound();
      throw new AccessError(422, "assignee_invalid", "Owner must be an active eligible organization member.");
    }
    await current.contactCommandAuthority();
    await requireEntitlement(this.client, "crm.leads.write", { lock: false });
    if (receipt) {
      if (!(await this.client.query(leadStatement, [receipt.id, context.memberId])).rowCount) notFound();
      await current.finishCapturePost(command);
      return { body: receipt, status: 201, etag: '"1"' };
    }
    const firstStage = await this.client.query(
      "SELECT id FROM app.pipeline_stage WHERE tenant_id=app.current_tenant() ORDER BY position,id LIMIT 1",
    );
    if (firstStage.rows[0]?.id !== stage.rows[0].id)
      throw new AccessError(409, "pipeline_changed", "The pipeline changed while creating this lead.");
    const inserted = await this.client.query(
      `INSERT INTO app.lead(tenant_id,contact_id,source_id,stage_id,owner_member_id,intent,timeline,attribution)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        context.organizationId,
        command.body.contactId,
        command.body.sourceId,
        stage.rows[0].id,
        owner,
        command.body.intent,
        command.body.timeline ?? null,
        capturePostJson({ source: "manual-synthetic-workspace", sourceId: command.body.sourceId }),
      ],
    );
    const lead = leadPostReceipt(models.lead(inserted.rows[0]), command, context.memberId);
    if (!(await this.client.query(leadStatement, [lead.id, context.memberId])).rowCount) notFound();
    if (
      !(
        await this.client.query(current.captureContactStatement(contactScope), [
          command.body.contactId,
          context.memberId,
        ])
      ).rowCount
    )
      notFound();
    const eventId = randomUUID();
    const eventClock = await this.client.query(
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS instant",
    );
    const instant = new Date(eventClock.rows[0].instant).toISOString();
    const envelope = capturePostJson({
      eventId,
      type: "lead.captured",
      version: 1,
      tenantId: context.organizationId,
      occurredAt: instant,
      ingestedAt: instant,
      producer: "crm",
      aggregateType: "lead",
      aggregateId: lead.id,
      correlationId: current.traceId,
      payload: { resourceId: lead.id, resourceVersion: 1, relatedResourceIds: [command.body.contactId] },
    });
    await this.client.query(
      `INSERT INTO app.outbox(tenant_id,id,event_type,aggregate_id,payload,initiating_actor_id)
       VALUES($1,$2,'lead.captured',$3,$4,$5)`,
      [context.organizationId, eventId, lead.id, envelope, context.userId],
    );
    await this.client.query(
      `INSERT INTO app.activity_event(tenant_id,lead_id,event_type,source_event_id,occurred_at,safe_data)
       VALUES($1,$2,'lead.captured',$3,now(),$4)`,
      [
        context.organizationId,
        lead.id,
        randomUUID(),
        capturePostJson({ resourceId: lead.id, resourceVersion: 1 }),
      ],
    );
    await current.captureAudit("lead", lead.id);
    await current.recordCapturePost(command, lead);
    await current.finishCapturePost(command);
    return { body: lead, status: 201, etag: '"1"' };
  }

  async idempotent(
    key: string | undefined,
    routeKey: string,
    body: unknown,
    expectedVersion: string | undefined,
    command: () => Promise<Mutation>,
    reauthorizeReplay?: (body: unknown) => Promise<void>,
  ): Promise<Mutation> {
    if (!key || key.length > 100 || !/^[\x21-\x7e]+$/.test(key))
      throw new AccessError(
        400,
        "idempotency_required",
        "A printable Idempotency-Key of at most 100 characters is required.",
      );
    const requestHash = createHash("sha256")
      .update(stable({ body, expectedVersion: expectedVersion ?? null }))
      .digest("hex");
    const lockKey = `${this.context.organizationId}:${this.context.userId}:${routeKey}:${key}`;
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]);
    const existing = await this.client.query(
      "SELECT request_hash,response_body,status_code FROM app.idempotency_record WHERE actor_ref=$1 AND route_key=$2 AND key=$3 AND expires_at>now()",
      [this.context.userId, routeKey, key],
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.request_hash !== requestHash)
        throw new AccessError(
          409,
          "idempotency_conflict",
          "This idempotency key was used with a different request.",
        );
      if (reauthorizeReplay) await reauthorizeReplay(row.response_body);
      const resource = routeKey.split("/")[4];
      const entity = row.response_body;
      // Replays must still have current resource scope after reassignment or revocation.
      const parentId = routeKey.split("/")[5];
      const action = routeKey.split("/")[6];
      if (resource === "leads" && action === "notes") await this.row("leads", parentId, true);
      else if (resource === "tasks" && entity?.id) {
        await this.row("tasks", entity.id, true, true);
        await this.lockTaskSources([entity.leadId, (body as Body | null)?.leadId]);
      } else if (["contacts", "leads"].includes(resource) && entity?.id)
        await this.row(resource, entity.id, true);
      return {
        body: entity,
        status: row.status_code,
        etag: entity?.version ? `"${entity.version}"` : undefined,
      };
    }
    const result = await command();
    await this.client.query(
      `INSERT INTO app.idempotency_record(tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 day')`,
      [
        this.context.organizationId,
        this.context.userId,
        routeKey,
        key,
        requestHash,
        JSON.stringify(result.body),
        result.status,
      ],
    );
    return result;
  }

  async audit(action: string, resource: string, id: string, version: number) {
    await this.client.query(
      `INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        this.context.organizationId,
        this.context.userId,
        action,
        resource,
        id,
        this.traceId,
        JSON.stringify({ resourceVersion: version }),
      ],
    );
  }

  async event(
    type: string,
    resource: string,
    id: string,
    version: number,
    relatedIds: string[] = [],
    producer = "crm",
  ) {
    const eventId = randomUUID();
    const now = new Date().toISOString();
    const payload = {
      eventId,
      type,
      version: 1,
      tenantId: this.context.organizationId,
      occurredAt: now,
      ingestedAt: now,
      producer,
      aggregateType: resource,
      aggregateId: id,
      correlationId: this.traceId,
      payload: { resourceId: id, resourceVersion: version, relatedResourceIds: relatedIds },
    };
    await this.client.query(
      `INSERT INTO app.outbox(tenant_id,id,event_type,aggregate_id,payload,initiating_actor_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [this.context.organizationId, eventId, type, id, JSON.stringify(payload), this.context.userId],
    );
  }

  private async activeMember(id: string, scope: Scope) {
    assertUuid(id);
    const result = await this.client.query(
      `SELECT r.id FROM app.membership r WHERE r.tenant_id=app.current_tenant() AND r.id=$1 AND r.status='active' AND $2::uuid IS NOT NULL AND ${this.memberScope("r.id", scope, "$2")}`,
      [id, this.context.memberId],
    );
    if (!result.rowCount)
      throw new AccessError(
        422,
        "assignee_invalid",
        "Assignee must be an active eligible member of this organization.",
      );
  }

  private async channels(contactId: string, body: Body, patch = false) {
    for (const [field, kind] of [
      ["emails", "email"],
      ["phones", "phone"],
    ]) {
      if (!(field in body)) continue;
      const values = [
        ...new Set(
          (body[field] as string[]).map((value) =>
            kind === "email" ? value.trim().toLowerCase() : value.trim().replace(/[\s().-]/g, ""),
          ),
        ),
      ];
      if (values.some((value) => !value || (kind === "phone" && !/^\+?[0-9]{7,15}$/.test(value))))
        throw new AccessError(
          422,
          "channel_invalid",
          "Phone channels require 7–15 digits with an optional leading +.",
        );
      if (patch)
        await this.client.query(
          "UPDATE app.contact_channel SET active=false WHERE contact_id=$1 AND kind=$2",
          [contactId, kind],
        );
      for (const [index, value] of values.entries())
        await this.client.query(
          `INSERT INTO app.contact_channel(tenant_id,contact_id,kind,normalized_value,is_primary) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,contact_id,kind,normalized_value) DO UPDATE SET active=true,is_primary=EXCLUDED.is_primary`,
          [this.context.organizationId, contactId, kind, value, index === 0],
        );
    }
  }

  /** Trusted MOD-D capture evidence is never accepted from a published request body. */
  async createCapturedLead(
    body: Body,
    evidence: { attribution: Record<string, unknown>; score: number; scoreVersion: string },
  ) {
    return this.create("leads", body, evidence);
  }

  async create(
    resource: string,
    body: Body,
    captureEvidence?: { attribution: Record<string, unknown>; score: number; scoreVersion: string },
  ): Promise<Mutation> {
    const config = this.resource(resource);
    const scope = requirePermission(this.context, config.write);
    let row: Row;
    if (resource === "contacts") {
      const result = await this.client.query(
        `INSERT INTO app.contact(tenant_id,display_name,birthday,created_by_member_id) VALUES($1,$2,$3,$4) RETURNING *`,
        [this.context.organizationId, text(body.displayName), body.birthday ?? null, this.context.memberId],
      );
      row = result.rows[0];
      await this.channels(row.id, body);
      row = await this.row(resource, row.id);
    } else if (resource === "leads") {
      await this.row("contacts", body.contactId, true);
      const owner = body.ownerMemberId === undefined ? this.context.memberId : body.ownerMemberId;
      if (owner) await this.activeMember(owner, scope);
      if (!owner && scope !== "organization")
        throw new AccessError(422, "owner_required", "Own scope requires an assigned owner.");
      const source = await this.client.query("SELECT id FROM app.lead_source WHERE id=$1", [body.sourceId]);
      if (!source.rowCount)
        throw new AccessError(422, "source_invalid", "Source must belong to this organization.");
      const stage = await this.client.query("SELECT id FROM app.pipeline_stage ORDER BY position LIMIT 1");
      if (!stage.rowCount)
        throw new AccessError(409, "pipeline_unavailable", "Configure a pipeline before capturing leads.");
      const result = await this.client.query(
        `INSERT INTO app.lead(tenant_id,contact_id,source_id,stage_id,owner_member_id,intent,timeline,attribution,score,score_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          this.context.organizationId,
          body.contactId,
          body.sourceId,
          stage.rows[0].id,
          owner,
          body.intent,
          body.timeline ?? null,
          JSON.stringify(
            captureEvidence?.attribution ?? { source: "manual-synthetic-workspace", sourceId: body.sourceId },
          ),
          captureEvidence?.score ?? null,
          captureEvidence?.scoreVersion ?? null,
        ],
      );
      row = result.rows[0];
      await this.event("lead.captured", "lead", row.id, Number(row.row_version), [body.contactId]);
      await this.client.query(
        `INSERT INTO app.activity_event(tenant_id,lead_id,event_type,source_event_id,occurred_at,safe_data) VALUES($1,$2,'lead.captured',$3,now(),$4)`,
        [
          this.context.organizationId,
          row.id,
          randomUUID(),
          JSON.stringify({ resourceId: row.id, resourceVersion: 1 }),
        ],
      );
    } else if (resource === "tasks") {
      await this.taskAuthority(true);
      await this.activeMember(body.assigneeMemberId, scope);
      await this.lockTaskSources([body.leadId]);
      const result = await this.client.query(
        `INSERT INTO app.task(tenant_id,lead_id,assignee_member_id,title,description,due_at,due_timezone,priority,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          this.context.organizationId,
          body.leadId ?? null,
          body.assigneeMemberId,
          text(body.title),
          body.description ?? null,
          body.dueAt,
          timezone(body.timezone),
          body.priority ?? "normal",
          body.state ?? "open",
        ],
      );
      row = result.rows[0];
    } else notFound();
    await this.audit(`${config.table}.created`, config.table, row.id, Number(row.row_version));
    return { body: config.mapper(row), status: 201, etag: '"1"' };
  }

  async update(
    resource: string,
    id: string,
    body: Body,
    expectedVersion: string | undefined,
  ): Promise<Mutation> {
    if (resource === "contacts")
      throw new AccessError(
        503,
        "contact_command_required",
        "Contact edits require the verified command boundary.",
      );
    const config = this.resource(resource);
    const scope = requirePermission(this.context, config.write);
    const current = await this.row(resource, id, true, true);
    requireVersion(current, expectedVersion);
    let row: Row;
    if (resource === "leads") {
      const owner = "ownerMemberId" in body ? body.ownerMemberId : current.owner_member_id;
      if (owner) await this.activeMember(owner, scope);
      if (!owner && scope !== "organization")
        throw new AccessError(422, "owner_required", "Own scope requires an assigned owner.");
      const result = await this.client.query(
        `UPDATE app.lead SET owner_member_id=$1,intent=$2,timeline=$3,updated_at=now(),row_version=row_version+1 WHERE id=$4 RETURNING *`,
        [owner, body.intent ?? current.intent, "timeline" in body ? body.timeline : current.timeline, id],
      );
      row = result.rows[0];
      if (owner !== current.owner_member_id)
        await this.event("lead.assigned", "lead", id, Number(row.row_version), owner ? [owner] : []);
    } else if (resource === "tasks") {
      await this.activeMember(body.assigneeMemberId, scope);
      const effectiveLead = body.leadId === undefined ? current.lead_id : body.leadId;
      await this.lockTaskSources([current.lead_id, effectiveLead]);
      const result = await this.client.query(
        `UPDATE app.task SET lead_id=$1,assignee_member_id=$2,title=$3,description=$4,due_at=$5,due_timezone=$6,priority=$7,state=$8,updated_at=now(),row_version=row_version+1 WHERE id=$9 RETURNING *`,
        [
          effectiveLead,
          body.assigneeMemberId,
          text(body.title),
          body.description ?? current.description,
          body.dueAt,
          timezone(body.timezone),
          body.priority ?? current.priority,
          body.state ?? current.state,
          id,
        ],
      );
      row = result.rows[0];
      if (row.state === "done" && current.state !== "done")
        await this.client.query(
          `INSERT INTO app.activity_event(tenant_id,lead_id,event_type,source_event_id,occurred_at,safe_data) VALUES($1,$2,'task.completed',$3,now(),$4)`,
          [
            this.context.organizationId,
            row.lead_id,
            randomUUID(),
            JSON.stringify({ resourceId: id, resourceVersion: Number(row.row_version) }),
          ],
        );
    } else if (resource === "members") {
      // Serialize final-owner changes at the organization boundary.
      await this.client.query("SELECT id FROM app.organization WHERE id=$1 FOR UPDATE", [
        this.context.organizationId,
      ]);
      const newRole = body.roleId ?? current.role_id;
      const newStatus = body.status ?? current.status;
      const roles = await this.client.query(
        "SELECT id,name,permission_grants FROM app.role_definition WHERE id=ANY($1::uuid[])",
        [[current.role_id, newRole]],
      );
      const targetRole = roles.rows.find((r) => r.id === newRole);
      if (!targetRole) throw new AccessError(422, "role_invalid", "Role must belong to this organization.");
      const oldRole = roles.rows.find((r) => r.id === current.role_id);
      if ((oldRole?.name === "Owner" || targetRole.name === "Owner") && this.context.roleName !== "Owner")
        throw new AccessError(403, "owner_change_denied", "Only an owner can change owner membership.");
      if (newRole !== current.role_id || (newStatus === "active" && current.status !== "active"))
        assertDelegation(this.context, targetRole.permission_grants);
      if (
        oldRole?.name === "Owner" &&
        current.status === "active" &&
        (targetRole.name !== "Owner" || newStatus !== "active")
      ) {
        const count = await this.client.query(
          `SELECT count(*) FROM app.membership m JOIN app.role_definition r ON r.id=m.role_id AND r.tenant_id=m.tenant_id WHERE m.tenant_id=app.current_tenant() AND m.status='active' AND r.name='Owner'`,
        );
        if (Number(count.rows[0].count) <= 1)
          throw new AccessError(409, "last_owner", "An organization must retain an active owner.");
      }
      if (body.officeIds) {
        if (new Set(body.officeIds).size !== body.officeIds.length)
          throw new AccessError(422, "office_duplicate", "Offices cannot be duplicated.");
        for (const office of body.officeIds) {
          const result = await this.client.query("SELECT id FROM app.office WHERE id=$1", [office]);
          if (!result.rowCount)
            throw new AccessError(422, "office_invalid", "Office must belong to this organization.");
        }
        await this.client.query("DELETE FROM app.office_member WHERE member_id=$1", [id]);
        for (const office of body.officeIds)
          await this.client.query(
            "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3)",
            [this.context.organizationId, office, id],
          );
      }
      const result = await this.client.query(
        `UPDATE app.membership SET role_id=$1,status=$2,row_version=row_version+1,updated_at=now() WHERE id=$3 RETURNING *`,
        [newRole, newStatus, id],
      );
      row = result.rows[0];
    } else notFound();
    await this.audit(`${config.table}.updated`, config.table, id, Number(row.row_version));
    return { body: config.mapper(row), status: 200, etag: `"${row.row_version}"` };
  }

  async transition(id: string, body: Body, expectedVersion: string | undefined): Promise<Mutation> {
    const row = await this.row("leads", id, true, true);
    requireVersion(row, expectedVersion);
    const stage = await this.client.query("SELECT id FROM app.pipeline_stage WHERE id=$1", [body.toStageId]);
    if (!stage.rowCount)
      throw new AccessError(422, "stage_invalid", "Stage must belong to this organization.");
    if (row.stage_id === body.toStageId)
      throw new AccessError(409, "stage_unchanged", "Lead is already in this stage.");
    await this.client.query(
      `INSERT INTO app.stage_transition(tenant_id,lead_id,from_stage_id,to_stage_id,actor_member_id,reason) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        this.context.organizationId,
        id,
        row.stage_id,
        body.toStageId,
        this.context.memberId,
        body.reason ?? null,
      ],
    );
    const result = await this.client.query(
      "UPDATE app.lead SET stage_id=$1,row_version=row_version+1,updated_at=now() WHERE id=$2 RETURNING *",
      [body.toStageId, id],
    );
    const updated = result.rows[0];
    await this.audit("lead.stage_changed", "lead", id, Number(updated.row_version));
    await this.event("lead.stage_changed", "lead", id, Number(updated.row_version), [body.toStageId]);
    await this.client.query(
      `INSERT INTO app.activity_event(tenant_id,lead_id,event_type,source_event_id,occurred_at,safe_data) VALUES($1,$2,'lead.stage_changed',$3,now(),$4)`,
      [
        this.context.organizationId,
        id,
        randomUUID(),
        JSON.stringify({ resourceId: id, resourceVersion: Number(updated.row_version) }),
      ],
    );
    return { body: models.lead(updated), status: 201, etag: `"${updated.row_version}"` };
  }

  async notes(id: string, body?: Body, expectedVersion?: string): Promise<unknown> {
    const lead = await this.row("leads", id, !!body, !!body);
    if (body) {
      requireVersion(lead, expectedVersion);
      const result = await this.client.query(
        `INSERT INTO app.note(tenant_id,lead_id,author_member_id,body) VALUES($1,$2,$3,$4) RETURNING *`,
        [this.context.organizationId, id, this.context.memberId, text(body.body)],
      );
      await this.client.query("UPDATE app.lead SET row_version=row_version+1,updated_at=now() WHERE id=$1", [
        id,
      ]);
      await this.audit("lead.note_added", "note", result.rows[0].id, 1);
      return { body: models.note(result.rows[0]), status: 201 };
    }
    const result = await this.client.query(
      "SELECT * FROM app.note WHERE lead_id=$1 ORDER BY created_at,id LIMIT 100",
      [id],
    );
    return { items: result.rows.map(models.note), nextCursor: null, hasMore: false };
  }

  async activity(id: string) {
    await this.row("leads", id);
    const result = await this.client.query(
      "SELECT * FROM app.activity_event WHERE lead_id=$1 ORDER BY occurred_at DESC,id LIMIT 100",
      [id],
    );
    return {
      items: result.rows.map((r) => ({
        id: r.id,
        type: r.event_type,
        occurredAt: new Date(r.occurred_at).toISOString(),
        description: r.event_type.split(".").join(" "),
        resourceId: r.safe_data.resourceId ?? null,
      })),
      nextCursor: null,
      hasMore: false,
    };
  }

  async dashboard(query: Record<string, unknown>): Promise<components["schemas"]["Dashboard"]> {
    if (
      !query ||
      typeof query !== "object" ||
      types.isProxy(query) ||
      (Object.getPrototypeOf(query) !== null && Object.getPrototypeOf(query) !== Object.prototype) ||
      Reflect.ownKeys(query).length
    )
      throw new AccessError(422, "query_invalid", "Dashboard reporting has no query parameters.");
    const context = detachedReadContext(this.context, "reporting");
    const current = new CrmService(this.client, context, this.traceId);
    const dashboardScope = requirePermission(context, "dashboard.read");
    const leadScope = requirePermission(context, "crm.leads.read");
    if (dashboardScope !== "organization" || !["own", "team", "organization"].includes(leadScope))
      throw new AccessError(403, "permission_denied", "Current reporting source permission is required.");
    const authority = `SELECT 1 FROM app.membership m
      JOIN app.role_definition r ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)
      JOIN app.organization o ON o.id=m.tenant_id
      WHERE session_user='estate_runtime' AND current_user='estate_runtime'
        AND app.current_tenant()=$1::uuid AND app.current_actor()=$2::uuid
        AND m.tenant_id=$1 AND m.user_id=$2 AND m.id=$3 AND m.role_id=$4
        AND m.status='active' AND o.status='active' AND r.permission_grants=$5::jsonb
        AND r.name=$6 AND o.timezone=$7`;
    const parameters = [
      context.organizationId,
      context.userId,
      context.memberId,
      context.roleId,
      permissionGrantJson(context.permissions),
      context.roleName,
      context.timezone,
    ];
    const assertAuthority = async (lock = false) => {
      if (!(await this.client.query(`${authority}${lock ? " FOR SHARE OF m,r,o" : ""}`, parameters)).rowCount)
        throw new AccessError(403, "permission_denied", "Current reporting authority is unavailable.");
    };
    await assertAuthority(true);
    await requireEntitlement(this.client, "dashboard.read");
    const taskScope = context.permissions.some((grant) => grant.code === "crm.tasks.read")
      ? await current.taskAuthority()
      : null;
    if (leadScope === "team" || taskScope === "team")
      await this.client.query(
        `SELECT office_id,member_id FROM app.office_member WHERE tenant_id=app.current_tenant()
         AND member_id=$1 ORDER BY office_id,member_id FOR SHARE`,
        [context.memberId],
      );
    await assertAuthority();
    await requireEntitlement(this.client, "dashboard.read", { lock: false });
    const captured = await this.client.query(
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS captured_at",
    );
    const period = dashboardUtcPeriod(captured.rows[0]?.captured_at);
    const counts = await this.client.query(
      `SELECT count(*) FROM app.lead r WHERE r.tenant_id=app.current_tenant() AND r.archived_at IS NULL
       AND r.owner_member_id=$1 AND ${current.scopeSql("leads", leadScope, "$1")}
       AND r.created_at BETWEEN $2::timestamptz AND $3::timestamptz`,
      [context.memberId, period.from, period.to],
    );
    const measuredCount = counts.rows[0]?.count;
    const count =
      typeof measuredCount === "number"
        ? measuredCount
        : typeof measuredCount === "string" && /^[0-9]+$/.test(measuredCount)
          ? Number(measuredCount)
          : NaN;
    if (!Number.isSafeInteger(count) || count < 0)
      throw new AccessError(
        503,
        "dashboard_measurement_unavailable",
        "The reporting measurement is unavailable.",
      );
    const tasks = taskScope
      ? await this.client.query(
          `SELECT r.* FROM app.task r WHERE r.tenant_id=app.current_tenant() AND r.state='open'
       AND r.assignee_member_id=$1 AND ${current.scopeSql("tasks", taskScope, "$1")}
       AND ${current.taskSourceSql("$1")} ORDER BY r.due_at,r.id LIMIT 20`,
          [context.memberId],
        )
      : { rows: [] };
    const measured = await this.client.query(
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS refreshed_at",
    );
    const refreshedAt = dashboardClockInstant(measured.rows[0]?.refreshed_at);
    if (refreshedAt < period.to)
      throw new AccessError(503, "dashboard_clock_unavailable", "The reporting clock is unavailable.");
    await assertAuthority();
    await requireEntitlement(this.client, "dashboard.read", { lock: false });
    return {
      period,
      metrics: [
        {
          key: "leads.created",
          definitionVersion: 2,
          value: count,
          unit: "leads",
          source: "crm-own-utc-month-query-v2",
          state: "available",
          refreshedAt,
        },
        {
          key: "revenue",
          definitionVersion: 1,
          value: null,
          unit: "USD",
          source: "billing-unconfigured",
          state: "unavailable",
          refreshedAt: null,
        },
      ],
      tasks: tasks.rows.map(models.task),
      notifications: [],
      integrationHealth: [],
    };
  }
}
