import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
let agent: ApiSession;
let agentRoleB: string;
let agentEmail: string;
const invitationIds = new Set<string>();
const jobIds = new Set<string>();
const roleIds = new Set<string>();
const memberIds = new Set<string>();
const keys = new Set<string>();
const syntheticName = () => `Synthetic administration ${randomUUID()}`;

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
  expect((await owner.switchOrganization(fixtures.orgB)).status).toBe(200);
  agentRoleB = (
    await admin.query("SELECT id FROM app.role_definition WHERE tenant_id=$1 AND name='Agent'", [
      fixtures.orgB,
    ])
  ).rows[0].id;
  agentEmail = (await admin.query("SELECT email FROM app.user_identity WHERE id=$1", [fixtures.agentUser]))
    .rows[0].email;
});

afterEach(async () => {
  if (agent?.orgId !== fixtures.orgA)
    expect((await agent.switchOrganization(fixtures.orgA)).status).toBe(200);
  if (jobIds.size)
    await admin.query("DELETE FROM app.integration_job WHERE id=ANY($1::uuid[])", [[...jobIds]]);
  if (invitationIds.size)
    await admin.query("DELETE FROM app.member_invitation WHERE id=ANY($1::uuid[])", [[...invitationIds]]);
  if (memberIds.size) {
    await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])", [
      fixtures.orgB,
      [...memberIds],
    ]);
    await admin.query("DELETE FROM app.membership WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
      fixtures.orgB,
      [...memberIds],
    ]);
  }
  if (roleIds.size)
    await admin.query("DELETE FROM app.role_definition WHERE id=ANY($1::uuid[])", [[...roleIds]]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  invitationIds.clear();
  jobIds.clear();
  memberIds.clear();
  roleIds.clear();
  keys.clear();
});
afterAll(async () => {
  await admin.end();
});

async function invite(email = agentEmail, key = randomUUID()) {
  keys.add(key);
  const input: Schemas["InviteMember"] = { email, roleId: agentRoleB };
  const response = await owner.command(`/v1/orgs/${owner.orgId}/member-invitations`, input, { key });
  expect(response.status).toBe(202);
  const job = await response.json();
  assertContract("Job", job);
  jobIds.add(job.id);
  expect(job.kind).toContain("no-delivery");
  const token = response.headers.get("x-synthetic-invitation-token");
  expect(token).toBeTruthy();
  const row = (
    await admin.query("SELECT id,token_hash FROM app.member_invitation WHERE token_hash=$1", [
      createHash("sha256").update(token!).digest("hex"),
    ])
  ).rows[0];
  expect(row).toBeTruthy();
  expect(row.token_hash).not.toBe(token);
  invitationIds.add(row.id);
  return { input, job, token: token!, invitationId: row.id, key };
}

