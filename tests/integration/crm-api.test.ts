import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
let agent: ApiSession;
let sourceId: string;
const unique = () => `Synthetic acceptance ${randomUUID()}`;

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
  const sources = await owner.read(`/v1/orgs/${owner.orgId}/lead-sources`, "PageLeadSource");
  sourceId = sources.body.items[0].id;
});
afterAll(async () => {
  await admin.end();
});

async function capture(session: ApiSession, ownerMemberId: string | null = session.memberId) {
  const name = unique();
  const contactResponse = await session.command(`/v1/orgs/${session.orgId}/contacts`, {
    displayName: name,
    emails: [`${randomUUID()}@example.invalid`],
  } satisfies Schemas["ContactWrite"]);
  expect(contactResponse.status).toBe(201);
  const contact = await contactResponse.json();
  assertContract("Contact", contact);
  const leadResponse = await session.command(`/v1/orgs/${session.orgId}/leads`, {
    contactId: contact.id,
    sourceId,
    ownerMemberId,
    intent: "buyer",
    timeline: null,
  } satisfies Schemas["LeadCreate"]);
  expect(leadResponse.status).toBe(201);
  const lead = await leadResponse.json();
  assertContract("Lead", lead);
  return { contact, lead, name, revision: leadResponse.headers.get("etag") ?? `"${lead.version}"` };
}

