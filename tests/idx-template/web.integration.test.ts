import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as rawHttpRequest } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSiteFixture, type IdxSiteFixture } from "./fixtures";
import { createIdxPools, requireIdxIsolation } from "./isolation";

const target = requireIdxIsolation();
const { admin, runtime } = createIdxPools();
const web = new URL(process.env.TEST_IDX_WEB_ORIGIN ?? "");
if (
  web.protocol !== "http:" ||
  web.hostname !== "127.0.0.1" ||
  !web.port ||
  ["3000", "3001", "54434"].includes(web.port) ||
  web.origin === target.api
)
  throw new Error("idx_owned_web_origin_required");
let fixture: IdxSiteFixture;
let server: ChildProcess | undefined;
let exited: Promise<void> | undefined;
let startupError = false;
const request = (suffix: string, options?: RequestInit) =>
  fetch(`${web.origin}/api/idx-template/${fixture.siteId}/${suffix}`, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

beforeAll(async () => {
  // The final production build must be created explicitly before this suite.
  const buildId = await readFile(path.resolve("apps/web/.next/BUILD_ID"), "utf8");
  if (!buildId.trim()) throw new Error("idx_final_web_build_required");
  fixture = await createSiteFixture(admin, { origin: web.origin, title: `PUBLISHED WEB ${randomUUID()}` });
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "127.0.0.1", "--port", web.port],
    {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        NODE_ENV: "production",
        APP_ENV: "test",
        DEV_AUTH_ENABLED: "true",
        API_ORIGIN: target.api,
        IDX_TEMPLATE_EXAMPLE_SITE_ID: fixture.siteId,
        NEXT_TELEMETRY_DISABLED: "1",
        HOSTED_DEMO_ENABLED: "false",
      },
    },
  );
  exited = new Promise((resolve) => {
    server!.once("exit", () => resolve());
    server!.once("error", () => {
      startupError = true;
      resolve();
    });
  });
  let ready = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && server.exitCode === null && !startupError) {
    try {
      const response = await fetch(`${web.origin}/templates/las-vegas-idx/${fixture.siteId}`, {
        signal: AbortSignal.timeout(1500),
      });
      ready = response.ok && (await response.text()).includes(fixture.title);
      if (ready && server.exitCode === null && !startupError) break;
      ready = false;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready || server.exitCode !== null || startupError) throw new Error("idx_owned_next_not_ready");
}, 45_000);

afterAll(async () => {
  if (server && server.exitCode === null && !startupError) {
    server.kill("SIGTERM");
    await exited;
  }
  await Promise.all([admin.end(), runtime.end()]);
});

describe("actual production Next SSR and same-origin IDX bridge", () => {
  it("server-renders the published source copy and SEO without the private draft", async () => {
    const response = await fetch(`${web.origin}/templates/las-vegas-idx/${fixture.siteId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const html = await response.text();
    expect(html).toContain(fixture.title);
    expect(html).toContain("Synthetic IDX fixture");
    expect(html).toContain("data-idx-template");
    expect(html).not.toContain(`PRIVATE DRAFT ${fixture.siteId}`);
    expect(html).not.toContain("idx-template-capture");
  });

  it("relays current content and permitted listings with no-store headers", async () => {
    const content = await request("content");
    expect(content.status).toBe(200);
    expect(content.headers.get("cache-control")).toContain("no-store");
    expect((await content.json()).content.heroTitle).toBe(fixture.title);
    const listings = await request("listings");
    expect(listings.status).toBe(200);
    expect(listings.headers.get("cache-control")).toContain("no-store");
    const page = await listings.json();
    expect(page.synthetic).toBe(true);
    expect(
      page.items.some((listing: { listingKey: string }) => listing.listingKey === fixture.listingKey),
    ).toBe(true);
  });

  it("records a same-origin inquiry once and reconciles its original command", async () => {
    const key = randomUUID();
    const email = `web-${randomUUID()}@example.test`;
    const message = "SYNTHETIC WEB PRIVATE MESSAGE\nPreserve the original inquiry.";
    const options: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", origin: web.origin, "idempotency-key": key },
      body: JSON.stringify({
        formId: fixture.formId,
        formVersion: 1,
        listingKey: fixture.listingKey,
        listingId: fixture.listingId,
        name: "Synthetic Web Visitor",
        email,
        message,
      }),
    };
    const first = await request("inquiries", options);
    expect(first.status).toBe(200);
    const receipt = await first.json();
    expect(receipt.receiptId).toMatch(/^[0-9a-f-]{36}$/i);
    const replay = await request("inquiries", options);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    const rows = await admin.query(
      "SELECT n.body FROM app.note n JOIN app.lead l ON (l.tenant_id,l.id)=(n.tenant_id,n.lead_id) JOIN app.contact_channel c ON (c.tenant_id,c.contact_id)=(l.tenant_id,l.contact_id) WHERE n.tenant_id=$1 AND c.kind='email' AND c.normalized_value=$2",
      [fixture.tenant, email],
    );
    expect(rows.rows.map((row) => row.body)).toEqual([message]);
  });

  it("rejects a foreign browser origin and malformed JSON before capture", async () => {
    const foreign = await request("inquiries", {
      method: "POST",
      headers: { origin: "https://foreign.invalid", "content-type": "application/json" },
      body: "{}",
    });
    expect(foreign.status).toBe(403);
    const malformed = await request("inquiries", {
      method: "POST",
      headers: { origin: web.origin, "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const oversized = await request("inquiries", {
      method: "POST",
      headers: { origin: web.origin, "content-type": "application/json" },
      body: "x".repeat(16_385),
    });
    expect(oversized.status).toBe(413);
  });

  it("cannot select a tenant through an unconfigured Host or forwarded Host", async () => {
    // Fetch transports can replace Host with their URL authority; use an actual raw HTTP header.
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const raw = rawHttpRequest(
        `${web.origin}/api/idx-template/${fixture.siteId}/content`,
        { headers: { host: "foreign.invalid", "x-forwarded-host": web.host } },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.once("error", reject);
          incoming.once("end", () =>
            resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      raw.setTimeout(10_000, () => raw.destroy(new Error("idx_web_raw_request_timeout")));
      raw.once("error", reject);
      raw.end();
    });
    expect(response.status).toBe(503);
    expect(response.body).not.toContain(fixture.title);
  });
});
