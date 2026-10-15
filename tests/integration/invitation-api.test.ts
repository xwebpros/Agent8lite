import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtures, roleId } from "../../packages/db/fixtures";
import { ApiSession } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
let agent: ApiSession;
const createdInvitationIds: string[] = [];

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
});

afterAll(async () => {
  for (const id of createdInvitationIds) {
    await admin
      .query("DELETE FROM app.member_invitation WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, id])
      .catch(() => {});
  }
  await admin.end();
});

describe("member invitation", () => {
  const agentRoleId = roleId(1, 2);
  let invitationToken: string;

  it("owner can invite a new member", async () => {
    const email = `test-invite-${randomUUID().slice(0, 8)}@example.test`;
    const response = await owner.command(`/v1/orgs/${owner.orgId}/member-invitations`, {
      email,
      roleId: agentRoleId,
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toHaveProperty("id");
    invitationToken = response.headers.get("x-synthetic-invitation-token") ?? "";
    expect(invitationToken).not.toBe("");
    const invRow = await admin.query(
      "SELECT id FROM app.member_invitation WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1",
      [fixtures.orgA],
    );
    if (invRow.rows[0]) createdInvitationIds.push(invRow.rows[0].id);
  });

  it("duplicate invitation for same email is rejected", async () => {
    const invs = await admin.query(
      "SELECT email FROM app.member_invitation WHERE tenant_id=$1 AND accepted_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1",
      [fixtures.orgA],
    );
    if (!invs.rowCount) return;
    const response = await owner.command(`/v1/orgs/${owner.orgId}/member-invitations`, {
      email: invs.rows[0].email,
      roleId: agentRoleId,
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("invitation_pending");
  });

  it("agent without members.manage is denied", async () => {
    const email = `denied-${randomUUID().slice(0, 8)}@example.test`;
    const response = await agent.command(`/v1/orgs/${agent.orgId}/member-invitations`, {
      email,
      roleId: agentRoleId,
    });
    expect(response.status).toBe(403);
  });

  it("invitation with invalid role is rejected", async () => {
    const response = await owner.command(`/v1/orgs/${owner.orgId}/member-invitations`, {
      email: `bad-role-${randomUUID().slice(0, 8)}@example.test`,
      roleId: randomUUID(),
    });
    expect(response.status).toBe(422);
  });

  it("accept with invalid token is rejected", async () => {
    const response = await owner.command("/v1/member-invitations/accept", {
      token: "invalid-token-value",
    });
    expect(response.status).toBe(422);
  });
});
