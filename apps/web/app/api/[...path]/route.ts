import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
function configuredApiOrigin() {
  const value = new URL(process.env.API_ORIGIN || "http://127.0.0.1:3001");
  if (
    !["http:", "https:"].includes(value.protocol) ||
    value.username ||
    value.password ||
    value.search ||
    value.hash ||
    value.pathname !== "/"
  )
    throw new Error("API_ORIGIN must be an HTTP(S) origin without credentials, query, fragment or path.");
  if (
    ["development", "test"].includes(process.env.APP_ENV || "") &&
    process.env.DEV_AUTH_ENABLED === "true" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(value.hostname)
  )
    throw new Error("Synthetic API_ORIGIN must use a loopback host.");
  return value.origin;
}
const backend = configuredApiOrigin();
function requestAuthority(request: NextRequest) {
  const host = request.headers.get("host");
  if (host === null) return new URL(request.nextUrl.origin);
  // NextURL canonicalizes loopback aliases. Preserve the actual HTTP authority
  // for the browser-origin boundary; forwarded headers are not authoritative.
  if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.test(host)) return null;
  try {
    const authority = new URL(`${request.nextUrl.protocol}//${host}`);
    if (!["http:", "https:"].includes(authority.protocol)) return null;
    return authority;
  } catch {
    return null;
  }
}
class RequestBodyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function boundedBody(request: NextRequest, maximum: number): Promise<ArrayBuffer> {
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length))
    throw new RequestBodyError(400, "Content-Length must be a nonnegative byte count.");
  if (length && Number(length) > maximum)
    throw new RequestBodyError(413, "Request body exceeds the permitted size.");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maximum) {
          await reader.cancel().catch(() => {});
          throw new RequestBodyError(413, "Request body exceeds the permitted size.");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (length && Number(length) !== bytes)
    throw new RequestBodyError(400, "Content-Length does not match the request body.");
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}
async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (
    !path.length ||
    !["v1", "dev"].includes(path[0]) ||
    path.some((part) => part === "." || part === ".." || part.includes("/"))
  ) {
    return Response.json(
      { title: "Route unavailable" },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const authority = requestAuthority(request);
  if (!authority)
    return Response.json(
      { title: "Valid request authority required" },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  if (
    path[0] === "dev" &&
    (!["development", "test"].includes(process.env.APP_ENV || "") ||
      process.env.DEV_AUTH_ENABLED !== "true" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(authority.hostname))
  ) {
    return Response.json(
      { title: "Synthetic identity requires explicitly enabled loopback development mode" },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") !== authority.origin) {
    return Response.json(
      { title: "Same-origin request required" },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const headers = new Headers();
  for (const name of [
    "content-type",
    "origin",
    "idempotency-key",
    "x-csrf-token",
    "if-match",
    "accept",
    "x-forwarded-for",
    "x-upload-grant",
    "content-length",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // An explicit route chooses one independent identity context. The API still verifies its opaque
  // session, current principal/membership and CSRF; cookies never combine staff/member authority.
  const staffRoute =
    (path[0] === "dev" && path[1] === "staff") || (path[0] === "v1" && path[1] === "platform");
  const cookieName = staffRoute ? "estate_staff_session" : "estate_session";
  const cookies = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${cookieName}=`));
  if (cookies.length > 1)
    return Response.json(
      { title: "Ambiguous identity cookie" },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  if (cookies.length === 1) headers.set("cookie", cookies[0]);
  if (request.headers.has("origin")) headers.set("origin", process.env.WEB_ORIGIN || "http://localhost:3000");
  try {
    const upload =
      request.method === "PUT" &&
      path.length === 4 &&
      path[0] === "dev" &&
      path[1] === "storage" &&
      path[2] === "uploads";
    const body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await boundedBody(request, upload ? 20 * 1024 * 1024 : 256 * 1024);
    if (body && headers.has("content-length")) headers.set("content-length", String(body.byteLength));
    const response = await fetch(
      `${backend}/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`,
      {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      },
    );
    const returned = new Headers({ "Cache-Control": "private, no-store" });
    for (const name of [
      "content-type",
      "etag",
      "x-trace-id",
      "x-csrf-token",
      "x-member-id",
      "retry-after",
      "x-billing-terms-version",
      "content-disposition",
      "x-content-type-options",
    ]) {
      const value = response.headers.get(name);
      if (value) returned.set(name, value);
    }
    for (const cookie of response.headers.getSetCookie()) returned.append("set-cookie", cookie);
    if (
      staffRoute &&
      ["development", "test"].includes(process.env.APP_ENV || "") &&
      process.env.DEV_AUTH_ENABLED === "true" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(authority.hostname) &&
      response.ok
    )
      for (const name of [
        "x-synthetic-support-state",
        "x-synthetic-support-grant-id",
        "x-synthetic-support-grant-etag",
      ]) {
        const value = response.headers.get(name);
        if (value) returned.set(name, value);
      }
    if (
      request.method === "GET" &&
      path.length === 2 &&
      path[0] === "v1" &&
      path[1] === "session" &&
      ["development", "test"].includes(process.env.APP_ENV || "") &&
      process.env.DEV_AUTH_ENABLED === "true" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(authority.hostname) &&
      response.headers.get("x-synthetic-identity") === "true"
    )
      returned.set("X-Synthetic-Identity", "true");
    if (
      request.method === "GET" &&
      path.length === 4 &&
      path[0] === "v1" &&
      path[1] === "orgs" &&
      path[3] === "routing"
    ) {
      const replace = response.headers.get("x-routing-can-replace");
      if (replace === "true" || replace === "false") returned.set("X-Routing-Can-Replace", replace);
    }
    if (
      request.method === "POST" &&
      path.length === 2 &&
      path[0] === "dev" &&
      path[1] === "capture" &&
      ["development", "test"].includes(process.env.APP_ENV || "") &&
      process.env.DEV_AUTH_ENABLED === "true" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(authority.hostname)
    ) {
      for (const name of [
        "x-synthetic-capture",
        "x-capture-decision-id",
        "x-routing-rule-id",
        "x-routing-reasons",
      ]) {
        const value = response.headers.get(name);
        if (value) returned.set(name, value);
      }
    }
    if (
      request.method === "POST" &&
      path.length === 4 &&
      path[0] === "v1" &&
      path[1] === "orgs" &&
      path[3] === "member-invitations" &&
      ["development", "test"].includes(process.env.APP_ENV || "") &&
      process.env.DEV_AUTH_ENABLED === "true" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(authority.hostname)
    ) {
      const token = response.headers.get("x-synthetic-invitation-token");
      if (token) returned.set("X-Synthetic-Invitation-Token", token);
    }
    return new Response(response.body, { status: response.status, headers: returned });
  } catch (err) {
    if (err instanceof RequestBodyError)
      return Response.json(
        { title: err.message },
        { status: err.status, headers: { "Cache-Control": "private, no-store" } },
      );
    return Response.json(
      {
        title: "Workspace service unavailable",
        detail:
          "The command may have reached the server. Reconnect and retry with the same input to reconcile its result.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
