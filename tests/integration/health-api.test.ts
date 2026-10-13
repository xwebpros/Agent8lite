import { describe, expect, it } from "vitest";

const port = process.env.PORT ?? 3001;

describe("GET /health", () => {
  it("returns health status without authentication", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("status");
    expect(body.status).toBe("ready");
  });

  it("includes delivery mode", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await response.json();
    expect(body).toHaveProperty("deliveryMode");
    expect(body.deliveryMode).toBe("no-delivery");
  });
});
