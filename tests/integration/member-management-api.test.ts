import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertContract } from "../helpers/api";

let owner: ApiSession;
let agent: ApiSession;

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
});

describe("member management", () => {
  it("lists members with members.read permission", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/members`);
    expect(response.status).toBe(200);
    const body = await response.json();
    assertContract("PageMember", body);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    for (const member of body.items) {
      expect(member.id).toBeTruthy();
      expect(member.displayName).toBeTruthy();
      expect(member.roleId).toBeTruthy();
      expect(["invited", "active", "disabled"]).toContain(member.status);
      expect(member.version).toBeGreaterThanOrEqual(1);
    }
  });

  it("lists members with pagination", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/members?limit=1`);
    expect(response.status).toBe(200);
    const body = await response.json();
    assertContract("PageMember", body);
    expect(body.items.length).toBe(1);
    if (body.hasMore) {
      expect(body.nextCursor).toBeTruthy();
    }
  });

  it("agent without members.read is denied member listing", async () => {
    const response = await agent.request(`/v1/orgs/${agent.orgId}/members`);
    expect(response.status).toBe(403);
  });

  it("cannot disable your own membership", async () => {
    const list = await owner.request(`/v1/orgs/${owner.orgId}/members`);
    const body = await list.json();
    const self = body.items.find((m: { id: string }) => m.id === owner.memberId);
    expect(self).toBeTruthy();
    const response = await owner.command(
      `/v1/orgs/${owner.orgId}/members/${self.id}`,
      { status: "disabled" },
      { method: "PATCH", revision: `"${self.version}"`, key: randomUUID() },
    );
    expect(response.status).toBe(422);
    const problem = await response.json();
    expect(problem.code).toBe("self_disable_denied");
  });
});