describe("M1/M2 — verified sessions, tenant and own scope", () => {
  it("rejects anonymous CRM and returns the exact Session contract without exposing auth material", async () => {
    await assertProblem(await new ApiSession().request(`/v1/orgs/${owner.orgId}/leads`), 401);
    const response = await owner.request("/v1/session");
    const session = await response.json();
    assertContract("Session", session);
    expect(Object.keys(session).sort()).toEqual([
      "activeOrgId",
      "organizations",
      "permissions",
      "profile",
      "userId",
    ]);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("ignores fabricated tenant evidence and resets active organization context on switch", async () => {
    const isolatedOwner = await new ApiSession().signIn("owner");
    const firstOrg = isolatedOwner.orgId;
    const secondOrg = isolatedOwner.session.organizations.find(
      (organization) => organization.id !== firstOrg,
    )?.id;
    expect(secondOrg).toBeTruthy();
    await assertProblem(await isolatedOwner.request(`/v1/orgs/${randomUUID()}/leads`), 403);
    const firstLeadIds = (await isolatedOwner.read(`/v1/orgs/${firstOrg}/leads`, "PageLead")).body.items.map(
      (lead) => lead.id,
    );
    expect((await isolatedOwner.switchOrganization(secondOrg!)).status).toBe(200);
    expect(isolatedOwner.orgId).toBe(secondOrg);
    await assertProblem(await isolatedOwner.request(`/v1/orgs/${firstOrg}/leads`), 403);
    const secondLeads = (await isolatedOwner.read(`/v1/orgs/${secondOrg}/leads`, "PageLead")).body.items;
    expect(secondLeads.every((lead) => !firstLeadIds.includes(lead.id))).toBe(true);
    await assertProblem(await agent.switchOrganization(secondOrg!), 403);
    expect(agent.orgId).toBe(firstOrg);
  });

  it("membership bootstrap visibility cannot leak another organization into the active member list", async () => {
    const members = (await owner.read(`/v1/orgs/${owner.orgId}/members?limit=100`, "PageMember")).body.items;
    const expected = (
      await admin.query("SELECT id FROM app.membership WHERE tenant_id=$1 ORDER BY id", [owner.orgId])
    ).rows.map((row) => row.id);
    expect(members.map((member) => member.id).sort()).toEqual(expected);
  });

  it("applies own scope to list, detail, task actions and dashboard source records", async () => {
    const ownedByOwner = await capture(owner);
    const ownedByAgent = await capture(owner, agent.memberId);
    const leads = (await agent.read(`/v1/orgs/${agent.orgId}/leads?limit=100`, "PageLead")).body.items;
    expect(leads.every((lead) => lead.ownerMemberId === agent.memberId)).toBe(true);
    expect(leads.map((lead) => lead.id)).not.toContain(ownedByOwner.lead.id);
    const detail = await agent.request(`/v1/orgs/${agent.orgId}/leads/${ownedByAgent.lead.id}`);
    expect(detail.status).toBe(200);
    await assertProblem(await agent.request(`/v1/orgs/${agent.orgId}/leads/${ownedByOwner.lead.id}`), 404);
    await assertProblem(
      await agent.command(
        `/v1/orgs/${agent.orgId}/leads/${ownedByOwner.lead.id}`,
        { intent: "seller" },
        { method: "PATCH", revision: ownedByOwner.revision },
      ),
      404,
    );
    const dashboard = (await agent.read(`/v1/orgs/${agent.orgId}/dashboard`, "Dashboard")).body;
    expect(dashboard.tasks.every((task) => task.assigneeMemberId === agent.memberId)).toBe(true);
  });

  it("rechecks membership on an existing session after membership revocation", async () => {
    const current = await admin.query("SELECT status FROM app.membership WHERE tenant_id=$1 AND id=$2", [
      agent.orgId,
      agent.memberId,
    ]);
    try {
      await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
        agent.orgId,
        agent.memberId,
      ]);
      await assertProblem(await agent.request(`/v1/orgs/${agent.orgId}/leads`), 403);
      await assertProblem(await agent.request(`/v1/orgs/${agent.orgId}/dashboard`), 403);
    } finally {
      await admin.query("UPDATE app.membership SET status=$3 WHERE tenant_id=$1 AND id=$2", [
        agent.orgId,
        agent.memberId,
        current.rows[0].status,
      ]);
    }
  });

  it("requires CSRF and rejects undeclared request properties before persisting a command", async () => {
    await assertProblem(
      await owner.command(
        `/v1/orgs/${owner.orgId}/contacts`,
        { displayName: unique() },
        { csrf: "wrong-token" },
      ),
      403,
    );
    await assertProblem(
      await owner.request(`/v1/orgs/${owner.orgId}/contacts`, {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: JSON.stringify({ displayName: unique() }),
      }),
      403,
    );
    await assertProblem(
      await owner.command(`/v1/orgs/${owner.orgId}/contacts`, {
        displayName: unique(),
        tenantId: randomUUID(),
      }),
      422,
    );
    await assertProblem(
      await owner.command(`/v1/orgs/${owner.orgId}/contacts`, {
        displayName: unique(),
        emails: ["not-an-email"],
      }),
      422,
    );
    await assertProblem(
      await owner.request(`/v1/orgs/${owner.orgId}/contacts`, {
        method: "POST",
        headers: {
          origin: "https://untrusted.example.invalid",
          "idempotency-key": randomUUID(),
          "x-csrf-token": owner.csrf,
        },
        body: JSON.stringify({ displayName: unique() }),
      }),
      403,
    );
  });

  it("two concurrent owner removals retain an active owner and reject final-owner removal", async () => {
    const original = (
      await admin.query(
        "SELECT id,status,role_id FROM app.membership WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
        [owner.orgId, [owner.memberId, agent.memberId]],
      )
    ).rows;
    const ownerRole = original.find((row) => row.id === owner.memberId).role_id;
    const members = (await owner.read(`/v1/orgs/${owner.orgId}/members`, "PageMember")).body.items;
    const agentDetail = { body: members.find((member) => member.id === agent.memberId)! };
    const ownDetail = { body: members.find((member) => member.id === owner.memberId)! };
    const ownerPath = `/v1/orgs/${owner.orgId}/members/${owner.memberId}`;
    await assertProblem(
      await owner.command(
        ownerPath,
        { status: "disabled" },
        { method: "PATCH", revision: `"${ownDetail.body.version}"` },
      ),
      409,
    );
    try {
      const promoted = await owner.command(
        `/v1/orgs/${owner.orgId}/members/${agent.memberId}`,
        { roleId: ownerRole },
        { method: "PATCH", revision: `"${agentDetail.body.version}"` },
      );
      expect(promoted.status).toBe(200);
      const promotedAgent = await promoted.json();
      assertContract("Member", promotedAgent);
      const secondOwner = await new ApiSession().signIn("agent");
      const results = await Promise.all([
        owner.command(
          `/v1/orgs/${owner.orgId}/members/${agent.memberId}`,
          { status: "disabled" },
          { method: "PATCH", revision: `"${promotedAgent.version}"` },
        ),
        secondOwner.command(
          ownerPath,
          { status: "disabled" },
          { method: "PATCH", revision: `"${ownDetail.body.version}"` },
        ),
      ]);
      expect(results.filter((response) => response.status === 200)).toHaveLength(1);
      expect(results.every((response) => [200, 403, 409].includes(response.status))).toBe(true);
      const owners = await admin.query(
        "SELECT count(*)::int count FROM app.membership m JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id) WHERE m.tenant_id=$1 AND m.status='active' AND r.name='Owner'",
        [owner.orgId],
      );
      expect(owners.rows[0].count).toBe(1);
    } finally {
      for (const row of original)
        await admin.query(
          "UPDATE app.membership SET status=$3,role_id=$4,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
          [owner.orgId, row.id, row.status, row.role_id],
        );
    }
  });
});

