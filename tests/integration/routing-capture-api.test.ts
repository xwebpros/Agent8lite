import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NativeCaptureService } from "../../apps/api/src/native-capture-service";
import type { NativeCaptureV1 } from "../../packages/contracts/internal/capture-port";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { withTenantTransaction } from "../../packages/db/tenant-transaction";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool, createRuntimePool } from "../helpers/database";

const admin = createMigrationPool();
const runtime = createRuntimePool();
let owner: ApiSession;
let agent: ApiSession;
let originalMember: Record<string, any>;
let originalEntitlement: Record<string, any>;
let originalRules: Record<string, any>[];
const actorRole = randomUUID();
const recipientRole = randomUUID();
const outside = { user: randomUUID(), member: randomUUID() };
const office = randomUUID();
const contacts = new Set<string>();
const leads = new Set<string>();
const rules = new Set<string>();
const jobs = new Set<string>();
const keys = new Set<string>();
const submissions = new Set<string>();
const actorGrants: Schemas["RoleWrite"]["permissions"] = [
  { code: "crm.contacts.read", scope: "own" },
  { code: "crm.contacts.write", scope: "own" },
  { code: "crm.leads.read", scope: "own" },
  { code: "crm.leads.write", scope: "own" },
  { code: "crm.sources.read", scope: "own" },
  { code: "crm.routing.read", scope: "own" },
  { code: "crm.routing.manage", scope: "own" },
];
const recipientGrants = [
  { code: "crm.leads.read", scope: "own" },
  { code: "crm.leads.write", scope: "own" },
];
const name = () => `Synthetic capture review ${randomUUID()}`;
const orgPath = (session: ApiSession, resource: string) => `/v1/orgs/${session.orgId}/${resource}`;