describe("M2 — original administration contracts and scoped synthetic invitations", () => {
  it("organization changes require current revisions and leave stale writes unapplied", async () => {
    const current = await owner.read(`/v1/orgs/${owner.orgId}`, "Organization");
    const stored = (
      await admin.query("SELECT name,timezone,locale FROM app.organization WHERE id=$1", [owner.orgId])
    ).rows[0];
    try {
      const input: Schemas["OrganizationCreate"] = {
        name: syntheticName(),
        timezone: "America/Los_Angeles",
        locale: "en-US",
      };
      const updated = await owner.command(`/v1/orgs/${owner.orgId}`, input, {
        method: "PATCH",
        revision: `"${current.body.version}"`,
      });
      expect(updated.status).toBe(200);
      const body = await updated.json();
      assertContract("Organization", body);
      expect(body.version).toBe(current.body.version + 1);
      await assertProblem(
        await owner.command(
          `/v1/orgs/${owner.orgId}`,
          { ...input, name: "Synthetic stale overwrite" },
          { method: "PATCH", revision: `"${current.body.version}"` },
        ),
        412,
      );
      expect((await owner.read(`/v1/orgs/${owner.orgId}`, "Organization")).body.name).toBe(input.name);
    } finally {
      await admin.query(
        "UPDATE app.organization SET name=$2,timezone=$3,locale=$4,row_version=row_version+1 WHERE id=$1",
        [owner.orgId, stored.name, stored.timezone, stored.locale],
      );
    }
  });

  it("custom roles reject staff/unknown/duplicate permissions and reserved owner impersonation", async () => {
    for (const [input, status] of [
      [
        {
          name: syntheticName(),
          permissions: [{ code: "platform.organizations.manage", scope: "organization" }],
        },
        422,
      ],
      [{ name: syntheticName(), permissions: [{ code: "invented.permission", scope: "own" }] }, 422],
      [
        {
          name: syntheticName(),
          permissions: [
            { code: "crm.leads.read", scope: "own" },
            { code: "crm.leads.read", scope: "own" },
          ],
        },
        422,
      ],
      [{ name: "Owner", permissions: [] }, 422],
    ] as const)
      await assertProblem(await owner.command(`/v1/orgs/${owner.orgId}/roles`, input), status);
    const input: Schemas["RoleWrite"] = {
      name: syntheticName(),
      permissions: [{ code: "crm.leads.read", scope: "own" }],
    };
    const created = await owner.command(`/v1/orgs/${owner.orgId}/roles`, input);
    expect(created.status).toBe(201);
    const role = await created.json();
    assertContract("Role", role);
    roleIds.add(role.id);
    expect(role.permissions).toEqual(input.permissions);
    const changed = await owner.command(
      `/v1/orgs/${owner.orgId}/roles/${role.id}`,
      { ...input, name: syntheticName() },
      { method: "PATCH", revision: `"${role.version}"` },
    );
    expect(changed.status).toBe(200);
    await assertProblem(
      await owner.command(`/v1/orgs/${owner.orgId}/roles/${role.id}`, input, {
        method: "PATCH",
        revision: `"${role.version}"`,
      }),
      412,
    );
  });

  it("a role editor cannot delegate organization scope from an own-scoped permission", async () => {
    const ownerA = await new ApiSession().signIn("owner");
    const original = (
      await admin.query("SELECT role_id FROM app.membership WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        agent.memberId,
      ])
    ).rows[0].role_id;
    const roleResponse = await ownerA.command(`/v1/orgs/${ownerA.orgId}/roles`, {
      name: syntheticName(),
      permissions: [
        { code: "roles.write", scope: "organization" },
        { code: "crm.leads.read", scope: "own" },
      ],
    } satisfies Schemas["RoleWrite"]);
    expect(roleResponse.status).toBe(201);
    const role = await roleResponse.json();
    assertContract("Role", role);
    roleIds.add(role.id);
    try {
      await admin.query(
        "UPDATE app.membership SET role_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, agent.memberId, role.id],
      );
      await assertProblem(
        await agent.command(`/v1/orgs/${agent.orgId}/roles`, {
          name: syntheticName(),
          permissions: [{ code: "crm.leads.read", scope: "organization" }],
        }),
        403,
      );
    } finally {
      await admin.query(
        "UPDATE app.membership SET role_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, agent.memberId, original],
      );
    }
  });

  it("creation retries return one no-delivery job and the job is requester scoped", async () => {
    const created = await invite(`${randomUUID()}@example.invalid`);
    const replay = await owner.command(`/v1/orgs/${owner.orgId}/member-invitations`, created.input, {
      key: created.key,
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(created.job);
    expect(replay.headers.get("x-synthetic-invitation-token")).toBe(created.token);
    expect((await owner.read(`/v1/orgs/${owner.orgId}/jobs/${created.job.id}`, "Job", 202)).body).toEqual(
      created.job,
    );
    await assertProblem(await agent.request(`/v1/orgs/${agent.orgId}/jobs/${created.job.id}`), 404);
    const rows = (
      await admin.query("SELECT kind,safe_result FROM app.integration_job WHERE id=$1", [created.job.id])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].safe_result).toEqual({ delivery: "disabled" });
  });

  it("wrong verified email and expired invitation cannot create membership", async () => {
    const wrong = await invite(`${randomUUID()}@example.invalid`);
    await assertProblem(await agent.command("/v1/member-invitations/accept", { token: wrong.token }), 403);
    const expired = await invite();
    await admin.query("UPDATE app.member_invitation SET expires_at=now()-interval '1 second' WHERE id=$1", [
      expired.invitationId,
    ]);
    await assertProblem(await agent.command("/v1/member-invitations/accept", { token: expired.token }), 422);
    expect(
      (
        await admin.query("SELECT id FROM app.membership WHERE tenant_id=$1 AND user_id=$2", [
          fixtures.orgB,
          fixtures.agentUser,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query("SELECT accepted_at FROM app.member_invitation WHERE id=ANY($1::uuid[])", [
          [wrong.invitationId, expired.invitationId],
        ])
      ).rows.every((row) => row.accepted_at === null),
    ).toBe(true);
  });

  it("matching verified identity accepts once across organizations; same-key replay reconciles and new-key replay fails", async () => {
    const invited = await invite();
    const key = randomUUID();
    keys.add(key);
    const responses = await Promise.all([
      agent.command("/v1/member-invitations/accept", { token: invited.token }, { key }),
      agent.command("/v1/member-invitations/accept", { token: invited.token }, { key }),
    ]);
    for (const response of responses) expect(response.status).toBe(202);
    const accepted = await responses[0].json();
    assertContract("Job", accepted);
    jobIds.add(accepted.id);
    expect(await responses[1].json()).toEqual(accepted);
    const memberships = (
      await admin.query("SELECT id FROM app.membership WHERE tenant_id=$1 AND user_id=$2", [
        fixtures.orgB,
        fixtures.agentUser,
      ])
    ).rows;
    expect(memberships).toHaveLength(1);
    memberIds.add(memberships[0].id);
    await assertProblem(await agent.command("/v1/member-invitations/accept", { token: invited.token }), 422);
    expect((await agent.switchOrganization(fixtures.orgB)).status).toBe(200);
    expect(agent.memberId).toBe(memberships[0].id);
    expect((await agent.read(`/v1/orgs/${agent.orgId}/jobs/${accepted.id}`, "Job", 202)).body).toEqual(
      accepted,
    );
    await assertProblem(await agent.request(`/v1/orgs/${agent.orgId}/jobs/${invited.job.id}`), 404);
    await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/jobs/${accepted.id}`), 404);
  });
});

describe("role listing and detail", () => {
  it("lists roles with contract-valid structure", async () => {
    const result = await owner.read(`/v1/orgs/${owner.orgId}/roles`, "PageRole");
    expect(result.body.items.length).toBeGreaterThan(0);
    expect(typeof result.body.hasMore).toBe("boolean");
    const first = result.body.items[0];
    expect(first.id).toBeDefined();
    expect(first.name).toBeDefined();
    expect(Array.isArray(first.permissions)).toBe(true);
    expect(first.version).toBeGreaterThanOrEqual(1);
  });

  it("returns a single role by id", async () => {
    const list = await owner.read(`/v1/orgs/${owner.orgId}/roles?limit=1`, "PageRole");
    const roleId = list.body.items[0].id;
    const detail = await owner.read(`/v1/orgs/${owner.orgId}/roles/${roleId}`, "Role");
    expect(detail.body.id).toBe(roleId);
    expect(detail.body.name).toBeDefined();
    expect(detail.body.version).toBeGreaterThanOrEqual(1);
  });

  it("rejects role detail for unknown id", async () => {
    await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/roles/${randomUUID()}`), 404);
  });
});

