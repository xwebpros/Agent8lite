import type { components } from "../../../packages/contracts/generated/api";
type Row = Record<string, any>;
export type Schemas = components["schemas"];
export const organization = (r: Row): Schemas["Organization"] => ({
  id: r.id,
  name: r.name,
  status: r.status,
  timezone: r.timezone,
  locale: r.locale,
  version: Number(r.row_version),
});
export const lead = (r: Row): Schemas["Lead"] => ({
  id: r.id,
  contactId: r.contact_id,
  sourceId: r.source_id,
  stageId: r.stage_id,
  ownerMemberId: r.owner_member_id,
  intent: r.intent,
  timeline: r.timeline,
  score: r.score === null ? null : Number(r.score),
  scoreVersion: r.score_version,
  version: Number(r.row_version),
});
export const task = (r: Row): Schemas["Task"] => ({
  id: r.id,
  leadId: r.lead_id,
  assigneeMemberId: r.assignee_member_id,
  title: r.title,
  description: r.description,
  dueAt: new Date(r.due_at).toISOString(),
  timezone: r.due_timezone,
  priority: r.priority,
  state: r.state,
  version: Number(r.row_version),
});
export const contact = (r: Row): Schemas["Contact"] => ({
  id: r.id,
  displayName: r.display_name,
  emails: r.emails ?? [],
  phones: r.phones ?? [],
  birthday:
    r.birthday instanceof Date
      ? `${r.birthday.getFullYear()}-${String(r.birthday.getMonth() + 1).padStart(2, "0")}-${String(r.birthday.getDate()).padStart(2, "0")}`
      : (r.birthday ?? null),
  version: Number(r.row_version),
});
export const member = (r: Row): Schemas["Member"] => ({
  id: r.id,
  displayName: r.display_name,
  roleId: r.role_id,
  status: r.status,
  version: Number(r.row_version),
});
export const role = (r: Row): Schemas["Role"] => ({
  id: r.id,
  name: r.name,
  permissions: r.permission_grants,
  version: Number(r.row_version),
});
export const stage = (r: Row): Schemas["PipelineStage"] => ({
  id: r.id,
  name: r.name,
  position: r.position,
  terminal: r.terminal,
  version: Number(r.row_version),
});
export const source = (r: Row): Schemas["LeadSource"] => ({
  id: r.id,
  code: r.code,
  label: r.label,
  version: Number(r.row_version),
});
export const note = (r: Row): Schemas["Note"] => ({
  id: r.id,
  leadId: r.lead_id,
  authorMemberId: r.author_member_id,
  body: r.body,
  createdAt: new Date(r.created_at).toISOString(),
});