function mutation(
  session: ApiSession,
  path: string,
  body: unknown,
  options: { method?: string; key?: string; revision?: string; csrf?: string } = {},
) {
  const key = options.key ?? randomUUID();
  keys.add(key);
  return session.command(path, body, { ...options, key });
}
async function person(creator = owner.memberId) {
  const id = randomUUID();
  contacts.add(id);
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,$3,$4)",
    [fixtures.orgA, id, name(), creator],
  );
  return id;
}
async function manualLead(contactId: string, member = agent.memberId) {
  const id = randomUUID();
  leads.add(id);
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,intent,attribution)VALUES($1,$2,$3,$4,$5,$6,'unknown','{\"synthetic\":true}')",
    [fixtures.orgA, id, contactId, fixtures.sourceA, stageId(1, 1), member],
  );
  return id;
}
function command(contactId: string, extra: Partial<NativeCaptureV1> = {}): NativeCaptureV1 {
  const body: NativeCaptureV1 = {
    sourceSubmissionId: randomUUID(),
    contactId,
    sourceId: fixtures.sourceA,
    intent: "unknown",
    ...extra,
  };
  submissions.add(body.sourceSubmissionId);
  return body;
}
async function captured(body: NativeCaptureV1, session = owner, key?: string) {
  const response = await mutation(session, "/dev/capture", body, { key });
  expect(response.status, await response.clone().text()).toBe(201);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-synthetic-capture")).toBe("true");
  const value = await response.json();
  leads.add(value.id);
  assertContract("Lead", value);
  expect(response.headers.get("etag")).toBe(`"${value.version}"`);
  const decision = response.headers.get("x-capture-decision-id");
  expect(decision).toMatch(/^[0-9a-f-]{36}$/);
  const reasons = (response.headers.get("x-routing-reasons") ?? "").split(",").filter(Boolean);
  expect(new Set(reasons).size).toBe(reasons.length);
  return { value, decision: decision!, rule: response.headers.get("x-routing-rule-id"), reasons };
}
function routingRule(
  kind: Schemas["RoutingRule"]["kind"],
  priority: number,
  extra: Partial<Schemas["RoutingRule"]> = {},
): Schemas["RoutingRule"] {
  const id = randomUUID();
  rules.add(id);
  return { id, priority, kind, enabled: true, version: 1, ...extra };
}
async function routing(session = owner, query = "") {
  return session.read(orgPath(session, `routing${query}`), "PageRoutingRule");
}
async function save(
  value: Schemas["RoutingRule"][],
  options: { revision?: string; key?: string; session?: ApiSession } = {},
) {
  for (const rule of value) if (!originalRules.some((old) => old.id === rule.id)) rules.add(rule.id);
  const session = options.session ?? owner;
  const revision = options.revision ?? (await routing(session)).response.headers.get("etag")!;
  const response = await mutation(
    session,
    orgPath(session, "routing"),
    { rules: value },
    { method: "PUT", revision, key: options.key },
  );
  expect(response.status, await response.clone().text()).toBe(202);
  const job = await response.json();
  assertContract("Job", job);
  jobs.add(job.id);
  expect(job).toMatchObject({ kind: "crm.routing.updated", state: "succeeded" });
  return { response, job };
}
async function setActorGrants(value: Schemas["RoleWrite"]["permissions"]) {
  await admin.query(
    "UPDATE app.role_definition SET permission_grants=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, actorRole, JSON.stringify(value)],
  );
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
  originalEntitlement = (
    await admin.query(
      "SELECT state,effective_until FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA],
    )
  ).rows[0];
  originalRules = (
    await admin.query("SELECT * FROM app.routing_rule WHERE tenant_id=$1 ORDER BY priority,id", [
      fixtures.orgA,
    ])
  ).rows;
  for (const [id, grants] of [
    [actorRole, actorGrants],
    [recipientRole, recipientGrants],
  ] as const)
    await admin.query(
      "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants)VALUES($1,$2,$3,$4)",
      [fixtures.orgA, id, name(), JSON.stringify(grants)],
    );
  await admin.query(
    "INSERT INTO app.user_identity(id,issuer,subject,display_name,email,email_verified)VALUES($1,'urn:estate:synthetic',$2,$3,$4,true)",
    [outside.user, outside.user, name(), `${outside.user}@example.test`],
  );
  await admin.query(
    "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active',$5)",
    [fixtures.orgA, outside.member, outside.user, recipientRole, name()],
  );
  await admin.query(
    "INSERT INTO app.office(tenant_id,id,name,timezone)VALUES($1,$2,$3,'America/Los_Angeles')",
    [fixtures.orgA, office, name()],
  );
  for (const member of [owner.memberId, agent.memberId])
    await admin.query("INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3)", [
      fixtures.orgA,
      office,
      member,
    ]);
});
beforeEach(async () => {
  await setActorGrants(actorGrants);
  await admin.query(
    "UPDATE app.membership SET role_id=$3,status='active',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, agent.memberId, actorRole],
  );
});
afterEach(async () => {
  if (owner.orgId !== fixtures.orgA) expect((await owner.switchOrganization(fixtures.orgA)).status).toBe(200);
  await admin.query(
    "UPDATE app.membership SET role_id=$3,status=$4,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, agent.memberId, originalMember.role_id, originalMember.status],
  );
  await admin.query(
    "UPDATE app.membership SET status='active',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, outside.member],
  );
  await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3", [
    fixtures.orgA,
    office,
    outside.member,
  ]);
  await admin.query(
    "UPDATE app.role_definition SET permission_grants=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
    [fixtures.orgA, recipientRole, JSON.stringify(recipientGrants)],
  );
  await admin.query(
    "UPDATE app.entitlement SET state=$2,effective_until=$3,row_version=row_version+1 WHERE tenant_id=$1 AND feature='crm'",
    [fixtures.orgA, originalEntitlement.state, originalEntitlement.effective_until],
  );
  if (contacts.size)
    for (const row of (
      await admin.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND contact_id=ANY($2::uuid[])", [
        fixtures.orgA,
        [...contacts],
      ])
    ).rows)
      leads.add(row.id);
  const decisions = submissions.size
    ? (
        await admin.query(
          "SELECT id FROM app.capture_decision WHERE tenant_id=$1 AND source_submission_id=ANY($2::uuid[])",
          [fixtures.orgA, [...submissions]],
        )
      ).rows.map((row) => row.id)
    : [];
  const resources = [...leads, ...rules, ...jobs, ...decisions];
  if (resources.length) {
    const events = (
      await admin.query("SELECT id FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=ANY($2::text[])", [
        fixtures.orgA,
        resources,
      ])
    ).rows.map((row) => row.id);
    if (events.length) {
      await admin.query(
        "DELETE FROM app.outbox_consumer_receipt WHERE tenant_id=$1 AND event_id=ANY($2::uuid[])",
        [fixtures.orgA, events],
      );
      await admin.query("DELETE FROM app.outbox WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
        fixtures.orgA,
        events,
      ]);
    }
    await admin.query("DELETE FROM app.audit_event WHERE tenant_id=$1 AND resource_id=ANY($2::text[])", [
      fixtures.orgA,
      resources,
    ]);
  }
  if (decisions.length)
    await admin.query("DELETE FROM app.capture_decision WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      decisions,
    ]);
  if (leads.size) {
    for (const table of ["activity_event", "stage_transition", "lead_tag"])
      await admin.query(`DELETE FROM app.${table} WHERE tenant_id=$1 AND lead_id=ANY($2::uuid[])`, [
        fixtures.orgA,
        [...leads],
      ]);
    await admin.query("DELETE FROM app.lead WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...leads],
    ]);
  }
  if (contacts.size)
    await admin.query("DELETE FROM app.contact WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...contacts],
    ]);
  if (jobs.size)
    await admin.query("DELETE FROM app.integration_job WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...jobs],
    ]);
  if (rules.size) {
    await admin.query("DELETE FROM app.routing_distribution WHERE tenant_id=$1 AND rule_id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...rules],
    ]);
    await admin.query("DELETE FROM app.routing_rule WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgA,
      [...rules],
    ]);
  }
  // Restore only pre-existing routing rows, preserving monotonic resource versions and counters.
  const current =
    (await admin.query("SELECT min(priority) min FROM app.routing_rule WHERE tenant_id=$1", [fixtures.orgA]))
      .rows[0].min ?? 0;
  for (const [index, old] of originalRules.entries())
    await admin.query("UPDATE app.routing_rule SET priority=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      old.id,
      Math.min(-1, current - 1) - index,
    ]);
  for (const old of originalRules)
    await admin.query(
      "UPDATE app.routing_rule SET priority=$3,enabled=$4,condition=$5,assignment=$6,row_version=row_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [
        fixtures.orgA,
        old.id,
        old.priority,
        old.enabled,
        JSON.stringify(old.condition),
        JSON.stringify(old.assignment),
      ],
    );
  await admin.query(
    "UPDATE app.crm_routing_state SET row_version=row_version+1,updated_at=now() WHERE tenant_id=$1",
    [fixtures.orgA],
  );
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE tenant_id=$1 AND key=ANY($2::text[])", [
      fixtures.orgA,
      [...keys],
    ]);
  for (const set of [contacts, leads, rules, jobs, keys, submissions]) set.clear();
});
afterAll(async () => {
  await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2", [
    fixtures.orgA,
    office,
  ]);
  await admin.query("DELETE FROM app.office WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, office]);
  await admin.query("DELETE FROM app.membership WHERE tenant_id=$1 AND id=$2", [
    fixtures.orgA,
    outside.member,
  ]);
  await admin.query("DELETE FROM app.user_identity WHERE id=$1", [outside.user]);
  await admin.query("DELETE FROM app.role_definition WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
    fixtures.orgA,
    [actorRole, recipientRole],
  ]);
  await admin.end();
  await runtime.end();
});

