import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const origin = "http://localhost:3000";
const org = "10000000-0000-4000-8000-000000000001";
const contactPath = ["v1", "orgs", org, "contacts"];
const uploadPath = ["dev", "storage", "uploads", randomUUID()];
const network = vi.fn<typeof fetch>();
const jsonLimit = 256 * 1024;
const uploadLimit = 20 * 1024 * 1024;
let handlers: typeof import("../../apps/web/app/api/[...path]/route");

function request(
  method = "POST",
  body: BodyInit | null = "{}",
  headers: Record<string, string> = {},
  base = origin,
) {
  return new NextRequest(`${base}/api/${contactPath.join("/")}`, {
    method,
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
    headers: { origin: base, host: new URL(base).host, "content-type": "application/json", ...headers },
    duplex: "half",
  });
}
function invoke(value: NextRequest, path = contactPath) {
  return handlers[value.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE"](value, {
    params: Promise.resolve({ path }),
  });
}
function outbound() {
  expect(network).toHaveBeenCalledTimes(1);
  const [url, options] = network.mock.calls[0];
  expect(typeof url).toBe("string");
  expect(options).toBeTruthy();
  return { url: String(url), options: options!, headers: new Headers(options!.headers) };
}
function stream(chunks: Uint8Array[]) {
  const cancelled = vi.fn();
  return {
    cancelled,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
      cancel: cancelled,
    }),
  };
}
function privateResponse(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
}

