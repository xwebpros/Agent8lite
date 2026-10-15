import { beforeAll, describe, expect, it } from "vitest";
import { ApiSession } from "../helpers/api";

let owner: ApiSession;

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});

describe("AI job boundaries", () => {
  it("AI job listing is not exposed (404)", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/ai/jobs`);
    expect(response.status).toBe(404);
  });

  it("rejects unauthenticated AI job detail", async () => {
    const response = await fetch(
      `http://127.0.0.1:3001/v1/orgs/${owner.orgId}/ai/jobs/00000000-0000-0000-0000-000000000000`,
    );
    expect([401, 403]).toContain(response.status);
  });

  it("denies AI job detail for nonexistent job", async () => {
    const response = await owner.request(
      `/v1/orgs/${owner.orgId}/ai/jobs/00000000-0000-0000-0000-000000000000`,
    );
    expect([403, 404]).toContain(response.status);
  });
});
