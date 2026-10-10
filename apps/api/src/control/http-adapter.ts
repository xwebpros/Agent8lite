import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  StaffSessionIssuer,
  staffSessionCookie,
  staffSessionResponse,
  verifyStaffCsrf,
  withStaffTransaction,
} from "../../../../packages/auth/staff-sessions";
import { assertStaffRole, requireSyntheticStaffMode } from "../../../../packages/db/staff-pools";
import { AccessError } from "../../../../packages/db/tenant-transaction";
import { MockOidcProvider } from "../../../../packages/providers/identity/mock";
import {
  ControlProvisioningService,
  runProvisioning,
  type BootstrapPortFactory,
} from "./provisioning-service";
import { validateStaff } from "./validation";

export interface StaffAdapterOptions {
  readonly control: Pool;
  readonly issuer: Pool;
  /** Trusted server configuration; never inferred from Host, Forwarded or request body. */
  readonly allowedOrigins: readonly string[];
  readonly bootstrapPorts?: BootstrapPortFactory;
}
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
function localAccess(request: IncomingMessage) {
  requireSyntheticStaffMode();
  if (
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") ||
    request.headers.forwarded ||
    request.headers["x-forwarded-for"] ||
    request.headers["x-real-ip"]
  )
    throw new AccessError(
      403,
      "synthetic_loopback_required",
      "Synthetic staff access requires a direct loopback connection.",
    );
}
function value(request: IncomingMessage, name: string) {
  const result = request.headers[name];
  return typeof result === "string" ? result : undefined;
}
function token(request: IncomingMessage) {
  const pairs = (value(request, "cookie") ?? "").split(";").map((pair) => pair.trim());
  const matches = pairs.filter((pair) => pair.startsWith(`${staffSessionCookie}=`));
  if (matches.length !== 1)
    throw new AccessError(401, "staff_authentication_required", "Staff sign in required.");
  if (pairs.some((pair) => pair.startsWith("estate_session=")))
    throw new AccessError(
      403,
      "identity_context_ambiguous",
      "Select one identity context before staff access.",
    );
  return matches[0].slice(staffSessionCookie.length + 1);
}
function origin(request: IncomingMessage, allowed: readonly string[]) {
  if (!allowed.includes(value(request, "origin") ?? ""))
    throw new AccessError(403, "origin_invalid", "A trusted local Origin is required.");
}
async function body(request: IncomingMessage) {
  if (!/^application\/json(?:\s*;|$)/i.test(value(request, "content-type") ?? ""))
    throw new AccessError(415, "content_type_invalid", "JSON content type required.");
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    let size = 0,
      rejected = false;
    const buffers: Buffer[] = [];
    // Drain oversized input without destroying the socket before the safe Problem is written.
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > 256 * 1024) {
        rejected = true;
        buffers.length = 0;
        reject(new AccessError(413, "request_too_large", "Request size exceeds the allowed limit."));
      } else buffers.push(chunk);
    });
    request.once("end", () => {
      if (!rejected) resolve(buffers);
    });
    request.once("error", () =>
      reject(new AccessError(400, "request_interrupted", "Request was interrupted.")),
    );
    request.once("aborted", () =>
      reject(new AccessError(400, "request_interrupted", "Request was interrupted.")),
    );
  });
  try {
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new AccessError(400, "json_invalid", "A JSON object is required.");
  }
}
function respond(response: ServerResponse, status: number, result?: unknown, problem = false) {
  response.statusCode = status;
  if (status === 204) {
    response.end();
    return;
  }
  response.setHeader(
    "Content-Type",
    `${problem ? "application/problem+json" : "application/json"}; charset=utf-8`,
  );
  response.end(JSON.stringify(result));
}
function cookie(opaque: string, expiresAt: string) {
  return `${staffSessionCookie}=${opaque}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}`;
}

