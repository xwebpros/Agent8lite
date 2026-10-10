import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertProblem } from "../helpers/api";

let session: ApiSession;
beforeAll(async () => {
  session = await new ApiSession().signIn("agent");
});

describe("M1 — safe failures before domain request validation", () => {
  it.each(["malformed", "primitive"] as const)(
    "returns a redacted Problem and no-store headers for %s JSON",
    async (kind) => {
      const privateMarker = `Synthetic-private-body-${randomUUID()}`;
      const response = await session.request(`/v1/orgs/${session.orgId}/contacts`, {
        method: "POST",
        headers: { "x-csrf-token": session.csrf, "idempotency-key": randomUUID() },
        body: kind === "malformed" ? `{"displayName":"${privateMarker}",` : JSON.stringify(privateMarker),
      });
      const failure = await assertProblem(response, 400);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-trace-id")).toBe(failure.traceId);
      expect(JSON.stringify(failure)).not.toContain(privateMarker);
      expect(failure).not.toHaveProperty("stack");
    },
  );

  it("bounds JSON bodies and returns a safe size error without echoing body content", async () => {
    const privateMarker = `Synthetic-private-body-${randomUUID()}`;
    const response = await session.request(`/v1/orgs/${session.orgId}/contacts`, {
      method: "POST",
      headers: { "x-csrf-token": session.csrf, "idempotency-key": randomUUID() },
      body: JSON.stringify({ displayName: privateMarker, oversized: "x".repeat(1024 * 1024) }),
    });
    const failure = await assertProblem(response, 413);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-trace-id")).toBe(failure.traceId);
    expect(JSON.stringify(failure)).not.toContain(privateMarker);
  });
});