describe("M2 — durable CRM commands and optimistic concurrency", () => {
  it("a nested note command retries once and retains the parent lead revision boundary", async () => {
    const { lead, revision } = await capture(agent);
    const path = `/v1/orgs/${agent.orgId}/leads/${lead.id}/notes`;
    const body: Schemas["NoteWrite"] = { body: `Synthetic note ${randomUUID()}` };
    const key = randomUUID();
    const created = await agent.command(path, body, { key, revision });
    expect(created.status).toBe(201);
    const note = await created.json();
    assertContract("Note", note);
    const replay = await agent.command(path, body, { key, revision });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(note);
    await assertProblem(await agent.command(path, { body: `${body.body} changed` }, { key, revision }), 409);
    await assertProblem(await agent.command(path, body, { revision }), 412);
    const notes = (await agent.read(path, "PageNote")).body.items;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual(note);
    expect((await agent.read(`/v1/orgs/${agent.orgId}/leads/${lead.id}`, "Lead")).body.version).toBe(
      lead.version + 1,
    );
  });
  it("an idempotency replay rechecks current resource scope after reassignment", async () => {
    const contactResponse = await agent.command(`/v1/orgs/${agent.orgId}/contacts`, {
      displayName: unique(),
    });
    expect(contactResponse.status).toBe(201);
    const contact = await contactResponse.json();
    assertContract("Contact", contact);
    const input: Schemas["LeadCreate"] = {
      contactId: contact.id,
      sourceId,
      ownerMemberId: agent.memberId,
      intent: "buyer",
    };
    const key = randomUUID();
    const captured = await agent.command(`/v1/orgs/${agent.orgId}/leads`, input, { key });
    expect(captured.status).toBe(201);
    const lead = await captured.json();
    assertContract("Lead", lead);
    const changed = await owner.command(
      `/v1/orgs/${owner.orgId}/leads/${lead.id}`,
      { ownerMemberId: owner.memberId },
      { method: "PATCH", revision: `"${lead.version}"` },
    );
    expect(changed.status).toBe(200);
    await assertProblem(await agent.command(`/v1/orgs/${agent.orgId}/leads`, input, { key }), 404);
    await assertProblem(await agent.request(`/v1/orgs/${agent.orgId}/contacts/${contact.id}`), 404);
  });
  it("concurrent retries create one lead, one audit event and one outbox event; changed input conflicts", async () => {
    const contactResponse = await owner.command(`/v1/orgs/${owner.orgId}/contacts`, {
      displayName: unique(),
    });
    expect(contactResponse.status).toBe(201);
    const contact = await contactResponse.json();
    assertContract("Contact", contact);
    const body: Schemas["LeadCreate"] = {
      contactId: contact.id,
      sourceId,
      ownerMemberId: agent.memberId,
      intent: "buyer",
    };
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 3 }, () => owner.command(`/v1/orgs/${owner.orgId}/leads`, body, { key })),
    );
    for (const response of responses) expect(response.status).toBe(201);
    const leads = await Promise.all(responses.map((response) => response.json()));
    for (const lead of leads) assertContract("Lead", lead);
    expect(new Set(leads.map((lead) => lead.id)).size).toBe(1);
    expect(
      (
        await admin.query("SELECT count(*)::int count FROM app.lead WHERE tenant_id=$1 AND contact_id=$2", [
          owner.orgId,
          contact.id,
        ])
      ).rows[0].count,
    ).toBe(1);
    const auditCount = await admin.query(
      "SELECT count(*)::int count FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2",
      [owner.orgId, leads[0].id],
    );
    expect(auditCount.rows[0].count).toBe(1);
    const outboxCount = await admin.query(
      "SELECT count(*)::int count FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2",
      [owner.orgId, leads[0].id],
    );
    expect(outboxCount.rows[0].count).toBe(1);
    await assertProblem(
      await owner.command(`/v1/orgs/${owner.orgId}/leads`, { ...body, intent: "seller" }, { key }),
      409,
    );
  });

  it("two writers using the same lead revision cannot silently overwrite one another", async () => {
    const { lead, revision } = await capture(owner);
    const path = `/v1/orgs/${owner.orgId}/leads/${lead.id}`;
    const before = (await owner.read(`${path}/activity`, "PageActivity")).body.items;
    const responses = await Promise.all([
      owner.command(path, { timeline: "within 3 months" }, { method: "PATCH", revision }),
      owner.command(path, { timeline: "within 6 months" }, { method: "PATCH", revision }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    const stale = responses.find((response) => response.status === 412)!;
    await assertProblem(stale, 412);
    const saved = (await owner.read(path, "Lead")).body;
    expect(saved.version).toBe(lead.version + 1);
    expect(["within 3 months", "within 6 months"]).toContain(saved.timeline);
    const activity = (await owner.read(`${path}/activity`, "PageActivity")).body;
    expect(activity.items).toEqual(expect.arrayContaining(before));
    expect(
      (
        await admin.query(
          "SELECT count(*)::int count FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2",
          [owner.orgId, lead.id],
        )
      ).rows[0].count,
    ).toBe(2);
  });

  it("rejects cross-organization and disabled assignment while preserving existing owner", async () => {
    const { lead, revision } = await capture(owner);
    const differentOrganization = owner.session.organizations.find(
      (organization) => organization.id !== owner.orgId,
    )!.id;
    const foreignMember = (
      await admin.query("SELECT id FROM app.membership WHERE tenant_id=$1 AND status='active' LIMIT 1", [
        differentOrganization,
      ])
    ).rows[0].id;
    const path = `/v1/orgs/${owner.orgId}/leads/${lead.id}`;
    await assertProblem(
      await owner.command(path, { ownerMemberId: foreignMember }, { method: "PATCH", revision }),
      422,
    );
    try {
      await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
        agent.orgId,
        agent.memberId,
      ]);
      await assertProblem(
        await owner.command(path, { ownerMemberId: agent.memberId }, { method: "PATCH", revision }),
        422,
      );
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        agent.orgId,
        agent.memberId,
      ]);
    }
    expect((await owner.read(path, "Lead")).body.ownerMemberId).toBe(owner.memberId);
  });

  it("captures, assigns, follows up and moves a lead without duplicating task-completion events", async () => {
    const { lead } = await capture(owner, agent.memberId);
    const taskWrite: Schemas["TaskWrite"] = {
      leadId: lead.id,
      assigneeMemberId: agent.memberId,
      title: unique(),
      dueAt: "2026-11-01T17:00:00.000Z",
      timezone: "America/Los_Angeles",
      priority: "high",
      state: "open",
    };
    const createdResponse = await agent.command(`/v1/orgs/${agent.orgId}/tasks`, taskWrite);
    expect(createdResponse.status).toBe(201);
    const task = await createdResponse.json();
    assertContract("Task", task);
    const key = randomUUID();
    const revision = createdResponse.headers.get("etag") ?? `"${task.version}"`;
    const path = `/v1/orgs/${agent.orgId}/tasks/${task.id}`;
    const complete = await agent.command(
      path,
      { ...taskWrite, state: "done" },
      { method: "PATCH", key, revision },
    );
    expect(complete.status).toBe(200);
    const completed = await complete.json();
    assertContract("Task", completed);
    expect(completed.state).toBe("done");
    expect(completed.version).toBe(task.version + 1);
    const replay = await agent.command(
      path,
      { ...taskWrite, state: "done" },
      { method: "PATCH", key, revision },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(completed);
    await assertProblem(
      await agent.command(path, { ...taskWrite, state: "cancelled" }, { method: "PATCH", revision }),
      412,
    );
    const events = await admin.query(
      "SELECT count(*)::int count FROM app.activity_event WHERE tenant_id=$1 AND lead_id=$2 AND event_type='task.completed' AND safe_data->>'resourceId'=$3",
      [agent.orgId, lead.id, task.id],
    );
    expect(events.rows[0].count).toBe(1);
    const stages = (await agent.read(`/v1/orgs/${agent.orgId}/pipeline-stages`, "PagePipelineStage")).body
      .items;
    const nextStage = stages.find((stage) => stage.name === "Attempted Contact")!;
    const latest = await agent.read(`/v1/orgs/${agent.orgId}/leads/${lead.id}`, "Lead");
    const transition = await agent.command(
      `/v1/orgs/${agent.orgId}/leads/${lead.id}/stage-transitions`,
      { toStageId: nextStage.id, reason: "Synthetic follow-up completed" },
      { revision: latest.response.headers.get("etag") ?? `"${latest.body.version}"` },
    );
    expect(transition.status).toBe(201);
    expect((await agent.read(`/v1/orgs/${agent.orgId}/leads/${lead.id}`, "Lead")).body.stageId).toBe(
      nextStage.id,
    );
  });

  it("requires an actual IANA timezone and non-empty task title", async () => {
    await assertProblem(
      await agent.command(`/v1/orgs/${agent.orgId}/tasks`, {
        assigneeMemberId: agent.memberId,
        title: unique(),
        dueAt: "2026-11-01T17:00:00.000Z",
        timezone: "Mars/Olympus",
      }),
      422,
    );
    await assertProblem(
      await agent.command(`/v1/orgs/${agent.orgId}/tasks`, {
        assigneeMemberId: agent.memberId,
        title: "   ",
        dueAt: "2026-11-01T17:00:00.000Z",
        timezone: "America/Los_Angeles",
      }),
      422,
    );
  });
});
