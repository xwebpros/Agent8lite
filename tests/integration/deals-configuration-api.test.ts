import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
let agent: ApiSession;
let role: Schemas["Role"];
let office: Schemas["Office"];
let originalMember: { role_id: string; status: string };
const outsider = { user: randomUUID(), member: randomUUID() };
const records = new Map<string, Set<string>>();
const keys = new Set<string>();
const setupKeys = new Set<string>();
const prefix = () => `Synthetic deal review ${randomUUID()}`;
const path = (session: ApiSession, resource: string) => `/v1/orgs/${session.orgId}/${resource}`;
const grants: Schemas["RoleWrite"]["permissions"] = [
  { code: "crm.contacts.read", scope: "organization" },
  { code: "crm.contacts.write", scope: "own" },
  { code: "crm.leads.read", scope: "own" },
  { code: "crm.leads.write", scope: "own" },
  { code: "crm.deals.read", scope: "own" },
  { code: "crm.deals.write", scope: "own" },
  { code: "crm.pipeline.read", scope: "own" },
  { code: "crm.pipeline.write", scope: "own" },
  { code: "crm.sources.read", scope: "own" },
  { code: "crm.sources.write", scope: "own" },
  { code: "crm.tags.read", scope: "own" },
  { code: "crm.tags.write", scope: "own" },
];
function tracked(table: string, id: string) {
  if (!records.has(table)) records.set(table, new Set());
  records.get(table)!.add(id);
}
function command(
  session: ApiSession,
  resource: string,
  body: unknown,
  options: { method?: string; key?: string; revision?: string; csrf?: string } = {},
) {
  const key = options.key ?? randomUUID();
  keys.add(key);
  return session.command(path(session, resource), body, { ...options, key });
}
async function created<T extends keyof Schemas>(
  session: ApiSession,
  resource: string,
  schema: T,
  table: string,
  input: unknown,
  key?: string,
) {
  const response = await command(session, resource, input, { key });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = await response.json();
  if (body.id) tracked(table, body.id);
  assertContract(schema, body);
  return body;
}
async function setGrants(value: Schemas["RoleWrite"]["permissions"]) {
  await admin.query(
    "UPDATE app.role_definition SET permission_grants=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, role.id, JSON.stringify(value)],
  );
}
async function scope(deal: "own" | "team" | "organization", lead = deal) {
  await setGrants(
    grants.map((grant) => ({
      ...grant,
      scope: grant.code.startsWith("crm.deals.")
        ? deal
        : grant.code.startsWith("crm.leads.")
          ? lead
          : grant.scope,
    })),
  );
}
async function contact() {
  return created(owner, "contacts", "Contact", "contact", {
    displayName: prefix(),
    emails: [`${randomUUID()}@example.test`],
  });
}
async function lead(ownerMemberId = agent.memberId, existingContact?: Schemas["Contact"]) {
  const person = existingContact ?? (await contact());
  return created(owner, "leads", "Lead", "lead", {
    contactId: person.id,
    sourceId: owner.orgId === fixtures.orgA ? fixtures.sourceA : fixtures.sourceB,
    ownerMemberId,
    intent: "unknown",
  });
}
function dealInput(leadId: string, name = prefix()): Schemas["DealWrite"] {
  return { leadId, name, currency: "USD", state: "open", amount: null };
}
async function deal(leadId: string, session = owner, name = prefix()) {
  return created(session, "deals", "Deal", "deal", dealInput(leadId, name));
}
async function tag(session = owner) {
  return created(session, "tags", "Tag", "tag", { name: prefix() });
}
async function tagLead(value: Schemas["Lead"], tagIds: string[], session = owner) {
  const response = await command(
    session,
    `leads/${value.id}/tags`,
    { tagIds },
    {
      method: "PUT",
      revision: `"${value.version}"`,
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  assertContract("Lead", body);
  return body;
}
function filter(value: Schemas["LeadFilter"]) {
  return encodeURIComponent(JSON.stringify(value));
}
async function visibleDeals() {
  return (await agent.read(path(agent, "deals?limit=100"), "PageDeal")).body.items.map((item) => item.id);
}

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
  originalMember = (
    await admin.query("SELECT role_id,status FROM app.membership WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      agent.memberId,
    ])
  ).rows[0];
  role = await created(owner, "roles", "Role", "role_definition", { name: prefix(), permissions: grants });
  office = await created(owner, "offices", "Office", "office", {
    name: prefix(),
    timezone: "America/Los_Angeles",
  });
  await admin.query(
    "INSERT INTO app.user_identity(id,issuer,subject,display_name,email,email_verified)VALUES($1,'urn:estate:synthetic',$2,$3,$4,true)",
    [outsider.user, outsider.user, prefix(), `${outsider.user}@example.test`],
  );
  await admin.query(
    "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active',$5)",
    [fixtures.orgA, outsider.member, outsider.user, originalMember.role_id, prefix()],
  );
  for (const member of [agent.memberId, owner.memberId])
    await admin.query("INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3)", [
      fixtures.orgA,
      office.id,
      member,
    ]);
  // Persistent suite setup is cleaned separately after all test-created dependent rows.
  records.clear();
  for (const key of keys) setupKeys.add(key);
  keys.clear();
});
beforeEach(async () => {
  await setGrants(grants);
  await admin.query(
    "UPDATE app.membership SET role_id=$3,status='active',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, agent.memberId, role.id],
  );
});
afterEach(async () => {
  if (owner.orgId !== fixtures.orgA) expect((await owner.switchOrganization(fixtures.orgA)).status).toBe(200);
  await admin.query(
    "UPDATE app.membership SET role_id=$3,status=$4,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, agent.memberId, originalMember.role_id, originalMember.status],
  );
  const resources = [...records.values()].flatMap((ids) => [...ids]);
  const leads = [...(records.get("lead") ?? [])];
  if (resources.length) {
    const events = (
      await admin.query("SELECT id FROM app.outbox WHERE aggregate_id=ANY($1::text[])", [resources])
    ).rows.map((row) => row.id);
    if (events.length) {
      await admin.query("DELETE FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])", [events]);
      await admin.query("DELETE FROM app.outbox WHERE id=ANY($1::uuid[])", [events]);
    }
    await admin.query("DELETE FROM app.audit_event WHERE resource_id=ANY($1::text[])", [resources]);
  }
  if (leads.length) {
    await admin.query("DELETE FROM app.activity_event WHERE lead_id=ANY($1::uuid[])", [leads]);
    await admin.query("DELETE FROM app.stage_transition WHERE lead_id=ANY($1::uuid[])", [leads]);
    await admin.query("DELETE FROM app.lead_tag WHERE lead_id=ANY($1::uuid[])", [leads]);
  }
  for (const table of ["deal", "lead", "contact", "tag", "pipeline_stage", "lead_source"]) {
    const ids = [...(records.get(table) ?? [])];
    if (!ids.length) continue;
    if (table === "contact")
      await admin.query("DELETE FROM app.contact_channel WHERE contact_id=ANY($1::uuid[])", [ids]);
    await admin.query(`DELETE FROM app.${table} WHERE id=ANY($1::uuid[])`, [ids]);
  }
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  records.clear();
  keys.clear();
});
afterAll(async () => {
  if (office) {
    await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2", [
      fixtures.orgA,
      office.id,
    ]);
    await admin.query("DELETE FROM app.office WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, office.id]);
  }
  await admin.query("DELETE FROM app.membership WHERE tenant_id=$1 AND id=$2", [
    fixtures.orgA,
    outsider.member,
  ]);
  await admin.query("DELETE FROM app.user_identity WHERE id=$1", [outsider.user]);
  if (role)
    await admin.query("DELETE FROM app.role_definition WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      role.id,
    ]);
  if (role || office)
    await admin.query("DELETE FROM app.audit_event WHERE resource_id=ANY($1::text[])", [
      [role?.id, office?.id].filter(Boolean),
    ]);
  if (setupKeys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...setupKeys]]);
  await admin.end();
});