describe("MOD-D-003/004 — synthetic native capture and serialized routing", () => {
  it("uses default first-touch before fallback and reports unavailable listing attribution honestly", async () => {
    const id = await person();
    const existing = await manualLead(id, agent.memberId);
    const sticky = await captured(command(id));
    expect(sticky.value.ownerMemberId).toBe(agent.memberId);
    expect(sticky.reasons).toEqual(["first_touch_selected"]);
    expect((await owner.read(orgPath(owner, `leads/${existing}`), "Lead")).body.score).toBeNull();
    const fallback = await captured(command(await person()));
    expect(fallback.reasons).toEqual([
      "first_touch_unavailable",
      "listing_attribution_unavailable",
      "round_robin_selected",
    ]);
    expect([owner.memberId, agent.memberId]).toContain(fallback.value.ownerMemberId);
  });

  it("serializes stable source-submission retries into one decision, lead and redacted event", async () => {
    const input = command(await person(), { intent: "buyer", timeline: "Synthetic private timeline" });
    const key = randomUUID();
    const results = await Promise.all([
      captured(input, owner, key),
      captured(input, owner, key),
      captured(input),
    ]);
    expect(new Set(results.map((result) => result.value.id)).size).toBe(1);
    expect(new Set(results.map((result) => result.decision)).size).toBe(1);
    expect(results[0].value).toMatchObject({
      score: 10,
      scoreVersion: "v1",
      intent: "buyer",
    });
    const inquiry = results[0];
    const reordered: NativeCaptureV1 = {
      timeline: input.timeline,
      intent: input.intent,
      sourceId: input.sourceId,
      contactId: input.contactId,
      sourceSubmissionId: input.sourceSubmissionId,
    };
    expect((await captured(reordered)).decision).toBe(inquiry.decision);
    const attribution = (
      await admin.query("SELECT attribution FROM app.lead WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        inquiry.value.id,
      ])
    ).rows[0].attribution;
    expect(attribution).toMatchObject({
      synthetic: true,
      source: "synthetic-native-inquiry",
      sourceId: input.sourceId,
      sourceSubmissionId: input.sourceSubmissionId,
      reasonCodes: inquiry.reasons,
    });
    expect(Number.isFinite(new Date(attribution.lastEventAt).getTime())).toBe(true);
    const decision = (
      await admin.query(
        "SELECT request_hash,safe_reason_codes FROM app.capture_decision WHERE tenant_id=$1 AND source_id=$2 AND source_submission_id=$3",
        [fixtures.orgA, input.sourceId, input.sourceSubmissionId],
      )
    ).rows;
    expect(decision).toHaveLength(1);
    expect(decision[0].request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(decision[0].safe_reason_codes).toEqual(inquiry.reasons);
    const events = (
      await admin.query(
        "SELECT payload FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='lead.captured'",
        [fixtures.orgA, inquiry.value.id],
      )
    ).rows;
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("Synthetic private timeline");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2 AND action='capture.decision_recorded'",
          [fixtures.orgA, inquiry.decision],
        )
      ).rows[0].count,
    ).toBe(1);
    await assertProblem(await mutation(owner, "/dev/capture", { ...input, timeline: "Changed" }), 409);
    await assertProblem(await mutation(owner, "/dev/capture", { ...input, intent: "seller" }, { key }), 409);
    await admin.query(
      "UPDATE app.lead SET intent='seller',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, inquiry.value.id],
    );
    const current = await captured(input, owner, key);
    expect(current.value).toMatchObject({ id: inquiry.value.id, version: 2, intent: "seller", score: 10 });
    expect(current.decision).toBe(inquiry.decision);
  });

  it("rechecks archived contact/lead, reassignment, source grants, membership and entitlement on replay", async () => {
    const input = command(await person(agent.memberId));
    const key = randomUUID();
    const initial = await captured(input, agent, key);
    expect(initial.value.ownerMemberId).toBe(agent.memberId);
    await admin.query("UPDATE app.contact SET archived_at=now() WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      input.contactId,
    ]);
    await assertProblem(await mutation(agent, "/dev/capture", input, { key }), 404);
    await admin.query("UPDATE app.contact SET archived_at=NULL WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      input.contactId,
    ]);
    await admin.query("UPDATE app.lead SET archived_at=now() WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      initial.value.id,
    ]);
    await assertProblem(await mutation(agent, "/dev/capture", input), 404);
    await admin.query(
      "UPDATE app.lead SET archived_at=NULL,owner_member_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, initial.value.id, owner.memberId],
    );
    await assertProblem(await mutation(agent, "/dev/capture", input, { key }), 404);
    await admin.query(
      "UPDATE app.lead SET owner_member_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, initial.value.id, agent.memberId],
    );
    await setActorGrants(actorGrants.filter((grant) => grant.code !== "crm.sources.read"));
    await assertProblem(await mutation(agent, "/dev/capture", input, { key }), 403);
    await setActorGrants(actorGrants);
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      agent.memberId,
    ]);
    await assertProblem(await mutation(agent, "/dev/capture", input, { key }), 403);
    await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      agent.memberId,
    ]);
    await admin.query("UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND feature='crm'", [
      fixtures.orgA,
    ]);
    await assertProblem(await mutation(agent, "/dev/capture", input, { key }), 403);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.capture_decision WHERE tenant_id=$1 AND source_submission_id=$2",
          [fixtures.orgA, input.sourceSubmissionId],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("rejects body authority/protected signals, foreign contacts/sources and missing CSRF", async () => {
    const input = command(await person());
    for (const extra of [
      { tenantId: fixtures.orgB },
      { ownerMemberId: fixtures.agentMemberB },
      { siteId: randomUUID() },
      { protectedAttributes: { race: "synthetic" } },
      { income: 1 },
    ])
      await assertProblem(await mutation(owner, "/dev/capture", { ...input, ...extra }), 422);
    await assertProblem(await mutation(owner, "/dev/capture", { ...input, sourceId: fixtures.sourceB }), 422);
    await assertProblem(
      await mutation(owner, "/dev/capture", { ...input, contactId: fixtures.contactB }),
      404,
    );
    await assertProblem(await mutation(owner, "/dev/capture", input, { csrf: "wrong-token" }), 403);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.capture_decision WHERE tenant_id=$1 AND source_submission_id=$2",
          [fixtures.orgA, input.sourceSubmissionId],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("uses normalized postal routing after unavailable attribution and retains deterministic synthetic scoring", async () => {
    const geo = routingRule("geography", 20, {
      postalCodes: ["  a1b 2c3  "],
      memberWeights: [{ memberId: outside.member, weight: 1 }],
    });
    const listing = routingRule("listing_agent", 10);
    const rr = routingRule("round_robin", 30, { memberWeights: [{ memberId: owner.memberId, weight: 1 }] });
    await save([listing, geo, rr]);
    const routed = await captured(command(await person(), { postalCode: "a1b 2c3", intent: "unknown" }));
    expect(routed.value.ownerMemberId).toBe(outside.member);
    expect(routed.rule).toBe(geo.id);
    expect(routed.reasons).toEqual(["listing_attribution_unavailable", "geography_selected"]);
    expect(routed.value).toMatchObject({ score: 10, scoreVersion: "v1" });
    const fallback = await captured(command(await person(), { postalCode: "DIFFERENT", intent: "seller" }));
    expect(fallback.value.ownerMemberId).toBe(owner.memberId);
    expect(fallback.reasons).toEqual([
      "listing_attribution_unavailable",
      "geography_unmatched",
      "round_robin_selected",
    ]);
    expect(fallback.value.score).toBe(routed.value.score);
  });

  it("honors configured priority across rule kinds while default seed order remains explicit", async () => {
    const rr = routingRule("round_robin", 0, {
      memberWeights: [{ memberId: owner.memberId, weight: 1 }],
    });
    const firstTouch = routingRule("first_touch", 90);
    await save([rr, firstTouch]);
    const firstContact = await person();
    await manualLead(firstContact, agent.memberId);
    const override = await captured(command(firstContact));
    expect(override.value.ownerMemberId).toBe(owner.memberId);
    expect(override.rule).toBe(rr.id);
    expect(override.reasons).toEqual(["round_robin_selected"]);
    const current = (await routing()).body.items;
    await save(current.map((rule) => ({ ...rule, priority: rule.id === firstTouch.id ? 0 : 90 })));
    const secondContact = await person();
    await manualLead(secondContact, agent.memberId);
    const sticky = await captured(command(secondContact));
    expect(sticky.value.ownerMemberId).toBe(agent.memberId);
    expect(sticky.rule).toBe(firstTouch.id);
    expect(sticky.reasons).toEqual(["first_touch_selected"]);
  });

  it("serializes weighted round-robin races without losing assignments or advancing on retries", async () => {
    const rr = routingRule("round_robin", 0, {
      memberWeights: [
        { memberId: owner.memberId, weight: 1 },
        { memberId: agent.memberId, weight: 3 },
      ],
    });
    await save([rr]);
    const inputs = await Promise.all(Array.from({ length: 8 }, async () => command(await person())));
    const results = await Promise.all(inputs.map((input) => captured(input)));
    expect(results.filter((result) => result.value.ownerMemberId === owner.memberId)).toHaveLength(2);
    expect(results.filter((result) => result.value.ownerMemberId === agent.memberId)).toHaveLength(6);
    expect(new Set(results.map((result) => result.value.id)).size).toBe(8);
    expect(
      results.every((result) => result.rule === rr.id && result.reasons.join(",") === "round_robin_selected"),
    ).toBe(true);
    await captured(inputs[0]);
    expect(
      String(
        (
          await admin.query(
            "SELECT next_sequence FROM app.routing_distribution WHERE tenant_id=$1 AND rule_id=$2",
            [fixtures.orgA, rr.id],
          )
        ).rows[0].next_sequence,
      ),
    ).toBe("8");
  });

  it("skips currently disabled or office-ineligible team recipients and uses an explicit unassigned queue", async () => {
    const rr = routingRule("round_robin", 0, { memberWeights: [{ memberId: outside.member, weight: 1 }] });
    await save([rr]);
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      outside.member,
    ]);
    const disabled = await captured(command(await person()));
    expect(disabled.value.ownerMemberId).toBeNull();
    expect(disabled.rule).toBeNull();
    expect(disabled.reasons).toEqual(["no_eligible_recipient", "unassigned_queue"]);
    await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      outside.member,
    ]);
    await admin.query(
      "UPDATE app.role_definition SET permission_grants=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [
        fixtures.orgA,
        recipientRole,
        JSON.stringify(recipientGrants.map((grant) => ({ ...grant, scope: "team" }))),
      ],
    );
    const noOffice = await captured(command(await person()));
    expect(noOffice.value.ownerMemberId).toBeNull();
    expect(noOffice.reasons).toContain("unassigned_queue");
    await admin.query("INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3)", [
      fixtures.orgA,
      office,
      outside.member,
    ]);
    const eligibleTeam = await captured(command(await person()));
    expect(eligibleTeam.value.ownerMemberId).toBe(outside.member);
    expect(eligibleTeam.reasons).toEqual(["round_robin_selected"]);
    await assertProblem(await mutation(agent, "/dev/capture", command(await person(agent.memberId))), 422);
  });

  it("keeps aggregate replacement organization-scoped and filters recipient readback to current offices", async () => {
    const rr = routingRule("round_robin", 0, {
      memberWeights: [
        { memberId: owner.memberId, weight: 1 },
        { memberId: agent.memberId, weight: 1 },
        { memberId: outside.member, weight: 1 },
      ],
    });
    await save([rr]);
    const own = (await routing(agent)).body.items;
    expect(own.flatMap((rule) => rule.memberWeights ?? []).map((weight) => weight.memberId)).toEqual([
      agent.memberId,
    ]);
    const etag = (await routing(agent)).response.headers.get("etag")!;
    await assertProblem(
      await mutation(agent, orgPath(agent, "routing"), { rules: [rr] }, { method: "PUT", revision: etag }),
      403,
    );
    await setActorGrants(
      actorGrants.map((grant) =>
        grant.code.startsWith("crm.routing.") ? { ...grant, scope: "team" } : grant,
      ),
    );
    const team = (await routing(agent)).body.items
      .flatMap((rule) => rule.memberWeights ?? [])
      .map((weight) => weight.memberId);
    expect(new Set(team)).toEqual(new Set([owner.memberId, agent.memberId]));
    expect(team).not.toContain(outside.member);
    await assertProblem(
      await mutation(agent, orgPath(agent, "routing"), { rules: [] }, { method: "PUT", revision: etag }),
      403,
    );
    await assertProblem(await agent.request(`/v1/orgs/${fixtures.orgB}/routing`), 403);
  });

  it("requires aggregate and rule revisions, and creates one completed job on idempotent replacement", async () => {
    const current = await routing();
    const version = current.response.headers.get("etag")!;
    const rr = routingRule("round_robin", 0, { memberWeights: [{ memberId: owner.memberId, weight: 1 }] });
    await assertProblem(
      await mutation(owner, orgPath(owner, "routing"), { rules: [rr] }, { method: "PUT" }),
      400,
    );
    for (const malformed of ['"invalid"', '"1', '1"', 'W/"1"'])
      await assertProblem(
        await mutation(
          owner,
          orgPath(owner, "routing"),
          { rules: [rr] },
          { method: "PUT", revision: malformed },
        ),
        400,
      );
    const key = randomUUID();
    const updated = await save([rr], { key, revision: version });
    const replay = await save([rr], { key, revision: version });
    expect(replay.job.id).toBe(updated.job.id);
    await assertProblem(
      await mutation(owner, orgPath(owner, "routing"), { rules: [] }, { method: "PUT", revision: version }),
      412,
    );
    const latest = (await routing()).body.items;
    const aggregate = (await routing()).response.headers.get("etag")!;
    await assertProblem(
      await mutation(
        owner,
        orgPath(owner, "routing"),
        { rules: latest.map((rule) => ({ ...rule, version: rule.version + 1 })) },
        { method: "PUT", revision: aggregate },
      ),
      412,
    );
    const next = routingRule("first_touch", 20, { version: 2 });
    await assertProblem(
      await mutation(
        owner,
        orgPath(owner, "routing"),
        { rules: [...latest, next] },
        { method: "PUT", revision: aggregate },
      ),
      422,
    );
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.integration_job WHERE tenant_id=$1 AND id=$2",
          [fixtures.orgA, updated.job.id],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("retains retired rule IDs and capture foreign keys while rejecting reactivation and stale cursors", async () => {
    const rr = routingRule("round_robin", 0, { memberWeights: [{ memberId: owner.memberId, weight: 1 }] });
    const disabled = routingRule("listing_agent", 10, { enabled: false });
    await save([rr, disabled]);
    const first = await routing(owner, "?limit=1");
    expect(first.body.hasMore).toBe(true);
    const inquiry = await captured(command(await person()));
    await save([]);
    expect((await routing()).body.items).toEqual([]);
    const retired = (
      await admin.query(
        "SELECT priority,enabled,condition FROM app.routing_rule WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, rr.id],
      )
    ).rows[0];
    expect(retired.priority).toBeLessThan(0);
    expect(retired).toMatchObject({ enabled: false, condition: { retired: true } });
    expect(
      (
        await admin.query("SELECT winning_rule_id FROM app.capture_decision WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          inquiry.decision,
        ])
      ).rows[0].winning_rule_id,
    ).toBe(rr.id);
    expect(
      (await captured(command(inquiry.value.contactId, { sourceSubmissionId: [...submissions][0] })))
        .decision,
    ).toBe(inquiry.decision);
    const revision = (await routing()).response.headers.get("etag")!;
    await assertProblem(
      await mutation(owner, orgPath(owner, "routing"), { rules: [rr] }, { method: "PUT", revision }),
      409,
    );
    await assertProblem(
      await owner.request(
        orgPath(owner, `routing?limit=1&cursor=${encodeURIComponent(first.body.nextCursor!)}`),
      ),
      422,
    );
  });

  it("rejects malformed rule combinations and foreign/disabled/unqualified recipients without changing state", async () => {
    const revision = (await routing()).response.headers.get("etag")!;
    const valid = routingRule("round_robin", 0, { memberWeights: [{ memberId: owner.memberId, weight: 1 }] });
    for (const invalid of [
      { ...valid, kind: "first_touch" },
      { ...valid, kind: "geography", postalCodes: [] },
      { ...valid, memberWeights: [{ memberId: fixtures.agentMemberB, weight: 1 }] },
      { ...valid, memberWeights: [{ memberId: owner.memberId, weight: 0 }] },
      {
        ...valid,
        memberWeights: [
          { memberId: owner.memberId, weight: 1 },
          { memberId: owner.memberId, weight: 2 },
        ],
      },
      { ...valid, kind: "geography", postalCodes: ["a1", " A1 "] },
    ])
      await assertProblem(
        await mutation(owner, orgPath(owner, "routing"), { rules: [invalid] }, { method: "PUT", revision }),
        422,
      );
    await assertProblem(
      await mutation(
        owner,
        orgPath(owner, "routing"),
        { rules: [valid, { ...valid, id: randomUUID() }] },
        { method: "PUT", revision },
      ),
      422,
    );
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      outside.member,
    ]);
    await assertProblem(
      await mutation(
        owner,
        orgPath(owner, "routing"),
        { rules: [{ ...valid, memberWeights: [{ memberId: outside.member, weight: 1 }] }] },
        { method: "PUT", revision },
      ),
      422,
    );
    await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      outside.member,
    ]);
    await admin.query(
      "UPDATE app.role_definition SET permission_grants='[]',row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, recipientRole],
    );
    await assertProblem(
      await mutation(
        owner,
        orgPath(owner, "routing"),
        { rules: [{ ...valid, memberWeights: [{ memberId: outside.member, weight: 1 }] }] },
        { method: "PUT", revision },
      ),
      422,
    );
    expect((await routing()).response.headers.get("etag")).toBe(revision);
  });

  it("rolls back the entire native capture when the invoking tenant transaction fails after the service port returns", async () => {
    const input = command(await person());
    let result: Awaited<ReturnType<NativeCaptureService["capture"]>> | undefined;
    await expect(
      withTenantTransaction(
        runtime,
        { userId: fixtures.ownerUser, organizationId: fixtures.orgA },
        async (client, context) => {
          result = await new NativeCaptureService(client, context, randomUUID()).capture(input);
          throw new Error("Synthetic caller rollback");
        },
      ),
    ).rejects.toThrow("Synthetic caller rollback");
    expect(result).toBeDefined();
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.capture_decision WHERE tenant_id=$1 AND source_submission_id=$2",
          [fixtures.orgA, input.sourceSubmissionId],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await admin.query("SELECT count(*)::int count FROM app.lead WHERE tenant_id=$1 AND contact_id=$2", [
          fixtures.orgA,
          input.contactId,
        ])
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2",
          [fixtures.orgA, result!.lead.id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.audit_event WHERE tenant_id=$1 AND resource_id=ANY($2::text[])",
          [fixtures.orgA, [result!.decisionId, result!.lead.id]],
        )
      ).rows[0].count,
    ).toBe(0);
  });
});