beforeEach(async () => {
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("DEV_AUTH_ENABLED", "true");
  vi.stubEnv("WEB_ORIGIN", origin);
  vi.stubEnv("API_ORIGIN", "http://127.0.0.1:3001");
  network.mockReset();
  network.mockResolvedValue(Response.json({ synthetic: true }, { status: 200 }));
  vi.stubGlobal("fetch", network);
  vi.resetModules();
  handlers = await import("../../apps/web/app/api/[...path]/route");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("web BFF private transport boundary — actual NextRequest handlers, no browser", () => {
  it("rejects unsafe path segments before making an outbound request", async () => {
    expect(handlers.dynamic).toBe("force-dynamic");
    for (const path of [[], ["internal", "admin"], ["v1", "..", "orgs"], ["v1", "."], ["v1", "orgs/other"]]) {
      const response = await invoke(request(), path);
      privateResponse(response, 404);
      expect(await response.json()).toMatchObject({ title: "Route unavailable" });
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("requires exact browser origin on every mutating verb and normalizes only a verified origin", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const supplied of [
        "",
        "null",
        "https://attacker.example",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
      ]) {
        const value = request(method, "{}", { origin: supplied });
        privateResponse(await invoke(value), 403);
      }
    }
    expect(network).not.toHaveBeenCalled();
    const value = request("POST", "{}", {}, "http://127.0.0.1:3000");
    privateResponse(await invoke(value), 200);
    expect(outbound().headers.get("origin")).toBe(origin);
  });

  it("does not proxy development services unless explicit mode, opt-in and loopback hostname all hold", async () => {
    const path = ["dev", "session"];
    for (const [mode, enabled, base] of [
      ["production", "true", origin],
      ["staging", "true", origin],
      ["test", "false", origin],
      ["test", "", origin],
      ["test", "true", "http://public.example:3000"],
      ["test", "true", "http://127.0.0.2:3000"],
    ]) {
      vi.stubEnv("APP_ENV", mode);
      vi.stubEnv("DEV_AUTH_ENABLED", enabled);
      privateResponse(await invoke(request("POST", "{}", {}, base), path), 403);
    }
    expect(network).not.toHaveBeenCalled();
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("DEV_AUTH_ENABLED", "true");
    for (const base of [origin, "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      network.mockClear();
      privateResponse(await invoke(request("POST", "{}", {}, base), path), 200);
      expect(outbound().url).toBe("http://127.0.0.1:3001/dev/session");
    }
  });

  it("forwards only the session/command header allowlist to its fixed loopback backend", async () => {
    const value = request("PATCH", '{"synthetic":true}', {
      cookie: "estate_session=synthetic-cookie; preference=compact",
      "x-csrf-token": "synthetic-csrf",
      "idempotency-key": "synthetic-command",
      "if-match": '"7"',
      accept: "application/json",
      "x-forwarded-for": "127.0.0.1",
      authorization: "Bearer do-not-forward",
      "x-tenant-id": randomUUID(),
      "x-member-id": randomUUID(),
      "x-forwarded-host": "attacker.example",
      "x-api-key": "do-not-forward",
    });
    privateResponse(await invoke(value), 200);
    const forwarded = outbound();
    expect(forwarded.url).toBe(`http://127.0.0.1:3001/${contactPath.join("/")}`);
    expect(forwarded.headers.get("cookie")).toBe("estate_session=synthetic-cookie");
    expect(forwarded.headers.get("x-csrf-token")).toBe("synthetic-csrf");
    expect(forwarded.headers.get("idempotency-key")).toBe("synthetic-command");
    expect(forwarded.headers.get("if-match")).toBe('"7"');
    expect(forwarded.headers.get("x-forwarded-for")).toBe("127.0.0.1");
    for (const name of [
      "authorization",
      "x-tenant-id",
      "x-member-id",
      "x-forwarded-host",
      "host",
      "x-api-key",
    ])
      expect(forwarded.headers.has(name)).toBe(false);
    expect(Buffer.from(forwarded.options.body as ArrayBuffer).toString()).toBe('{"synthetic":true}');
    expect(forwarded.options).toMatchObject({ method: "PATCH", cache: "no-store", redirect: "manual" });
    expect(forwarded.options.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves encoded query data without allowing a path segment to replace the backend origin", async () => {
    const value = new NextRequest(
      `${origin}/api/v1/orgs/${org}/contacts?filter=%7B%22q%22%3A%22synthetic%22%7D&limit=1`,
    );
    await invoke(value);
    expect(outbound().url).toBe(
      `http://127.0.0.1:3001/${contactPath.join("/")}?filter=%7B%22q%22%3A%22synthetic%22%7D&limit=1`,
    );
    network.mockClear();
    await invoke(request("GET"), ["v1", "orgs", "https:evil.example?x"]);
    expect(outbound().url).toBe("http://127.0.0.1:3001/v1/orgs/https%3Aevil.example%3Fx");
  });

  it("chooses independent staff/member cookies from the explicit route without mixing authority", async () => {
    const cookie = "estate_session=member-token; estate_staff_session=staff-token; preference=compact";
    for (const path of [
      ["dev", "staff", "session"],
      ["v1", "platform", "organizations"],
      contactPath,
      ["v1", "session"],
      ["dev", "orgs", org, "mls", "listings"],
    ]) {
      network.mockClear();
      privateResponse(await invoke(request("GET", null, { cookie }), path), 200);
      const staff = path[1] === "staff" || path[1] === "platform";
      expect(outbound().headers.get("cookie")).toBe(
        staff ? "estate_staff_session=staff-token" : "estate_session=member-token",
      );
    }
    network.mockClear();
    privateResponse(await invoke(request("GET", null, { cookie: "estate_staff_session=staff-token" })), 200);
    expect(outbound().headers.has("cookie")).toBe(false);
  });

  it("denies duplicate cookies in the chosen context before forwarding", async () => {
    for (const [path, cookie] of [
      [contactPath, "estate_session=first; estate_session=second"],
      [["dev", "staff", "session"], "estate_staff_session=first; estate_staff_session=second"],
    ] as const) {
      privateResponse(await invoke(request("GET", null, { cookie }), [...path]), 403);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("enforces ordinary-body limits with and without Content-Length before forwarding any bytes", async () => {
    const declared = request("POST", "{}", { "content-length": String(jsonLimit + 1) });
    privateResponse(await invoke(declared), 413);
    const large = stream([new Uint8Array(jsonLimit), new Uint8Array(1), new Uint8Array(1)]);
    privateResponse(await invoke(request("POST", large.body)), 413);
    expect(large.cancelled).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    const exact = stream([new Uint8Array(jsonLimit / 2), new Uint8Array(jsonLimit / 2)]);
    privateResponse(await invoke(request("POST", exact.body)), 200);
    expect((outbound().options.body as ArrayBuffer).byteLength).toBe(jsonLimit);
  });

  it("rejects malformed or mismatched length declarations and recalculates a correct length", async () => {
    for (const length of ["", "-1", "3.5", "2e5", "not-a-length", "Infinity"])
      privateResponse(await invoke(request("POST", "{}", { "content-length": length })), 400);
    for (const length of ["0", "1", "3"])
      privateResponse(await invoke(request("POST", "{}", { "content-length": length })), 400);
    expect(network).not.toHaveBeenCalled();
    privateResponse(await invoke(request("POST", "{}", { "content-length": "0002" })), 200);
    expect(outbound().headers.get("content-length")).toBe("2");
    expect((outbound().options.body as ArrayBuffer).byteLength).toBe(2);
  });

  it("gives only exact protected upload PUT paths a larger cap and preserves CSV bytes and signed grant", async () => {
    const bytes = Buffer.from("Name,Email\r\nSynthetic transfer,synthetic@example.test\r\n");
    network.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const response = await invoke(
      request("PUT", new Uint8Array(bytes), {
        "content-type": "text/csv",
        "content-length": String(bytes.length),
        "x-upload-grant": "synthetic-scoped-upload-grant",
        "x-csrf-token": "synthetic-csrf",
      }),
      uploadPath,
    );
    privateResponse(response, 204);
    const forwarded = outbound();
    expect(forwarded.url).toBe(`http://127.0.0.1:3001/${uploadPath.join("/")}`);
    expect(forwarded.headers.get("content-type")).toBe("text/csv");
    expect(forwarded.headers.get("x-upload-grant")).toBe("synthetic-scoped-upload-grant");
    expect(forwarded.headers.get("x-csrf-token")).toBe("synthetic-csrf");
    expect(Buffer.from(forwarded.options.body as ArrayBuffer)).toEqual(bytes);
    for (const [method, path] of [
      ["POST", uploadPath],
      ["PUT", [...uploadPath, "extra"]],
      ["PUT", ["dev", "storage", "other", uploadPath[3]]],
      ["PUT", contactPath],
    ] as const) {
      network.mockClear();
      privateResponse(await invoke(request(method, new Uint8Array(jsonLimit + 1)), [...path]), 413);
      expect(network).not.toHaveBeenCalled();
    }
    privateResponse(
      await invoke(request("PUT", "{}", { "content-length": String(uploadLimit + 1) }), uploadPath),
      413,
    );
    expect(network).not.toHaveBeenCalled();
    const oversized = stream([
      new Uint8Array(uploadLimit / 2),
      new Uint8Array(uploadLimit / 2 + 1),
      new Uint8Array(1),
    ]);
    privateResponse(await invoke(request("PUT", oversized.body), uploadPath), 413);
    expect(oversized.cancelled).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    privateResponse(await invoke(request("PUT", new Uint8Array(jsonLimit + 1)), uploadPath), 200);
    expect((outbound().options.body as ArrayBuffer).byteLength).toBe(jsonLimit + 1);
  });

  it("returns only private response headers and keeps separate HttpOnly session cookies", async () => {
    const headers = new Headers({
      "content-type": "text/csv; charset=utf-8",
      etag: '"9"',
      "x-trace-id": "synthetic-trace",
      "x-csrf-token": "synthetic-csrf",
      "x-member-id": randomUUID(),
      "retry-after": "60",
      "x-billing-terms-version": "synthetic-billing-v1",
      "content-disposition": 'attachment; filename="synthetic-export.csv"',
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
      authorization: "Bearer do-not-return",
      location: "https://attacker.example/redirect",
      "x-upload-grant": "do-not-return",
      "x-synthetic-invitation-token": "do-not-return-here",
    });
    headers.append("set-cookie", "estate_session=synthetic; Path=/; HttpOnly; SameSite=Lax");
    headers.append("set-cookie", "estate_refresh=synthetic; Path=/api; HttpOnly; SameSite=Lax");
    network.mockResolvedValueOnce(new Response("Name\r\nSynthetic\r\n", { headers }));
    const response = await invoke(request("GET"));
    privateResponse(response, 200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="synthetic-export.csv"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-csrf-token")).toBe("synthetic-csrf");
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
    for (const name of [
      "authorization",
      "location",
      "access-control-allow-origin",
      "x-upload-grant",
      "x-synthetic-invitation-token",
    ])
      expect(response.headers.has(name)).toBe(false);
    expect(await response.text()).toBe("Name\r\nSynthetic\r\n");
    expect(outbound().options.body).toBeUndefined();
  });

  it("exposes a synthetic invitation token only for the exact local invitation creation operation", async () => {
    const invitation = ["v1", "orgs", org, "member-invitations"];
    const upstream = () =>
      Response.json(
        { synthetic: true },
        { headers: { "x-synthetic-invitation-token": "synthetic-once-token" } },
      );
    for (const [method, path, mode, enabled, base, allowed] of [
      ["POST", invitation, "test", "true", origin, true],
      ["POST", invitation, "development", "true", origin, true],
      ["GET", invitation, "test", "true", origin, false],
      ["POST", contactPath, "test", "true", origin, false],
      ["POST", [...invitation, "extra"], "test", "true", origin, false],
      ["POST", invitation, "production", "true", origin, false],
      ["POST", invitation, "test", "false", origin, false],
      ["POST", invitation, "test", "true", "https://public.example", false],
    ] as const) {
      vi.stubEnv("APP_ENV", mode);
      vi.stubEnv("DEV_AUTH_ENABLED", enabled);
      network.mockResolvedValueOnce(upstream());
      const response = await invoke(request(method, "{}", {}, base), [...path]);
      privateResponse(response, 200);
      expect(response.headers.get("x-synthetic-invitation-token")).toBe(
        allowed ? "synthetic-once-token" : null,
      );
    }
  });

  it("preserves authoritative pending and failure status without caching or following a provider redirect", async () => {
    const body = { id: randomUUID(), state: "queued", kind: "synthetic-no-delivery" };
    network.mockResolvedValueOnce(Response.json(body, { status: 202 }));
    const queued = await invoke(request());
    privateResponse(queued, 202);
    expect(await queued.json()).toEqual(body);
    network.mockClear();
    network.mockResolvedValueOnce(Response.json({ title: "Conflict", status: 409 }, { status: 409 }));
    const conflict = await invoke(request("PATCH"));
    privateResponse(conflict, 409);
    expect(await conflict.json()).toEqual({ title: "Conflict", status: 409 });
    network.mockClear();
    network.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://external.example" } }),
    );
    const redirect = await invoke(request("GET"));
    privateResponse(redirect, 302);
    expect(redirect.headers.has("location")).toBe(false);
    expect(outbound().options.redirect).toBe("manual");
  });

  it("represents a timed-out mutation as unknown and gives same-input reconciliation guidance without resending", async () => {
    network.mockRejectedValueOnce(new DOMException("private upstream error must not appear", "TimeoutError"));
    const response = await invoke(
      request("POST", '{"synthetic":true}', { "idempotency-key": "synthetic-reconcile-key" }),
    );
    privateResponse(response, 503);
    const problem = await response.json();
    expect(problem.title).toBe("Workspace service unavailable");
    expect(problem.detail).toContain("may have reached the server");
    expect(problem.detail).toContain("retry with the same input");
    expect(JSON.stringify(problem)).not.toContain("private upstream error");
    expect(outbound().headers.get("idempotency-key")).toBe("synthetic-reconcile-key");
  });

  it("reads an approved server-only API origin once and ignores later environment/request host changes", async () => {
    vi.stubEnv("API_ORIGIN", "http://localhost:43210");
    vi.resetModules();
    handlers = await import("../../apps/web/app/api/[...path]/route");
    vi.stubEnv("API_ORIGIN", "https://attacker.example");
    const response = await invoke(request("POST", "{}", {}, "http://public.example:3000"));
    privateResponse(response, 200);
    expect(outbound().url).toBe(`http://localhost:43210/${contactPath.join("/")}`);
  });

  it("fails startup for malformed API origins or any remote synthetic backend", async () => {
    for (const value of [
      "not-a-url",
      "ftp://localhost:3001",
      "http://user:password@localhost:3001",
      "http://localhost:3001/api",
      "http://localhost:3001?destination=private",
      "http://localhost:3001#private",
      "https://remote.example",
    ]) {
      vi.stubEnv("API_ORIGIN", value);
      vi.resetModules();
      await expect(import("../../apps/web/app/api/[...path]/route")).rejects.toThrow();
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("allows a configured HTTPS backend in production while keeping development routes blocked", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("DEV_AUTH_ENABLED", "false");
    vi.stubEnv("API_ORIGIN", "https://api.synthetic.example");
    vi.resetModules();
    handlers = await import("../../apps/web/app/api/[...path]/route");
    privateResponse(await invoke(request("GET")), 200);
    expect(outbound().url).toBe(`https://api.synthetic.example/${contactPath.join("/")}`);
    network.mockClear();
    privateResponse(await invoke(request(), ["dev", "session"]), 403);
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects malformed or origin-mismatched Host and ignores forwarded authority claims", async () => {
    for (const host of [
      "",
      "localhost:65536",
      "user@localhost:3000",
      "http://localhost:3000",
      "localhost:3000/path",
      "localhost:3000,evil.example",
    ])
      privateResponse(await invoke(request("POST", "{}", { host })), 400);
    privateResponse(await invoke(request("POST", "{}", { host: "attacker.example" })), 403);
    privateResponse(await invoke(request("POST", "{}", { host: "127.0.0.1:3000" })), 403);
    expect(network).not.toHaveBeenCalled();
    privateResponse(
      await invoke(
        request("POST", "{}", {
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
        }),
      ),
      200,
    );
    expect(outbound().url).toBe(`http://127.0.0.1:3001/${contactPath.join("/")}`);
  });

  it("returns an explicit routing replacement capability only on the exact GET routing operation", async () => {
    const path = ["v1", "orgs", org, "routing"];
    for (const [method, resource, value, expected] of [
      ["GET", path, "true", "true"],
      ["GET", path, "false", "false"],
      ["GET", path, "TRUE", null],
      ["GET", path, "unknown", null],
      ["POST", path, "true", null],
      ["GET", [...path, "extra"], "true", null],
      ["GET", contactPath, "true", null],
    ] as const) {
      network.mockResolvedValueOnce(
        Response.json({ synthetic: true }, { headers: { "x-routing-can-replace": value } }),
      );
      const response = await invoke(request(method), [...resource]);
      privateResponse(response, 200);
      expect(response.headers.get("x-routing-can-replace")).toBe(expected);
    }
  });

  it("keeps synthetic capture metadata confined to the enabled loopback POST capture seam", async () => {
    const metadata = {
      "x-synthetic-capture": "true",
      "x-capture-decision-id": randomUUID(),
      "x-routing-rule-id": randomUUID(),
      "x-routing-reasons": "listing_attribution_unavailable,round_robin_selected",
    };
    for (const [method, path, mode, enabled, base, status, allowed] of [
      ["POST", ["dev", "capture"], "test", "true", origin, 200, true],
      ["POST", ["dev", "capture"], "development", "true", "http://127.0.0.1:3000", 200, true],
      ["GET", ["dev", "capture"], "test", "true", origin, 200, false],
      ["POST", ["dev", "capture", "extra"], "test", "true", origin, 200, false],
      ["POST", contactPath, "test", "true", origin, 200, false],
      ["POST", ["dev", "capture"], "production", "true", origin, 403, false],
      ["POST", ["dev", "capture"], "test", "false", origin, 403, false],
      ["POST", ["dev", "capture"], "test", "true", "https://public.example", 403, false],
    ] as const) {
      vi.stubEnv("APP_ENV", mode);
      vi.stubEnv("DEV_AUTH_ENABLED", enabled);
      network.mockReset();
      network.mockResolvedValueOnce(Response.json({ synthetic: true }, { headers: metadata }));
      const response = await invoke(request(method, "{}", {}, base), [...path]);
      privateResponse(response, status);
      for (const [name, value] of Object.entries(metadata))
        expect(response.headers.get(name)).toBe(allowed ? value : null);
    }
  });

  it("exposes synthetic session identity only for the exact enabled local session GET", async () => {
    for (const [method, path, mode, enabled, base, marker, expected] of [
      ["GET", ["v1", "session"], "test", "true", origin, "true", "true"],
      ["GET", ["v1", "session"], "development", "true", "http://127.0.0.1:3000", "true", "true"],
      ["GET", ["v1", "session"], "test", "true", origin, "TRUE", null],
      ["GET", ["v1", "session"], "test", "true", origin, "false", null],
      ["POST", ["v1", "session"], "test", "true", origin, "true", null],
      ["GET", ["v1", "session", "profile"], "test", "true", origin, "true", null],
      ["GET", contactPath, "test", "true", origin, "true", null],
      ["GET", ["v1", "session"], "production", "true", origin, "true", null],
      ["GET", ["v1", "session"], "test", "false", origin, "true", null],
      ["GET", ["v1", "session"], "test", "true", "https://public.example", "true", null],
    ] as const) {
      vi.stubEnv("APP_ENV", mode);
      vi.stubEnv("DEV_AUTH_ENABLED", enabled);
      network.mockReset();
      network.mockResolvedValueOnce(
        Response.json({ synthetic: true }, { headers: { "x-synthetic-identity": marker } }),
      );
      const response = await invoke(request(method, "{}", {}, base), [...path]);
      privateResponse(response, 200);
      expect(response.headers.get("x-synthetic-identity")).toBe(expected);
    }
  });

  it("keeps support metadata in successful explicitly enabled local staff responses", async () => {
    const metadata = {
      "x-synthetic-support-state": "active",
      "x-synthetic-support-grant-id": randomUUID(),
      "x-synthetic-support-grant-etag": '"2"',
    };
    for (const [path, mode, enabled, base, upstreamStatus, allowed] of [
      [["dev", "staff", "session"], "test", "true", origin, 200, true],
      [["dev", "staff", "support", "select"], "development", "true", origin, 200, true],
      [
        ["dev", "staff", "support", "organizations", org, "crm", "contacts"],
        "test",
        "true",
        origin,
        200,
        true,
      ],
      [["v1", "platform", "organizations", org, "access-grants"], "test", "true", origin, 202, true],
      [contactPath, "test", "true", origin, 200, false],
      [["v1", "session"], "test", "true", origin, 200, false],
      [["v1", "platform", "organizations"], "production", "true", origin, 200, false],
      [["v1", "platform", "organizations"], "test", "false", origin, 200, false],
      [["v1", "platform", "organizations"], "test", "true", "https://public.example", 200, false],
      [["dev", "staff", "session"], "test", "true", origin, 403, false],
    ] as const) {
      vi.stubEnv("APP_ENV", mode);
      vi.stubEnv("DEV_AUTH_ENABLED", enabled);
      network.mockReset();
      network.mockResolvedValueOnce(
        Response.json(
          { synthetic: true },
          { status: upstreamStatus, headers: { ...metadata, etag: '"job-revision"' } },
        ),
      );
      const response = await invoke(request("GET", null, {}, base), [...path]);
      privateResponse(response, upstreamStatus);
      for (const [name, value] of Object.entries(metadata))
        expect(response.headers.get(name)).toBe(allowed ? value : null);
      expect(response.headers.get("etag")).toBe('"job-revision"');
    }
  });
});