describe("MOD-D-001/002/007 — deals and tenant CRM configuration", () => {
  it("intersects deal scope with linked-lead own, team and organization scope", async () => {
    const ownLead = await lead();
    const teamLead = await lead(owner.memberId);
    const outsideLead = await lead(outsider.member);
    const own = await deal(ownLead.id);
    const team = await deal(teamLead.id);
    const outside = await deal(outsideLead.id);
    expect(await visibleDeals()).toEqual([own.id]);
    await assertProblem(await agent.request(path(agent, `deals/${team.id}`)), 404);
    await assertProblem(await command(agent, "deals", dealInput(teamLead.id)), 404);
    await scope("organization", "own");
    expect(await visibleDeals()).toEqual([own.id]);
    await scope("own", "organization");
    expect(await visibleDeals()).toEqual([own.id]);
    await scope("team");
    expect(new Set(await visibleDeals())).toEqual(new Set([own.id, team.id]));
    await assertProblem(await agent.request(path(agent, `deals/${outside.id}`)), 404);
    await deal(teamLead.id, agent);
    await assertProblem(await command(agent, "deals", dealInput(outsideLead.id)), 404);
    await scope("organization");
    expect(await visibleDeals()).toContain(outside.id);
    expect((await agent.read(path(agent, `deals/${outside.id}`), "Deal")).body.leadId).toBe(outsideLead.id);
  });

  it("denies foreign leads, foreign deal IDs and active-organization forgery", async () => {
    const local = await deal((await lead()).id, agent);
    await assertProblem(await command(agent, "deals", dealInput(fixtures.leadB)), 404);
    expect((await owner.switchOrganization(fixtures.orgB)).status).toBe(200);
    const foreign = await deal(fixtures.leadB, owner);
    await assertProblem(await agent.request(path(agent, `deals/${foreign.id}`)), 404);
    await assertProblem(await agent.request(`/v1/orgs/${fixtures.orgB}/deals/${foreign.id}`), 403);
    await assertProblem(await owner.request(path(owner, `deals/${local.id}`)), 404);
  });

  it("creates one deal/activity/audit on concurrent retries and preserves null unknown values", async () => {
    const inquiry = await lead();
    const input = dealInput(inquiry.id);
    const key = randomUUID();
    const results = await Promise.all([
      command(agent, "deals", input, { key }),
      command(agent, "deals", input, { key }),
    ]);
    const values = await Promise.all(
      results.map(async (response) => {
        expect(response.status).toBe(201);
        expect(response.headers.get("etag")).toBe('"1"');
        const value = await response.json();
        tracked("deal", value.id);
        assertContract("Deal", value);
        return value;
      }),
    );
    expect(values[0]).toEqual(values[1]);
    expect(values[0]).toMatchObject({ amount: null, expectedCloseDate: null, version: 1 });
    for (const [table, predicate, parameters] of [
      ["deal", "id=$1", [values[0].id]],
      ["activity_event", "lead_id=$1 AND event_type='deal.created'", [inquiry.id]],
      ["audit_event", "resource_id=$1 AND action='deal.created'", [values[0].id]],
    ] as const)
      expect(
        (
          await admin.query(`SELECT count(*)::int count FROM app.${table} WHERE ${predicate}`, [
            ...parameters,
          ])
        ).rows[0].count,
      ).toBe(1);
    await assertProblem(await command(agent, "deals", { ...input, state: "won" }, { key }), 409);
  });

  it("requires revisions and preserves immutable lead references and event history during write races", async () => {
    const inquiry = await lead();
    const other = await lead();
    const value = await deal(inquiry.id, agent);
    const input = { ...dealInput(inquiry.id, value.name), amount: 123.45, state: "won" as const };
    await assertProblem(await command(agent, `deals/${value.id}`, input, { method: "PATCH" }), 400);
    await assertProblem(
      await command(agent, `deals/${value.id}`, input, { method: "PATCH", revision: '"invalid"' }),
      400,
    );
    await assertProblem(
      await command(
        agent,
        `deals/${value.id}`,
        { ...input, leadId: other.id },
        { method: "PATCH", revision: '"1"' },
      ),
      422,
    );
    const results = await Promise.all([
      command(agent, `deals/${value.id}`, input, { method: "PATCH", revision: '"1"' }),
      command(agent, `deals/${value.id}`, { ...input, state: "lost" }, { method: "PATCH", revision: '"1"' }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 412]);
    const current = (await agent.read(path(agent, `deals/${value.id}`), "Deal")).body;
    expect(current).toMatchObject({ leadId: inquiry.id, amount: 123.45, version: 2 });
    const history = (
      await admin.query(
        "SELECT event_type,safe_data FROM app.activity_event WHERE lead_id=$1 AND event_type LIKE 'deal.%' ORDER BY occurred_at,id",
        [inquiry.id],
      )
    ).rows;
    expect(history.map((row) => row.event_type)).toEqual(["deal.created", "deal.updated"]);
    expect(history[1].safe_data).toEqual({ resourceId: value.id, resourceVersion: 2 });
  });

  it("rechecks reassignment, archived lead, revoked membership and linked-lead permissions on replay", async () => {
    const inquiry = await lead();
    const input = dealInput(inquiry.id);
    const key = randomUUID();
    const value = await created(agent, "deals", "Deal", "deal", input, key);
    await admin.query("UPDATE app.lead SET owner_member_id=$2,row_version=row_version+1 WHERE id=$1", [
      inquiry.id,
      owner.memberId,
    ]);
    await assertProblem(await command(agent, "deals", input, { key }), 404);
    await assertProblem(await agent.request(path(agent, `deals/${value.id}`)), 404);
    await admin.query(
      "UPDATE app.lead SET owner_member_id=$2,archived_at=now(),row_version=row_version+1 WHERE id=$1",
      [inquiry.id, agent.memberId],
    );
    await assertProblem(await command(agent, "deals", input, { key }), 404);
    expect(await visibleDeals()).not.toContain(value.id);
    await admin.query("UPDATE app.lead SET archived_at=NULL,row_version=row_version+1 WHERE id=$1", [
      inquiry.id,
    ]);
    await admin.query(
      "UPDATE app.membership SET status='disabled',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, agent.memberId],
    );
    await assertProblem(await command(agent, "deals", input, { key }), 403);
    await admin.query(
      "UPDATE app.membership SET status='active',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, agent.memberId],
    );
    await setGrants(grants.filter((grant) => grant.code !== "crm.leads.read"));
    await assertProblem(await command(agent, "deals", dealInput(inquiry.id)), 403);
    await assertProblem(await command(agent, "deals", input, { key }), 403);
  });

  it("rejects invalid money, unsupported fields and missing CSRF without a deal", async () => {
    const inquiry = await lead();
    const input = dealInput(inquiry.id);
    for (const change of [
      { amount: -1 },
      { amount: 0.001 },
      { amount: 1e15 },
      { currency: "usd" },
      { name: " " },
      { state: "unknown" },
      { expectedCloseDate: "2026-12-01" },
    ])
      await assertProblem(await command(agent, "deals", { ...input, ...change }), 422);
    await assertProblem(await command(agent, "deals", input, { csrf: "wrong-token" }), 403);
    expect(
      (await admin.query("SELECT count(*)::int count FROM app.deal WHERE lead_id=$1", [inquiry.id])).rows[0]
        .count,
    ).toBe(0);
  });

  it("binds deal cursors to the actor, linked-lead filters and current permission grants", async () => {
    const name = prefix();
    const inquiry = await lead();
    const values = await Promise.all([
      deal(inquiry.id, owner, name),
      deal(inquiry.id, owner, name),
      deal(inquiry.id, owner, name),
    ]);
    const query = {
      q: name,
      intent: "unknown" as const,
      sourceId: fixtures.sourceA,
      ownerMemberId: agent.memberId,
    };
    const first = (await agent.read(path(agent, `deals?limit=1&filter=${filter(query)}`), "PageDeal")).body;
    expect(first.hasMore).toBe(true);
    const cursor = encodeURIComponent(first.nextCursor!);
    const next = (
      await agent.read(path(agent, `deals?limit=100&filter=${filter(query)}&cursor=${cursor}`), "PageDeal")
    ).body;
    expect(new Set([...first.items, ...next.items].map((item) => item.id))).toEqual(
      new Set(values.map((item) => item.id)),
    );
    await assertProblem(
      await owner.request(path(owner, `deals?filter=${filter(query)}&cursor=${cursor}`)),
      422,
    );
    await assertProblem(
      await agent.request(
        path(agent, `deals?filter=${filter({ ...query, intent: "buyer" })}&cursor=${cursor}`),
      ),
      422,
    );
    await scope("organization", "own");
    await assertProblem(
      await agent.request(path(agent, `deals?filter=${filter(query)}&cursor=${cursor}`)),
      422,
    );
  });

  it("configures immutable stage IDs with unique order/name and invalidates a cursor when another stage changes", async () => {
    const input: Schemas["StageWrite"] = { name: prefix(), position: 80, terminal: false };
    const value = await created(owner, "pipeline-stages", "PipelineStage", "pipeline_stage", input);
    await assertProblem(await command(owner, "pipeline-stages", { ...input, name: prefix() }), 409);
    await assertProblem(await command(owner, "pipeline-stages", { ...input, position: 81 }), 409);
    await assertProblem(
      await command(owner, "pipeline-stages", { ...input, name: prefix(), position: 101 }),
      422,
    );
    const first = (await owner.read(path(owner, "pipeline-stages?limit=1"), "PagePipelineStage")).body;
    expect(first.items[0].position).toBe(0);
    const cursor = encodeURIComponent(first.nextCursor!);
    const update = { ...input, name: prefix(), position: 81, terminal: true };
    await assertProblem(
      await command(owner, `pipeline-stages/${value.id}`, update, { method: "PATCH" }),
      400,
    );
    await assertProblem(
      await command(owner, `pipeline-stages/${value.id}`, update, {
        method: "PATCH",
        revision: '"invalid"',
      }),
      400,
    );
    const response = await command(owner, `pipeline-stages/${value.id}`, update, {
      method: "PATCH",
      revision: '"1"',
    });
    expect(response.status).toBe(200);
    const updated = await response.json();
    assertContract("PipelineStage", updated);
    expect(updated).toMatchObject({ ...update, id: value.id, version: 2 });
    await assertProblem(
      await command(owner, `pipeline-stages/${value.id}`, input, { method: "PATCH", revision: '"1"' }),
      412,
    );
    await assertProblem(await owner.request(path(owner, `pipeline-stages?limit=1&cursor=${cursor}`)), 422);
    const ordered = (await owner.read(path(owner, "pipeline-stages?limit=100"), "PagePipelineStage")).body
      .items;
    expect(ordered.map((item) => item.position)).toEqual(
      ordered.map((item) => item.position).sort((a, b) => a - b),
    );
    await assertProblem(await owner.request(path(owner, `pipeline-stages/${stageId(2, 1)}`)), 404);
  });

  it("keeps source attribution codes immutable and tags unique with optimistic revisions", async () => {
    const sourceInput: Schemas["LeadSourceWrite"] = { code: `synthetic-${randomUUID()}`, label: prefix() };
    const source = await created(owner, "lead-sources", "LeadSource", "lead_source", sourceInput);
    await assertProblem(await command(owner, "lead-sources", { ...sourceInput, label: prefix() }), 409);
    await assertProblem(
      await command(
        owner,
        `lead-sources/${source.id}`,
        { ...sourceInput, code: `other-${randomUUID()}` },
        { method: "PATCH", revision: '"1"' },
      ),
      422,
    );
    const changed = await command(
      owner,
      `lead-sources/${source.id}`,
      { ...sourceInput, label: prefix() },
      { method: "PATCH", revision: '"1"' },
    );
    expect(changed.status).toBe(200);
    const current = await changed.json();
    assertContract("LeadSource", current);
    expect(current).toMatchObject({ id: source.id, code: sourceInput.code, version: 2 });
    await assertProblem(
      await command(owner, `lead-sources/${source.id}`, sourceInput, { method: "PATCH", revision: '"1"' }),
      412,
    );
    await assertProblem(await command(owner, "lead-sources", { code: "Invalid Code", label: prefix() }), 422);
    await assertProblem(await owner.request(path(owner, `lead-sources/${fixtures.sourceB}`)), 404);
    const first = await tag();
    await assertProblem(await command(owner, "tags", { name: first.name }), 409);
    const response = await command(
      owner,
      `tags/${first.id}`,
      { name: prefix() },
      { method: "PATCH", revision: '"1"' },
    );
    expect(response.status).toBe(200);
    assertContract("Tag", await response.json());
    await assertProblem(
      await command(owner, `tags/${first.id}`, { name: first.name }, { method: "PATCH", revision: '"1"' }),
      412,
    );
  });

  it("atomically replaces lead tags with one revision on retry, and denies duplicate/foreign tags and stale writes", async () => {
    const inquiry = await lead();
    const first = await tag();
    const second = await tag();
    expect((await owner.switchOrganization(fixtures.orgB)).status).toBe(200);
    const foreign = await tag();
    expect((await owner.switchOrganization(fixtures.orgA)).status).toBe(200);
    const resource = `leads/${inquiry.id}/tags`;
    await assertProblem(
      await command(agent, resource, { tagIds: [first.id, first.id] }, { method: "PUT", revision: '"1"' }),
      422,
    );
    await assertProblem(
      await command(agent, resource, { tagIds: [foreign.id] }, { method: "PUT", revision: '"1"' }),
      422,
    );
    await assertProblem(await command(agent, resource, { tagIds: [first.id] }, { method: "PUT" }), 400);
    const key = randomUUID();
    const options = { method: "PUT", revision: '"1"', key };
    const response = await command(agent, resource, { tagIds: [first.id, second.id] }, options);
    expect(response.status).toBe(200);
    const value = await response.json();
    assertContract("Lead", value);
    expect(value).toMatchObject({ id: inquiry.id, version: 2 });
    expect(value).not.toHaveProperty("tagIds");
    const replay = await command(agent, resource, { tagIds: [first.id, second.id] }, options);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(value);
    expect(
      (await admin.query("SELECT tag_id FROM app.lead_tag WHERE lead_id=$1", [inquiry.id])).rows
        .map((row) => row.tag_id)
        .sort(),
    ).toEqual([first.id, second.id].sort());
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.audit_event WHERE resource_id=$1 AND action='lead.tags_replaced'",
          [inquiry.id],
        )
      ).rows[0].count,
    ).toBe(1);
    await assertProblem(
      await command(agent, resource, { tagIds: [] }, { method: "PUT", revision: '"1"' }),
      412,
    );
    const empty = await tagLead(value, [], agent);
    expect(empty.version).toBe(3);
    expect(
      (await admin.query("SELECT count(*)::int count FROM app.lead_tag WHERE lead_id=$1", [inquiry.id]))
        .rows[0].count,
    ).toBe(0);
    await admin.query("UPDATE app.lead SET owner_member_id=$2,row_version=row_version+1 WHERE id=$1", [
      inquiry.id,
      owner.memberId,
    ]);
    await assertProblem(await command(agent, resource, { tagIds: [first.id, second.id] }, options), 404);
  });

  it("applies all tag filters to leads/deals and only currently authorized relationships to contacts", async () => {
    const first = await tag();
    const second = await tag();
    const person = await contact();
    const owned = await lead(agent.memberId, person);
    const hidden = await lead(owner.memberId, person);
    const both = await lead();
    await tagLead(owned, [first.id]);
    await tagLead(hidden, [first.id, second.id]);
    await tagLead(both, [first.id, second.id]);
    const ownedDeal = await deal(owned.id);
    const bothDeal = await deal(both.id);
    const hiddenDeal = await deal(hidden.id);
    const query = filter({ tagIds: [first.id, second.id] });
    expect(
      (await agent.read(path(agent, `leads?filter=${query}`), "PageLead")).body.items.map((item) => item.id),
    ).toEqual([both.id]);
    expect(
      (await agent.read(path(agent, `deals?filter=${query}`), "PageDeal")).body.items.map((item) => item.id),
    ).toEqual([bothDeal.id]);
    const people = (await agent.read(path(agent, `contacts?filter=${query}`), "PageContact")).body.items.map(
      (item) => item.id,
    );
    expect(people).toEqual([both.contactId]);
    expect(people).not.toContain(person.id);
    expect(
      (await agent.read(path(agent, `deals?filter=${filter({ tagIds: [first.id] })}`), "PageDeal")).body.items
        .map((item) => item.id)
        .sort(),
    ).toEqual([ownedDeal.id, bothDeal.id].sort());
    await scope("organization");
    expect(
      (await agent.read(path(agent, `deals?filter=${query}`), "PageDeal")).body.items
        .map((item) => item.id)
        .sort(),
    ).toEqual([bothDeal.id, hiddenDeal.id].sort());
    for (const resource of ["contacts", "leads", "deals"])
      await assertProblem(
        await agent.request(path(agent, `${resource}?filter=${filter({ tagIds: [first.id, first.id] })}`)),
        422,
      );
    expect((await owner.switchOrganization(fixtures.orgB)).status).toBe(200);
    const foreign = await tag();
    for (const resource of ["contacts", "leads", "deals"])
      await assertProblem(
        await agent.request(path(agent, `${resource}?filter=${filter({ tagIds: [foreign.id] })}`)),
        422,
      );
    await setGrants(grants.filter((grant) => grant.code !== "crm.tags.read"));
    await assertProblem(await agent.request(path(agent, `deals?filter=${query}`)), 403);
  });

  it("rejects unsupported configuration filters and rechecks tag prerequisites on cached mutations", async () => {
    const inquiry = await lead();
    const label = await tag();
    const key = randomUUID();
    const options = { method: "PUT", revision: '"1"', key };
    const response = await command(agent, `leads/${inquiry.id}/tags`, { tagIds: [label.id] }, options);
    expect(response.status).toBe(200);
    for (const resource of ["pipeline-stages", "lead-sources", "tags"])
      await assertProblem(
        await agent.request(path(agent, `${resource}?filter=${filter({ ownerMemberId: agent.memberId })}`)),
        422,
      );
    await setGrants(grants.filter((grant) => grant.code !== "crm.tags.read"));
    await assertProblem(
      await command(agent, `leads/${inquiry.id}/tags`, { tagIds: [] }, { method: "PUT", revision: '"2"' }),
      403,
    );
    await assertProblem(
      await command(agent, `leads/${inquiry.id}/tags`, { tagIds: [label.id] }, options),
      403,
    );
  });
});