/** Intentionally unregistered. Root must review the adapter before adding it to the shared router. */
export async function createStaffHttpAdapter(options: StaffAdapterOptions) {
  requireSyntheticStaffMode();
  for (const configured of options.allowedOrigins) {
    const url = new URL(configured);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.protocol !== "http:" ||
      url.origin !== configured
    )
      throw new AccessError(
        503,
        "staff_origin_unconfigured",
        "Only explicit synthetic loopback origins are supported.",
      );
  }
  if (!options.allowedOrigins.length)
    throw new AccessError(503, "staff_origin_unconfigured", "A trusted synthetic Origin is required.");
  await assertStaffRole(options.control, "estate_control");
  await assertStaffRole(options.issuer, "estate_staff_issuer");
  const clientId = "estate-staff-local",
    redirectUri = `${options.allowedOrigins[0]}/dev/staff/callback`;
  const identity = new MockOidcProvider({
    mode: process.env.APP_ENV === "test" ? "test" : "development",
    clientId,
    redirectUris: [redirectUri],
    allowedSubjects: ["staff-administrator", "staff-support"],
  });
  const issuer = new StaffSessionIssuer(options.issuer);
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = (request.url ?? "").split("?")[0],
      method = request.method ?? "GET";
    const jobRoute = new RegExp(`^/dev/staff/jobs/(${uuid})(/run)?$`).exec(path);
    const owned =
      path === "/dev/staff/session" ||
      path === "/dev/staff/logout" ||
      path === "/v1/platform/organizations" ||
      Boolean(jobRoute);
    if (!owned) return false;
    const traceId = randomUUID();
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Trace-Id", traceId);
    try {
      localAccess(request);
      if (!["GET", "POST"].includes(method))
        throw new AccessError(405, "method_unavailable", "Method unavailable.");
      if (method === "POST") origin(request, options.allowedOrigins);
      if (path === "/dev/staff/session" && method === "POST") {
        const input = await body(request);
        validateStaff("SessionRequest", input);
        const subject =
          (input as { identity: string }).identity === "administrator"
            ? "staff-administrator"
            : "staff-support";
        const verifier = randomBytes(32).toString("base64url"),
          nonce = randomBytes(32).toString("base64url"),
          state = randomBytes(32).toString("base64url");
        const callback = new URL(
          identity.authorize(
            {
              clientId,
              redirectUri,
              nonce,
              state,
              codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
              codeChallengeMethod: "S256",
            },
            subject,
          ),
        );
        if (callback.searchParams.get("state") !== state)
          throw new AccessError(401, "staff_identity_unavailable", "Verified staff identity is unavailable.");
        const verified = identity.verifyIdentityToken(
          identity.exchange({
            clientId,
            redirectUri,
            code: callback.searchParams.get("code")!,
            codeVerifier: verifier,
          }).idToken,
          { clientId, nonce },
        );
        const issued = await issuer.issueVerifiedIdentity(verified);
        response.setHeader("Set-Cookie", cookie(issued.opaqueToken, issued.expiresAt));
        const result = await withStaffTransaction(
          options.control,
          issued.opaqueToken,
          async (_client, session) => {
            response.setHeader("X-CSRF-Token", session.csrfToken);
            return staffSessionResponse(session);
          },
        );
        validateStaff("SessionResponse", result, true);
        respond(response, 200, result);
        return true;
      }
      const opaque = token(request);
      if (path === "/dev/staff/session" && method === "GET") {
        const result = await withStaffTransaction(options.control, opaque, async (_client, session) => {
          response.setHeader("X-CSRF-Token", session.csrfToken);
          return staffSessionResponse(session);
        });
        validateStaff("SessionResponse", result, true);
        respond(response, 200, result);
        return true;
      }
      if (path === "/dev/staff/logout" && method === "POST") {
        validateStaff("EmptyCommand", await body(request));
        await withStaffTransaction(
          options.control,
          opaque,
          async (_client, session) => verifyStaffCsrf(session, value(request, "x-csrf-token")),
          { logout: true },
        );
        response.setHeader(
          "Set-Cookie",
          `${staffSessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        );
        respond(response, 204);
        return true;
      }
      if (path === "/v1/platform/organizations" && method === "GET") {
        const url = new URL(request.url!, options.allowedOrigins[0]);
        if (
          [...url.searchParams.keys()].some((key) => !["limit", "cursor"].includes(key)) ||
          [...new Set(url.searchParams.keys())].some((key) => url.searchParams.getAll(key).length !== 1)
        )
          throw new AccessError(422, "query_invalid", "Only a single limit and cursor are supported.");
        const result = await withStaffTransaction(options.control, opaque, (client, session) =>
          new ControlProvisioningService(client, session, traceId).listOrganizations({
            limit: url.searchParams.get("limit") ?? undefined,
            cursor: url.searchParams.get("cursor") ?? undefined,
          }),
        );
        respond(response, 200, result);
        return true;
      }
      if (path === "/v1/platform/organizations" && method === "POST") {
        const input = await body(request);
        const result = await withStaffTransaction(options.control, opaque, (client, session) => {
          verifyStaffCsrf(session, value(request, "x-csrf-token"));
          return new ControlProvisioningService(client, session, traceId).enqueue(
            input as Parameters<ControlProvisioningService["enqueue"]>[0],
            value(request, "idempotency-key") ?? "",
          );
        });
        respond(response, 202, result);
        return true;
      }
      if (jobRoute && method === "GET" && !jobRoute[2]) {
        const result = await withStaffTransaction(options.control, opaque, (client, session) =>
          new ControlProvisioningService(client, session, traceId).readJob(jobRoute[1]),
        );
        respond(response, 200, result);
        return true;
      }
      if (jobRoute?.[2] && method === "POST") {
        validateStaff("EmptyCommand", await body(request));
        await withStaffTransaction(options.control, opaque, async (_client, session) =>
          verifyStaffCsrf(session, value(request, "x-csrf-token")),
        );
        const result = await runProvisioning(
          options.control,
          opaque,
          jobRoute[1],
          value(request, "idempotency-key") ?? "",
          traceId,
          options.bootstrapPorts,
        );
        respond(response, 202, result);
        return true;
      }
      throw new AccessError(404, "route_unavailable", "Route unavailable.");
    } catch (error) {
      const safe =
        error instanceof AccessError
          ? error
          : new AccessError(503, "staff_operation_unavailable", "Staff operation unavailable.");
      respond(
        response,
        safe.status,
        {
          type: "about:blank",
          title: safe.message,
          status: safe.status,
          code: safe.code,
          traceId,
        },
        true,
      );
      return true;
    }
  };
}