describe("audit events", () => {
  it("lists audit events with pagination", async () => {
    const result = await owner.read(`/v1/orgs/${owner.orgId}/audit-events`, "PageAuditRecord");
    expect(result.body.items).toBeDefined();
    expect(Array.isArray(result.body.items)).toBe(true);
    expect(typeof result.body.hasMore).toBe("boolean");
    if (result.body.items.length) {
      const item = result.body.items[0];
      expect(item.id).toBeDefined();
      expect(item.actorRef).toBeDefined();
      expect(item.action).toBeDefined();
      expect(item.resourceType).toBeDefined();
      expect(item.traceId).toBeDefined();
      expect(item.createdAt).toBeDefined();
    }
  });

  it("supports cursor pagination", async () => {
    const page1 = await owner.read(`/v1/orgs/${owner.orgId}/audit-events?limit=2`, "PageAuditRecord");
    if (page1.body.hasMore && page1.body.nextCursor) {
      const page2 = await owner.read(
        `/v1/orgs/${owner.orgId}/audit-events?limit=2&cursor=${page1.body.nextCursor}`,
        "PageAuditRecord",
      );
      expect(page2.body.items).toBeDefined();
      const ids1 = new Set(page1.body.items.map((i: { id: string }) => i.id));
      for (const item of page2.body.items) {
        expect(ids1.has(item.id)).toBe(false);
      }
    }
  });
});
