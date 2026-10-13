import "reflect-metadata";
import { All, Controller, Module, Req, Res } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  assertRuntimeRole,
  closeRuntimePool,
  runtimePool,
  RuntimeRoleError,
} from "../../../packages/db/pool";
import { fixtures } from "../../../packages/db/fixtures";
import {
  AccessError,
  requirePermission,
  withTenantTransaction,
} from "../../../packages/db/tenant-transaction";
import {
  configuredOidc,
  createSession,
  createSyntheticSession,
  readProductionSession,
  readSession,
  resolveVerifiedIdentity,
  revokeSession,
  sessionCookie,
  switchOrganization,
  verifyCsrf,
  type ServerSession,
} from "../../../packages/auth/sessions";
import { operation, schemaName, validateSchema, validateNativeCapture } from "./contract-validation";
import { CrmService, assertUuid } from "./crm-service";
import { organization } from "./models";
import { requireEntitlement } from "../../../packages/auth/entitlements";
import { MockOidcProvider } from "../../../packages/providers/identity/mock";
import { OidcTokenVerifier, discoverOidcIssuer } from "../../../packages/providers/identity/oidc";
import { acceptInvitation, AdminService } from "./admin-service";
import { SupportService } from "./support-service";
import { NotificationService } from "./notification-service";
import { AppointmentService } from "./appointment-service";
import { BillingService } from "./billing-service";
import { ImportExportService, UploadService } from "./import-export-service";
import { DealService } from "./deal-service";
import { CrmConfigurationService } from "./crm-configuration-service";
import { RoutingService } from "./routing-service";
import { NativeCaptureService } from "./native-capture-service";
import { ConsentService } from "./consent-service";
import { ConsentChannelService } from "./consent-channel-service";
import type { NativeCaptureDecision } from "../../../packages/contracts/internal/capture-port";
import { validateSyntheticConsent } from "./contract-validation";
import { tryNativeMockRead } from "./mls";
import { CmsHttpAdapter } from "./cms";
import { MockStorageProvider } from "../../../packages/providers/storage/mock";
import { createCmsProfileReferencePort } from "./admin-profile-reference";
import { createStaffPools } from "../../../packages/db/staff-pools";
import { createStaffHttpAdapter } from "./control/http-adapter";
import { withStaffTransaction } from "../../../packages/auth/staff-sessions";
import { CampaignDraftService, campaignEtag } from "./marketing";
import { AutomationService } from "./marketing/automation-service";
import { BroadcastPreviewService } from "./marketing/broadcast-preview-service";
import { CampaignWorkflowService, WorkflowCommandError } from "./marketing/workflow-service";
import { MessageDesignDraftService } from "./marketing/message-design-service";
import { MessageDesignCommandError } from "./marketing/message-design-errors";
import { messageDesignEtag } from "./marketing/message-design-model";
import { tryPublicSiteRoute } from "./public-site-service";
import { IdxTemplateHttpAdapter } from "./idx-template";
import { createIdxTemplateRuntimeProvider } from "./idx-template-runtime";
import { idxTemplateOrigins, verifyIdxTemplateRequest } from "../../../packages/auth/idx-template-bridge";
import { projectIdxTemplateContent } from "../../../packages/templates/idx-template";

const allowedOrigins = new Set(
  (process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000,http://localhost:3000").split(","),
);
const syntheticEnabled =
  ["development", "test"].includes(process.env.APP_ENV ?? "") && process.env.DEV_AUTH_ENABLED === "true";
const oidc = syntheticEnabled
  ? new MockOidcProvider({
      clientId: "estate-synthetic-bff",
      redirectUris: ["http://127.0.0.1:3001/dev/oidc/callback"],
      mode: process.env.APP_ENV === "test" ? "test" : "development",
    })
  : null;
const productionOidc = (() => {
  if (syntheticEnabled) return null;
  try {
    return configuredOidc();
  } catch (error) {
    if (error instanceof AccessError && error.code === "identity_provider_unconfigured") return null;
    throw error;
  }
})();
let productionVerifier: OidcTokenVerifier | null = null;
const pendingOidcStates = new Map<string, { nonce: string; verifier: string; expires: number }>();
const loopback = (address: string | undefined) =>
  !!address && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
const loginAttempts = new Map<string, { count: number; resets: number }>();
const requestRates = new Map<string, { count: number; resets: number }>();
type ApiCommandResponse = {
  body: unknown;
  status: number;
  etag?: string;
  syntheticToken?: string;
  termsVersion?: string;
  routingCanReplace?: boolean;
};
function rate(map: typeof requestRates, key: string, maximum: number) {
  const now = Date.now();
  const old = map.get(key);
  const entry = old && old.resets > now ? old : { count: 0, resets: now + 60_000 };
  entry.count++;
  map.set(key, entry);
  if (entry.count > maximum)
    throw new AccessError(429, "rate_limited", "Too many requests. Retry after one minute.");
  if (map.size > 10_000) for (const [id, state] of map) if (state.resets < now) map.delete(id);
}
function origin(req: Request) {
  if (!req.headers.origin || !allowedOrigins.has(req.headers.origin))
    throw new AccessError(403, "origin_denied", "Request origin is not allowed.");
}
function localAccess(req: Request) {
  if (!syntheticEnabled)
    throw new AccessError(404, "synthetic_identity_disabled", "Development identity is disabled.");
  const forwarded = req.headers["x-forwarded-for"];
  if (
    !loopback(req.socket.remoteAddress) ||
    req.headers.forwarded ||
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-host"] ||
    (forwarded &&
      String(forwarded)
        .split(",")
        .some((address) => !loopback(address.trim())))
  )
    throw new AccessError(403, "loopback_required", "Synthetic identity is available on loopback only.");
}
function localIdentity(req: Request) {
  localAccess(req);
  origin(req);
}
function revision(req: Request) {
  return req.headers["if-match"] as string | undefined;
}
function problem(error: unknown, traceId: string, path: string) {
  let failure =
    error instanceof AccessError
      ? error
      : new AccessError(503, "service_unavailable", "The operation could not be completed.");
  const pgCode = (error as { code?: string })?.code;
  if (pgCode && ["23503", "23514", "22P02", "22007", "22008"].includes(pgCode))
    failure = new AccessError(422, "business_validation_failed", "Referenced data or values are invalid.");
  if (pgCode && ["23505", "40001", "40P01"].includes(pgCode))
    failure = new AccessError(409, "command_conflict", "A conflicting operation occurred. Reload and retry.");
  return {
    type: `https://estate.example/problems/${failure.code}`,
    title: failure.message,
    status: failure.status,
    code: failure.code,
    traceId,
    instance: path,
    ...(failure instanceof WorkflowCommandError || failure instanceof MessageDesignCommandError
      ? { errors: failure.errors }
      : {}),
  };
}

async function sessionBody(session: ServerSession, res: Response) {
  return withTenantTransaction(runtimePool, session, async (client, context) => {
    const identities = await client.query(
      "SELECT display_name,phone,timezone,row_version FROM app.user_identity WHERE id=$1",
      [session.userId],
    );
    const organizations = await client.query(
      `SELECT o.* FROM app.organization o JOIN app.membership m ON m.tenant_id=o.id WHERE m.user_id=$1 AND m.status='active' ORDER BY o.name`,
      [session.userId],
    );
    const identity = identities.rows[0];
    res.setHeader("X-CSRF-Token", session.csrfToken);
    res.setHeader("X-Member-Id", context.memberId);
    if (syntheticEnabled) res.setHeader("X-Synthetic-Identity", "true");
    res.setHeader("ETag", `"${identity.row_version}"`);
    const body = {
      userId: session.userId,
      profile: { displayName: identity.display_name, phone: identity.phone, timezone: identity.timezone },
      organizations: organizations.rows.map(organization),
      activeOrgId: session.organizationId,
      permissions: context.permissions.map((p) => p.code),
    };
    validateSchema("Session", body, true);
    return body;
  });
}

@Controller()
class ApiController {
  @All("{*path}")
  async dispatch(@Req() req: Request, @Res() res: Response) {
    const traceId = String(res.getHeader("X-Trace-Id") ?? randomUUID());
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Trace-Id", traceId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (req.path === "/health" && req.method === "GET") {
        await runtimePool.query("SELECT 1");
        if (syntheticEnabled && /^[0-9a-f]{32}$/.test(process.env.API_VERIFICATION_ID ?? ""))
          res.setHeader("X-Verification-Instance", process.env.API_VERIFICATION_ID!);
        res.json({
          status: "ready",
          identityMode: syntheticEnabled ? "synthetic-loopback" : productionOidc ? "oidc" : "unconfigured",
          mlsMode: "mock",
          deliveryMode: "no-delivery",
        });
        return;
      }
      if (req.cookies?.estate_staff_session && req.cookies?.[sessionCookie])
        throw new AccessError(
          403,
          "identity_context_ambiguous",
          "Select one identity context before access.",
        );
      if (req.path === "/dev/session" && req.method === "POST") {
        localIdentity(req);
        rate(loginAttempts, req.socket.remoteAddress ?? "", syntheticEnabled ? 200 : 20);
        if (
          !req.body ||
          !["owner", "agent"].includes(req.body.identity) ||
          Object.keys(req.body).length !== 1
        )
          throw new AccessError(422, "identity_invalid", "Choose owner or agent synthetic identity.");
        const verifier = randomBytes(32).toString("base64url");
        const state = randomBytes(32).toString("base64url");
        const nonce = randomBytes(32).toString("base64url");
        const callback = new URL(
          oidc!.authorize(
            {
              clientId: "estate-synthetic-bff",
              redirectUri: "http://127.0.0.1:3001/dev/oidc/callback",
              state,
              nonce,
              codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
              codeChallengeMethod: "S256",
            },
            req.body.identity,
          ),
        );
        if (callback.searchParams.get("state") !== state)
          throw new AccessError(401, "oidc_state_invalid", "Identity state validation failed.");
        const token = oidc!.exchange({
          clientId: "estate-synthetic-bff",
          redirectUri: "http://127.0.0.1:3001/dev/oidc/callback",
          code: callback.searchParams.get("code")!,
          codeVerifier: verifier,
        });
        const verified = await oidc!.verifyIdentityToken(token.idToken, {
          clientId: "estate-synthetic-bff",
          nonce,
        });
        const identity = await resolveVerifiedIdentity(runtimePool, verified);
        const result = await createSyntheticSession(runtimePool, identity, fixtures.orgA);
        res.cookie(sessionCookie, result.token, {
          httpOnly: true,
          sameSite: "lax",
          secure: false,
          path: "/",
          maxAge: 8 * 60 * 60 * 1000,
        });
        const session = await readSession(runtimePool, result.token);
        res.json(await sessionBody(session, res));
        return;
      }
      if (req.path === "/v1/auth/login" && req.method === "POST" && productionOidc) {
        rate(loginAttempts, req.socket.remoteAddress ?? "", 20);
        origin(req);
        const discovery = await discoverOidcIssuer(productionOidc.issuer);
        const verifier = randomBytes(32).toString("base64url");
        const state = randomBytes(32).toString("base64url");
        const nonce = randomBytes(32).toString("base64url");
        const redirectUri = req.body?.redirectUri;
        if (
          !redirectUri ||
          typeof redirectUri !== "string" ||
          !allowedOrigins.has(new URL(redirectUri).origin)
        )
          throw new AccessError(422, "redirect_uri_invalid", "A permitted redirect URI is required.");
        const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
        const params = new URLSearchParams({
          response_type: "code",
          client_id: productionOidc.clientId,
          redirect_uri: redirectUri,
          scope: "openid email profile",
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
        pendingOidcStates.set(state, { nonce, verifier, expires: Date.now() + 10 * 60_000 });
        for (const [k, s] of pendingOidcStates) if (s.expires < Date.now()) pendingOidcStates.delete(k);
        res.json({ authorizationUrl: `${discovery.authorizationEndpoint}?${params}` });
        return;
      }
      if (req.path === "/v1/auth/callback" && req.method === "POST" && productionOidc) {
        rate(loginAttempts, req.socket.remoteAddress ?? "", 20);
        origin(req);
        const { code, state, redirectUri } = req.body ?? {};
        if (!code || !state || !redirectUri)
          throw new AccessError(
            422,
            "callback_parameters_missing",
            "Code, state and redirectUri are required.",
          );
        const pending = pendingOidcStates.get(state);
        if (!pending) throw new AccessError(401, "oidc_state_invalid", "State expired or invalid.");
        pendingOidcStates.delete(state);
        if (pending.expires < Date.now())
          throw new AccessError(401, "oidc_state_expired", "Authentication attempt expired.");
        const discovery = await discoverOidcIssuer(productionOidc.issuer);
        if (!productionVerifier)
          productionVerifier = new OidcTokenVerifier({
            issuer: discovery.issuer,
            jwksUri: discovery.jwksUri,
          });
        const tokenResponse = await fetch(discovery.tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: productionOidc.clientId,
            redirect_uri: redirectUri,
            code,
            code_verifier: pending.verifier,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!tokenResponse.ok)
          throw new AccessError(
            401,
            "oidc_token_exchange_failed",
            "Identity provider rejected the token exchange.",
          );
        const tokens = (await tokenResponse.json()) as { id_token?: string };
        if (!tokens.id_token)
          throw new AccessError(401, "oidc_no_id_token", "Identity provider did not return an ID token.");
        const verified = await productionVerifier.verifyIdentityToken(tokens.id_token, {
          clientId: productionOidc.clientId,
          nonce: pending.nonce,
        });
        const userId = await resolveVerifiedIdentity(runtimePool, verified);
        const membershipClient = await runtimePool.connect();
        let organizationId: string | undefined;
        try {
          await membershipClient.query("BEGIN");
          await membershipClient.query("SELECT set_config('app.actor_id',$1,true)", [userId]);
          const membership = await membershipClient.query<{ tenant_id: string }>(
            "SELECT tenant_id FROM app.membership WHERE user_id=$1 AND status='active' ORDER BY created_at,id LIMIT 1",
            [userId],
          );
          organizationId = membership.rows[0]?.tenant_id;
          await membershipClient.query("COMMIT");
        } catch (error) {
          await membershipClient.query("ROLLBACK");
          throw error;
        } finally {
          membershipClient.release();
        }
        if (!organizationId) throw new AccessError(403, "membership_required", "Active membership required.");
        const result = await createSession(runtimePool, userId, organizationId, {
          identity: verified,
          clientId: productionOidc.clientId,
        });
        res.cookie(sessionCookie, result.token, {
          httpOnly: true,
          sameSite: "lax",
          secure: true,
          path: "/",
          maxAge: 8 * 60 * 60 * 1000,
        });
        const session = await readProductionSession(runtimePool, result.token);
        res.json(await sessionBody(session, res));
        return;
      }
      if (req.path.startsWith("/v1/public/")) {
        const isMutation = req.method !== "GET" && req.method !== "HEAD";
        rate(
          requestRates,
          `public:${req.socket.remoteAddress ?? "unknown"}:${isMutation ? "mutation" : "read"}`,
          isMutation ? 60 : 200,
        );
        if (/^\/v1\/public\/sites\/[^/]+\/idx-template(?:\/|$)/.test(req.path)) {
          const adapter = new IdxTemplateHttpAdapter(runtimePool, {
            allowedOrigins: idxTemplateOrigins(),
            trustedOrigin: (request) => verifyIdxTemplateRequest({ ...request, headers: req.headers }),
            createProvider: createIdxTemplateRuntimeProvider,
            projectContent: projectIdxTemplateContent,
          });
          const result = await adapter.handle({
            method: req.method,
            url: req.originalUrl,
            headers: Object.fromEntries(
              Object.entries(req.headers).map(([name, value]) => [
                name,
                typeof value === "string" ? value : undefined,
              ]),
            ),
            body: req.body,
            remoteAddress: req.socket.remoteAddress,
          });
          for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
          res.status(result.status).json(result.body);
          return;
        }
        const handled = await tryPublicSiteRoute(req, res, runtimePool, traceId, {
          signingKey:
            process.env.CURSOR_SIGNING_KEY ?? "synthetic-local-cursor-signing-only-not-for-production",
        });
        if (handled) return;
      }
      const session = syntheticEnabled
        ? await readSession(runtimePool, req.cookies?.[sessionCookie])
        : await readProductionSession(runtimePool, req.cookies?.[sessionCookie]);
      if (syntheticEnabled) localAccess(req);
      const reading = ["GET", "HEAD"].includes(req.method);
      rate(
        requestRates,
        `${session.userId}:${reading ? "read" : "mutation"}`,
        reading ? (syntheticEnabled ? 10000 : 300) : syntheticEnabled ? 5000 : 120,
      );
      if (req.method !== "GET" && req.method !== "HEAD") {
        origin(req);
        verifyCsrf(session, req.headers["x-csrf-token"] as string | undefined);
      }
      if (req.path === "/dev/session/organization" && req.method === "POST") {
        localIdentity(req);
        if (!req.body || Object.keys(req.body).length !== 1)
          throw new AccessError(422, "organization_invalid", "Organization ID required.");
        assertUuid(req.body.organizationId);
        await switchOrganization(runtimePool, session, req.body.organizationId);
        res.json(await sessionBody({ ...session, organizationId: req.body.organizationId }, res));
        return;
      }
      if (req.path === "/v1/session/organization" && req.method === "POST") {
        if (!req.body || Object.keys(req.body).length !== 1)
          throw new AccessError(422, "organization_invalid", "Organization ID required.");
        assertUuid(req.body.organizationId);
        await switchOrganization(runtimePool, session, req.body.organizationId);
        res.json(await sessionBody({ ...session, organizationId: req.body.organizationId }, res));
        return;
      }
      if (req.path === "/dev/logout" && req.method === "POST") {
        localIdentity(req);
        await revokeSession(runtimePool, session);
        res.clearCookie(sessionCookie, { path: "/" });
        res.status(204).end();
        return;
      }
      if (req.path === "/v1/logout" && req.method === "POST") {
        await revokeSession(runtimePool, session);
        res.clearCookie(sessionCookie, { path: "/", httpOnly: true, sameSite: "lax", secure: true });
        res.status(204).end();
        return;
      }
      if (req.path === "/v1/session" && req.method === "GET") {
        res.json(await sessionBody(session, res));
        return;
      }
      const nativeListings = await tryNativeMockRead(
        {
          path: req.path,
          method: req.method,
          query: req.query,
          body: req.body,
          remoteAddress: req.socket.remoteAddress,
          forwardedFor: req.headers["x-forwarded-for"],
        },
        session,
        runtimePool,
        {
          signingKey:
            process.env.CURSOR_SIGNING_KEY ?? "synthetic-local-cursor-signing-only-not-for-production",
        },
      );
      if (nativeListings) {
        res.status(200).json(nativeListings.body);
        return;
      }
      if (
        req.path === "/v1/templates" ||
        /^\/v1\/orgs\/[^/]+\/(?:sites|documents|revisions|domains|media|forms)(?:\/|$)/.test(req.path) ||
        /^\/dev\/orgs\/[^/]+\/cms\/documents\/[^/]+\/(?:drafts|revision-history|revisions\/[^/]+\/recovery)$/.test(
          req.path,
        )
      ) {
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(req.headers))
          if (typeof value === "string") headers[key] = value;
        const result = await new CmsHttpAdapter(runtimePool, {
          profiles: createCmsProfileReferencePort,
          trustedLinkPolicy: { approvedLinkOrigins: new Set() },
          allowedOrigins,
          storage: new MockStorageProvider(`http://127.0.0.1:${process.env.PORT ?? 3001}`),
        }).handle({
          method: req.method,
          url: req.originalUrl,
          headers,
          body: req.body,
          remoteAddress: req.socket.remoteAddress,
        });
        for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
        res.status(result.status).json(result.body);
        return;
      }
      const uploadMatch = req.path.match(/^\/dev\/storage\/uploads\/([^/]+)$/);
      if (uploadMatch && req.method === "PUT") {
        localIdentity(req);
        await withTenantTransaction(runtimePool, session, async (client, context) => {
          requirePermission(context, "media.write");
          await requireEntitlement(client, "crm.import");
          await new UploadService(client, context, traceId).put(
            uploadMatch[1],
            String(req.headers["x-upload-grant"] ?? ""),
            String(req.headers["content-type"] ?? ""),
            req.body,
          );
        });
        res.status(204).end();
        return;
      }
      const exportMatch = req.path.match(/^\/dev\/exports\/([^/]+)$/);
      if (exportMatch && req.method === "GET") {
        localAccess(req);
        const result = await withTenantTransaction(runtimePool, session, (client, context) =>
          new ImportExportService(client, context, traceId).download(exportMatch[1]),
        );
        res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
        res.type("text/csv; charset=utf-8").send(result.bytes);
        return;
      }
      const organizationMatch = req.path.match(/^\/v1\/orgs\/([^/]+)$/);
      const consentChannels = req.path.match(/^\/dev\/consent-channels\/([^/]+)$/);
      if (consentChannels && req.method === "GET") {
        localAccess(req);
        const body = await withTenantTransaction(runtimePool, session, async (client, context) => {
          if (requirePermission(context, "consent.write") !== "organization")
            throw new AccessError(
              403,
              "consent_scope_unavailable",
              "Organization consent authority is required.",
            );
          const response = await new ConsentChannelService(client, context).list(consentChannels[1]);
          validateSyntheticConsent("ChannelsResponse", response, true);
          return response;
        });
        res.json(body);
        return;
      }
      if (req.path === "/dev/consent-evidence" && req.method === "POST") {
        localIdentity(req);
        validateSyntheticConsent("EvidenceRequest", req.body);
        const body = await withTenantTransaction(runtimePool, session, (client, context) =>
          new ConsentService(client, context, traceId).issueEvidence(
            req.body,
            req.headers["idempotency-key"] as string,
          ),
        );
        res.status(201).json(body);
        return;
      }
      if (req.path === "/v1/member-invitations/accept" && req.method === "POST") {
        validateSchema("InvitationAccept", req.body);
        const result = await acceptInvitation(
          session,
          req.body.token,
          traceId,
          req.headers["idempotency-key"] as string | undefined,
        );
        validateSchema("Job", result.body, true);
        res.status(result.status).json(result.body);
        return;
      }
      if (["/dev/billing/reconcile", "/dev/billing/webhook"].includes(req.path) && req.method === "POST") {
        localIdentity(req);
        const result = await withTenantTransaction(runtimePool, session, async (client, context) => {
          requirePermission(context, "billing.manage");
          await requireEntitlement(client, "billing.manage");
          const service = new BillingService(client, context, traceId);
          if (req.path === "/dev/billing/reconcile") {
            if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.previewId !== "string")
              throw new AccessError(422, "reconciliation_invalid", "Preview ID required.");
            return service.reconcile(req.body.previewId);
          }
          if (
            !req.body ||
            Object.keys(req.body).length !== 2 ||
            typeof req.body.rawBody !== "string" ||
            typeof req.body.signature !== "string"
          )
            throw new AccessError(422, "webhook_invalid", "Synthetic rawBody and signature required.");
          return service.webhook(req.body.rawBody, req.body.signature);
        });
        validateSchema("Job", result.body, true);
        res.status(result.status).json(result.body);
        return;
      }
      if (req.path === "/dev/capture" && req.method === "POST") {
        localIdentity(req);
        validateNativeCapture(req.body);
        const result = await withTenantTransaction(runtimePool, session, async (client, context) => {
          const service = new NativeCaptureService(client, context, traceId);
          let decision: NativeCaptureDecision | undefined;
          const response = await service.foundation.idempotent(
            req.headers["idempotency-key"] as string | undefined,
            "POST /dev/capture",
            req.body,
            undefined,
            async () => {
              decision = await service.capture(req.body);
              return { body: decision.lead, status: 201 };
            },
            async () => {
              decision = await service.capture(req.body);
            },
          );
          if (!decision) throw new AccessError(503, "capture_unavailable", "Capture decision unavailable.");
          validateSchema("Lead", decision.lead, true);
          return { ...response, ...decision, body: decision.lead };
        });
        res.setHeader("ETag", `"${result.lead.version}"`);
        res.setHeader("X-Synthetic-Capture", "true");
        res.setHeader("X-Capture-Decision-Id", result.decisionId);
        if (result.winningRuleId) res.setHeader("X-Routing-Rule-Id", result.winningRuleId);
        res.setHeader("X-Routing-Reasons", result.reasonCodes.join(","));
        res.status(result.status).json(result.body);
        return;
      }
      if (organizationMatch && ["GET", "PATCH"].includes(req.method)) {
        const orgId = organizationMatch[1];
        assertUuid(orgId);
        if (orgId !== session.organizationId)
          throw new AccessError(
            403,
            "active_organization_mismatch",
            "Select this organization before accessing it.",
          );
        if (req.method === "PATCH") validateSchema("OrganizationCreate", req.body);
        const result = await withTenantTransaction(
          runtimePool,
          session,
          async (client, context) => {
            const admin = new AdminService(client, context, traceId);
            const command =
              req.method === "GET"
                ? { body: await admin.getOrganization(), status: 200 }
                : await admin.foundation.idempotent(
                    req.headers["idempotency-key"] as string,
                    `${req.method} ${req.path}`,
                    req.body,
                    revision(req),
                    () => admin.updateOrganization(req.body, revision(req)),
                  );
            validateSchema("Organization", command.body, true);
            return command;
          },
          { lockOrganization: req.method === "PATCH" },
        );
        const version = (result.body as { version: number }).version;
        res.setHeader("ETag", `"${version}"`);
        res.status(result.status).json(result.body);
        return;
      }
      if (req.path === "/v1/session/profile" && req.method === "PATCH") {
        validateSchema("Profile", req.body);
        const result = await withTenantTransaction(runtimePool, session, async (client, context) => {
          requirePermission(context, "self.profile.write");
          const crm = new CrmService(client, context, traceId);
          return crm.idempotent(
            req.headers["idempotency-key"] as string,
            `${req.method} ${req.path}`,
            req.body,
            revision(req),
            async () => {
              const identity = await client.query("SELECT * FROM app.user_identity WHERE id=$1 FOR UPDATE", [
                session.userId,
              ]);
              const current = identity.rows[0];
              if (revision(req)?.replaceAll('"', "") !== String(current.row_version))
                throw new AccessError(412, "revision_changed", "Profile changed. Reload before retrying.");
              if (!req.body.displayName.trim())
                throw new AccessError(422, "empty_text", "Display name cannot be empty.");
              try {
                new Intl.DateTimeFormat("en-US", { timeZone: req.body.timezone }).format();
              } catch {
                throw new AccessError(422, "timezone_invalid", "Valid IANA timezone required.");
              }
              await client.query(
                "SELECT set_config('app.auth_issuer',$1,true),set_config('app.auth_subject',$2,true)",
                [current.issuer, current.subject],
              );
              const updated = await client.query(
                "UPDATE app.user_identity SET display_name=$1,phone=$2,timezone=$3,row_version=row_version+1,updated_at=now() WHERE id=$4 RETURNING row_version",
                [req.body.displayName.trim(), req.body.phone ?? null, req.body.timezone, session.userId],
              );
              await crm.audit(
                "profile.updated",
                "user_identity",
                session.userId,
                Number(updated.rows[0].row_version),
              );
              return {
                body: {
                  displayName: req.body.displayName.trim(),
                  phone: req.body.phone ?? null,
                  timezone: req.body.timezone,
                },
                status: 200,
                etag: `"${updated.rows[0].row_version}"`,
              };
            },
          );
        });
        if (result.etag) res.setHeader("ETag", result.etag);
        res.status(result.status).json(result.body);
        return;
      }
      const match = req.path.match(
        /^\/v1\/orgs\/([^/]+)\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/,
      );
      if (!match) throw new AccessError(404, "route_unavailable", "Route unavailable.");
      let [, org, resource, id, action, subAction] = match;
      assertUuid(org);
      if (org !== session.organizationId)
        throw new AccessError(
          403,
          "active_organization_mismatch",
          "Select this organization before accessing its records.",
        );
      const compoundResources: Record<string, Set<string>> = {
        ai: new Set(["jobs"]),
        "local-presence": new Set(["entities", "profiles"]),
        reports: new Set(["query"]),
      };
      if (id && compoundResources[resource!]?.has(id)) {
        resource = `${resource}/${id}`;
        id = action;
        action = subAction;
      }
      const resourceId: Record<string, string> = {
        contacts: "contactId",
        leads: "leadId",
        tasks: "taskId",
        deals: "dealId",
        tags: "tagId",
        members: "memberId",
        roles: "roleId",
        offices: "officeId",
        "business-profiles": "businessProfileId",
        jobs: "jobId",
        tickets: "ticketId",
        notifications: "notificationId",
        "pipeline-stages": "pipelineStageId",
        "lead-sources": "leadSourceId",
        campaigns: "campaignId",
        "campaign-versions": "campaignVersionId",
        "message-designs": "messageDesignId",
        "contact-merges": "mergeId",
        "audit-events": "auditEventId",
        "broadcast-confirmations": "confirmationId",
        "push-subscriptions": "pushDeviceId",
        "mls-feeds": "feedId",
        integrations: "integrationId",
        "ai/jobs": "aiJobId",
      };
      const path = ["billing", "imports"].includes(resource)
        ? `/v1/orgs/{orgId}/${resource}${id ? `/${id}` : ""}`
        : `/v1/orgs/{orgId}/${resource}${id ? `/{${resourceId[resource] ?? "id"}}` : ""}${action ? `/${action}` : ""}`;
      const spec = operation(path, req.method);
      const bodySchema = spec.requestBody?.content["application/json"]?.schema.$ref;
      if (bodySchema) validateSchema(schemaName(bodySchema), req.body);
      const successEntry = Object.entries(spec.responses).find(([status]) => /^2\d\d$/.test(status));
      const responseSchema = successEntry?.[1].content?.["application/json"]?.schema.$ref;
      const result = await withTenantTransaction(
        runtimePool,
        session,
        async (client, context) => {
          requirePermission(context, spec["x-permission"]);
          if (resource === "consent-events" && req.method === "POST" && !id) {
            const body = await new ConsentService(client, context, traceId).record(req.body, {
              producer: "staff",
              key: req.headers["idempotency-key"] as string,
            });
            if (responseSchema) validateSchema(schemaName(responseSchema), body, true);
            return { body, status: 202 };
          }
          await requireEntitlement(client, spec["x-permission"]);
          if (resource === "appointments") {
            if (req.method !== "GET" || id || action)
              throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (req.body !== undefined)
              throw new AccessError(422, "body_not_allowed", "This read accepts no request body.");
            const body = await new AppointmentService(client, context).list(req.query);
            if (responseSchema) validateSchema(schemaName(responseSchema), body, true);
            return { body, status: 200 };
          }
          if (resource === "notifications") {
            const notifications = new NotificationService(client, context, traceId);
            let response: ApiCommandResponse;
            if (req.method === "GET" && !id && !action) {
              if (Object.keys(req.query).some((key) => !["cursor", "limit"].includes(key)))
                throw new AccessError(422, "query_invalid", "Only notification pagination is supported.");
              response = { body: await notifications.list(req.query), status: 200 };
            } else if (req.method === "POST" && id && action === "read") {
              if (Object.keys(req.query).length)
                throw new AccessError(422, "query_invalid", "This command has no query parameters.");
              if (
                req.body !== undefined &&
                (req.body === null ||
                  typeof req.body !== "object" ||
                  Array.isArray(req.body) ||
                  Object.keys(req.body).length > 0)
              )
                throw new AccessError(422, "body_not_allowed", "This command accepts no content fields.");
              response = await notifications.markRead(
                id,
                req.headers["idempotency-key"] as string | undefined,
              );
            } else throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (responseSchema) validateSchema(schemaName(responseSchema), response.body, true);
            return response;
          }
          if (resource === "audit-events") {
            if (req.method !== "GET" || id || action)
              throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (req.body !== undefined)
              throw new AccessError(422, "body_not_allowed", "This read accepts no request body.");
            const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
            const cursor = req.query.cursor as string | undefined;
            let whereClause = "WHERE tenant_id=$1";
            const params: (string | number)[] = [session.organizationId, limit + 1];
            if (cursor) {
              assertUuid(cursor);
              whereClause += ` AND (created_at,id)<(SELECT created_at,id FROM app.audit_event WHERE tenant_id=$1 AND id=$${params.length + 1})`;
              params.push(cursor);
            }
            const rows = await client.query(
              `SELECT id,actor_ref,action,resource_type,resource_id,trace_id,created_at FROM app.audit_event ${whereClause} ORDER BY created_at DESC,id DESC LIMIT $2`,
              params,
            );
            const hasMore = rows.rows.length > limit;
            const items = rows.rows.slice(0, limit).map((r) => ({
              id: r.id,
              actorRef: r.actor_ref,
              action: r.action,
              resourceType: r.resource_type,
              resourceId: r.resource_id,
              traceId: r.trace_id,
              createdAt: r.created_at.toISOString(),
            }));
            const body = {
              items,
              nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
              hasMore,
            };
            if (responseSchema) validateSchema(schemaName(responseSchema), body, true);
            return { body, status: 200 };
          }
          if (resource === "push-subscriptions") {
            if (action) throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (req.method === "GET" && !id) {
              requirePermission(context, spec["x-permission"]);
              const rows = await client.query(
                `SELECT id,device_label,topics,state,row_version FROM app.push_subscription
                 WHERE tenant_id=$1 AND member_id=$2 ORDER BY created_at DESC LIMIT 100`,
                [context.organizationId, context.memberId],
              );
              const body = {
                items: rows.rows.map((r) => ({
                  id: r.id,
                  deviceLabel: r.device_label,
                  topics: r.topics,
                  state: r.state,
                  version: Number(r.row_version),
                })),
                nextCursor: null,
                hasMore: false,
              };
              if (responseSchema) validateSchema(schemaName(responseSchema), body, true);
              return { body, status: 200 };
            }
            if (req.method === "POST" && !id) {
              requirePermission(context, spec["x-permission"]);
              validateSchema("PushSubscriptionWrite", req.body);
              const endpointHash = createHash("sha256").update(req.body.endpoint).digest("hex");
              const encrypted = JSON.stringify({ endpoint: req.body.endpoint, keys: req.body.keys });
              const row = await client.query(
                `INSERT INTO app.push_subscription(tenant_id,member_id,endpoint_hash,encrypted_subscription,device_label,topics,state)
                 VALUES($1,$2,$3,$4,$5,$6,'active')
                 ON CONFLICT(tenant_id,member_id,endpoint_hash)
                 DO UPDATE SET encrypted_subscription=EXCLUDED.encrypted_subscription,
                   device_label=EXCLUDED.device_label,topics=EXCLUDED.topics,
                   state='active',row_version=app.push_subscription.row_version+1,updated_at=now()
                 RETURNING id,device_label,topics,state,row_version`,
                [
                  context.organizationId,
                  context.memberId,
                  endpointHash,
                  encrypted,
                  (req.body.deviceLabel || "Device").slice(0, 120),
                  JSON.stringify(req.body.topics),
                ],
              );
              const body = {
                id: row.rows[0].id,
                deviceLabel: row.rows[0].device_label,
                topics: row.rows[0].topics,
                state: row.rows[0].state,
                version: Number(row.rows[0].row_version),
              };
              if (responseSchema) validateSchema(schemaName(responseSchema), body, true);
              return { body, status: 201, etag: `"${row.rows[0].row_version}"` };
            }
            if (req.method === "DELETE" && id) {
              requirePermission(context, spec["x-permission"]);
              assertUuid(id);
              const deleted = await client.query(
                `UPDATE app.push_subscription SET state='revoked',row_version=row_version+1,updated_at=now()
                 WHERE tenant_id=$1 AND member_id=$2 AND id=$3 AND state='active' RETURNING id`,
                [context.organizationId, context.memberId, id],
              );
              if (!deleted.rowCount)
                throw new AccessError(404, "push_device_unavailable", "Device not found or already revoked.");
              return { body: null, status: 204 };
            }
            throw new AccessError(404, "route_unavailable", "Route unavailable.");
          }
          if (resource === "message-designs") {
            localAccess(req);
            if (action) throw new AccessError(404, "route_unavailable", "Route unavailable.");
            const designs = new MessageDesignDraftService(client, context, traceId);
            let response: ApiCommandResponse;
            if (req.method === "GET") {
              const body = id ? await designs.get(id) : await designs.list(req.query);
              response = {
                body,
                status: 200,
                etag: id ? messageDesignEtag((body as { version: number }).version) : undefined,
              };
            } else if (req.method === "POST" && !id) {
              response = await designs.create(req.body, {
                key: req.headers["idempotency-key"] as string | undefined,
              });
            } else if (req.method === "PATCH" && id) {
              response = await designs.update(id, req.body, {
                key: req.headers["idempotency-key"] as string | undefined,
                ifMatch: revision(req),
              });
            } else throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (responseSchema) validateSchema(schemaName(responseSchema), response.body, true);
            return response;
          }
          if ((resource === "campaigns" && action === "versions" && id) || resource === "campaign-versions") {
            localAccess(req);
            const workflows = new CampaignWorkflowService(client, context, traceId);
            let response: ApiCommandResponse;
            if (resource === "campaigns" && req.method === "GET") {
              response = { body: await workflows.list(id!, req.query), status: 200 };
            } else if (resource === "campaigns" && req.method === "POST") {
              response = await workflows.create(id!, req.body, {
                key: req.headers["idempotency-key"] as string | undefined,
              });
            } else if (resource === "campaign-versions" && id && !action && req.method === "GET") {
              const body = await workflows.get(id);
              response = { body, status: 200, etag: campaignEtag(body.version) };
            } else if (
              resource === "campaign-versions" &&
              id &&
              action === "publish" &&
              req.method === "POST"
            ) {
              response = await workflows.publish(id, {
                key: req.headers["idempotency-key"] as string | undefined,
              });
            } else throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (responseSchema) validateSchema(schemaName(responseSchema), response.body, true);
            return response;
          }
          if (resource === "campaigns") {
            localAccess(req);
            const campaigns = new CampaignDraftService(client, context, traceId);
            if (id && action === "archive" && req.method === "POST") {
              const result = await campaigns.archive(id, {
                key: req.headers["idempotency-key"] as string | undefined,
              });
              if (responseSchema) validateSchema(schemaName(responseSchema), result.body, true);
              return result as ApiCommandResponse;
            }
            if (action) throw new AccessError(404, "route_unavailable", "Route unavailable.");
            let response: ApiCommandResponse;
            if (req.method === "GET") {
              const body = id ? await campaigns.get(id) : await campaigns.list(req.query);
              response = {
                body,
                status: 200,
                etag: id ? campaignEtag((body as { version: number }).version) : undefined,
              };
            } else if (req.method === "POST" && !id) {
              response = await campaigns.create(req.body, {
                key: req.headers["idempotency-key"] as string | undefined,
              });
            } else if (req.method === "PATCH" && id) {
              response = await campaigns.update(id, req.body, {
                key: req.headers["idempotency-key"] as string | undefined,
                ifMatch: revision(req),
              });
            } else throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (responseSchema) validateSchema(schemaName(responseSchema), response.body, true);
            return response;
          }
          if (resource === "automations") {
            localAccess(req);
            const automations = new AutomationService(client, context, traceId);
            let response: ApiCommandResponse;
            if (req.method === "GET" && id && !action) {
              response = { body: await automations.getAutomation(id), status: 200, etag: undefined };
            } else if (req.method === "GET" && !id && !action) {
              response = { body: await automations.listAutomations(req.query), status: 200 };
            } else if (req.method === "POST" && !id && !action) {
              const result = await automations.createAutomation(req.body, {
                key: req.headers["idempotency-key"] as string | undefined,
              });
              response = result as ApiCommandResponse;
            } else if (req.method === "PATCH" && id && !action) {
              const result = await automations.updateAutomation(id, req.body, {
                key: req.headers["idempotency-key"] as string | undefined,
                ifMatch: revision(req),
              });
              response = result as ApiCommandResponse;
            } else throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (responseSchema) validateSchema(schemaName(responseSchema), response.body, true);
            return response;
          }
          if (resource === "enrollments") {
            localAccess(req);
            const automations = new AutomationService(client, context, traceId);
            let response: ApiCommandResponse;
            if (req.method === "POST" && !id && !action) {
              const result = await automations.enrollLead(req.body, {
                key: req.headers["idempotency-key"] as string | undefined,
              });
              response = result as ApiCommandResponse;
            } else if (req.method === "GET" && !id && !action) {
              response = { body: await automations.listEnrollments(req.query), status: 200 };
            } else if (req.method === "POST" && id && action === "cancel") {
              const result = await automations.cancelEnrollment(id, {
                key: req.headers["idempotency-key"] as string | undefined,
              });
              response = result as ApiCommandResponse;
            } else throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (responseSchema) validateSchema(schemaName(responseSchema), response.body, true);
            return response;
          }
          if (resource === "broadcast-confirmations") {
            localAccess(req);
            if (req.method !== "POST" || id || action)
              throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (Object.keys(req.query).length)
              throw new AccessError(422, "query_invalid", "This command has no query parameters.");
            requirePermission(context, spec["x-permission"]);
            await requireEntitlement(client, spec["x-permission"]);
            const body = req.body;
            validateSchema("PreviewConfirm", body);
            assertUuid(body.previewId);
            const preview = await client.query(
              `SELECT ir.response_ref,ir.response_body,ir.expires_at>clock_timestamp() AS unexpired
               FROM app.idempotency_record ir
               WHERE ir.tenant_id=$1 AND ir.route_key LIKE 'POST /v1/orgs/%/broadcast-previews'
                 AND ir.response_ref=$2 AND ir.actor_ref=$3`,
              [context.organizationId, body.previewId, context.userId],
            );
            if (!preview.rowCount)
              throw new AccessError(
                404,
                "preview_unavailable",
                "Preview unavailable or outside your request scope.",
              );
            if (!preview.rows[0].unexpired)
              throw new AccessError(409, "preview_expired", "Create a new preview before confirming.");
            const jobRow = await client.query(
              `INSERT INTO app.integration_job(tenant_id,kind,state,result_ref,requesting_member_id,safe_result)
               VALUES($1,'broadcast.synthetic.confirmation','queued',$2,$3,$4) RETURNING *`,
              [
                context.organizationId,
                body.previewId,
                context.memberId,
                JSON.stringify({ externalDelivery: false, deliveryMode: "no-delivery" }),
              ],
            );
            await client.query(
              `INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff)
               VALUES($1,$2,'broadcast.confirmed','broadcast_confirmation',$3,$4,$5)`,
              [
                context.organizationId,
                context.userId,
                jobRow.rows[0].id,
                traceId,
                JSON.stringify({ previewId: body.previewId }),
              ],
            );
            const response: ApiCommandResponse = {
              body: {
                id: jobRow.rows[0].id,
                kind: jobRow.rows[0].kind,
                state: jobRow.rows[0].state,
                createdAt: jobRow.rows[0].created_at.toISOString(),
              },
              status: 202,
            };
            if (responseSchema) validateSchema(schemaName(responseSchema), response.body, true);
            return response;
          }
          if (resource === "broadcast-previews") {
            localAccess(req);
            if (req.method !== "POST" || id || action)
              throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (Object.keys(req.query).length)
              throw new AccessError(422, "query_invalid", "This command has no query parameters.");
            const response: ApiCommandResponse = await new BroadcastPreviewService(
              client,
              context,
              traceId,
            ).preview(
              req.body,
              req.headers["idempotency-key"] as string | undefined,
              `${req.method} ${req.path}`,
            );
            if (responseSchema) validateSchema(schemaName(responseSchema), response.body, true);
            return response;
          }
          const crm = new CrmService(client, context, traceId);
          const admin = new AdminService(client, context, traceId);
          const support = new SupportService(client, context, traceId);
          const billing = new BillingService(client, context, traceId);
          const transfers = new ImportExportService(client, context, traceId);
          const uploads = new UploadService(client, context, traceId);
          const deals = new DealService(client, context, traceId);
          const configuration = new CrmConfigurationService(client, context, traceId);
          const routing = new RoutingService(client, context, traceId);
          let response: ApiCommandResponse;
          if (req.method === "GET") {
            if (
              resource === "contacts" &&
              !id &&
              !action &&
              (req.body !== undefined ||
                req.headers["transfer-encoding"] !== undefined ||
                Number(req.headers["content-length"] || 0) > 0)
            )
              throw new AccessError(422, "body_not_allowed", "This read accepts no request body.");
            let body: unknown;
            if (resource === "routing" && !id) {
              response = await routing.list(req.query);
              if (responseSchema) validateSchema(schemaName(responseSchema), response.body, true);
              return response;
            }
            if (resource === "dashboard" && !id && !action) {
              if (
                req.body !== undefined ||
                req.headers["transfer-encoding"] !== undefined ||
                Number(req.headers["content-length"] || 0) > 0
              )
                throw new AccessError(422, "body_not_allowed", "This read accepts no request body.");
              if (Object.keys(req.query).length)
                throw new AccessError(422, "query_invalid", "This read accepts no query parameters.");
              body = await crm.dashboard(req.query);
            } else if (resource === "billing" && !id) body = await billing.overview();
            else if (resource === "deals" && !action)
              body = id ? await deals.detail(id) : await deals.list(req.query);
            else if (["pipeline-stages", "lead-sources", "tags"].includes(resource) && !action)
              body = id
                ? await configuration.detail(resource as "pipeline-stages" | "lead-sources" | "tags", id)
                : await configuration.list(
                    resource as "pipeline-stages" | "lead-sources" | "tags",
                    req.query,
                  );
            else if (resource === "jobs" && id) body = await admin.job(id);
            else if (resource === "tickets" && !action)
              body = id ? await support.get(id) : await support.list(req.query);
            else if (["offices", "business-profiles", "roles"].includes(resource) && !action)
              body = id
                ? await admin.get(resource as "offices" | "business-profiles" | "roles", id)
                : await admin.list(resource as "offices" | "business-profiles" | "roles", req.query);
            else if (resource === "members" && !action) body = await admin.listMembers(req.query);
            else if (resource === "leads" && id && action === "notes") body = await crm.notes(id);
            else if (resource === "leads" && id && action === "activity") body = await crm.activity(id);
            // ADR-049: contact duplicate candidates and merge result
            else if (resource === "contact-duplicates" && !id && !action) {
              if (
                req.body !== undefined ||
                req.headers["transfer-encoding"] !== undefined ||
                Number(req.headers["content-length"] || 0) > 0
              )
                throw new AccessError(422, "body_not_allowed", "This read accepts no request body.");
              const allowedDupParams = new Set(["limit", "cursor"]);
              const unknownDupParam = Object.keys(req.query).find((k) => !allowedDupParams.has(k));
              if (unknownDupParam)
                throw new AccessError(422, "query_invalid", `Unknown query parameter: ${unknownDupParam}`);
              body = await crm.listContactDuplicates(req.query);
            } else if (resource === "contact-merges" && id && !action) {
              if (
                req.body !== undefined ||
                req.headers["transfer-encoding"] !== undefined ||
                Number(req.headers["content-length"] || 0) > 0
              )
                throw new AccessError(422, "body_not_allowed", "This read accepts no request body.");
              body = await crm.getContactMerge(id);
            } else if (resource === "leads" && id && action === "activity") {
              if (req.body !== undefined || Number(req.headers["content-length"] || 0) > 0)
                throw new AccessError(422, "body_not_allowed", "This read accepts no request body.");
              body = await crm.activity(id);
            } else if (resource === "leads" && id && action === "notes" && req.method === "GET") {
              if (req.body !== undefined || Number(req.headers["content-length"] || 0) > 0)
                throw new AccessError(422, "body_not_allowed", "This read accepts no request body.");
              body = await crm.notes(id);
            } else if (!action)
              body = id ? await crm.detail(resource, id) : await crm.list(resource, req.query);
            else throw new AccessError(404, "route_unavailable", "Route unavailable.");
            const version = (body as { version?: number }).version;
            response = {
              body,
              status: Number(successEntry?.[0] ?? 200),
              etag: version ? `"${version}"` : undefined,
            };
          } else if (["contacts", "leads"].includes(resource) && req.method === "POST" && !id && !action) {
            if (Object.keys(req.query).length)
              throw new AccessError(422, "query_invalid", "This command has no query parameters.");
            response = await crm[resource === "contacts" ? "postContact" : "postLead"](
              req.body,
              req.headers["idempotency-key"] as string | undefined,
              `${req.method} ${req.path}`,
              revision(req),
            );
          } else if (resource === "tasks" && req.method === "POST" && !id && !action) {
            if (Object.keys(req.query).length)
              throw new AccessError(422, "query_invalid", "This command has no query parameters.");
            response = await crm.postTask(
              req.body,
              req.headers["idempotency-key"] as string | undefined,
              `${req.method} ${req.path}`,
            );
          } else if (resource === "tasks" && req.method === "PATCH" && id && !action) {
            if (Object.keys(req.query).length)
              throw new AccessError(422, "query_invalid", "This command has no query parameters.");
            response = await crm.patchTask(
              id,
              req.body,
              revision(req),
              req.headers["idempotency-key"] as string | undefined,
              `${req.method} ${req.path}`,
            );
          } else if (resource === "contacts" && req.method === "PATCH" && id && !action) {
            if (Object.keys(req.query).length)
              throw new AccessError(422, "query_invalid", "This command has no query parameters.");
            response = await crm.patchContact(
              id,
              req.body,
              revision(req),
              req.headers["idempotency-key"] as string,
              `${req.method} ${req.path}`,
            );
          } else if (resource === "leads" && req.method === "PATCH" && id && !action) {
            if (Object.keys(req.query).length)
              throw new AccessError(422, "query_invalid", "This command has no query parameters.");
            response = await crm.patchLead(
              id,
              req.body,
              revision(req),
              req.headers["idempotency-key"] as string | undefined,
              `${req.method} ${req.path}`,
            );
          } else if (resource === "leads" && req.method === "POST" && id && action === "stage-transitions") {
            if (Object.keys(req.query).length)
              throw new AccessError(422, "query_invalid", "This command has no query parameters.");
            response = await crm.postStageTransition(
              id,
              req.body,
              revision(req),
              req.headers["idempotency-key"] as string | undefined,
              `${req.method} ${req.path}`,
            );
          } else if (
            // ADR-049: merge a source contact into the survivor contact
            resource === "contacts" &&
            req.method === "POST" &&
            id &&
            action === "merges"
          ) {
            if (Object.keys(req.query).length)
              throw new AccessError(422, "query_invalid", "This command has no query parameters.");
            response = await crm.mergeContact(
              id,
              req.body,
              req.headers["idempotency-key"] as string | undefined,
              `${req.method} ${req.path}`,
              req.headers["if-match"] as string | undefined,
              `${req.protocol}://${req.get("host")}`,
            );
          } else if (
            ["contacts", "leads"].includes(resource) &&
            req.method === "POST" &&
            id &&
            action === "archive"
          ) {
            if (Object.keys(req.query).length)
              throw new AccessError(422, "query_invalid", "This command has no query parameters.");
            // ADR-047: the frozen operations declare no If-Match, so a supplied revision is ignored.
            response = await crm[resource === "contacts" ? "archiveContact" : "archiveLead"](
              id,
              req.body,
              req.headers["idempotency-key"] as string | undefined,
              `${req.method} ${req.path}`,
            );
          } else {
            response = await crm.idempotent(
              req.headers["idempotency-key"] as string,
              `${req.method} ${req.path}`,
              req.body ?? null,
              revision(req),
              async () => {
                if (resource === "routing" && req.method === "PUT" && !id)
                  return routing.replace(req.body, revision(req));
                if (
                  resource === "deals" &&
                  !action &&
                  ((req.method === "POST" && !id) || (req.method === "PATCH" && id))
                )
                  return deals.write(req.body, id, revision(req));
                if (
                  ["pipeline-stages", "lead-sources", "tags"].includes(resource) &&
                  !action &&
                  ((req.method === "POST" && !id) || (req.method === "PATCH" && id))
                )
                  return configuration.write(
                    resource as "pipeline-stages" | "lead-sources" | "tags",
                    req.body,
                    id,
                    revision(req),
                  );
                if (req.method === "PUT" && resource === "leads" && id && action === "tags")
                  return configuration.replaceLeadTags(id, req.body, revision(req));
                if (req.method === "POST" && resource === "uploads" && !id) return uploads.grant(req.body);
                if (req.method === "POST" && resource === "imports" && id === "contact-previews")
                  return transfers.preview(req.body);
                if (req.method === "POST" && resource === "imports" && id === "contact-commits")
                  return transfers.commit(req.body);
                if (req.method === "POST" && resource === "exports" && !id) return transfers.export(req.body);
                if (resource === "billing" && req.method === "POST" && id === "change-previews")
                  return billing.preview(req.body, req.headers["idempotency-key"] as string);
                if (resource === "billing" && req.method === "POST" && id === "change-confirmations")
                  return billing.confirm(req.body);
                if (resource === "billing" && req.method === "POST" && id === "customer-portal")
                  return billing.openPortal();
                if (req.method === "POST" && resource === "member-invitations" && !id)
                  return admin.invite(req.body);
                if (req.method === "POST" && resource === "tickets" && !id) return support.create(req.body);
                if (
                  ["roles", "offices", "business-profiles"].includes(resource) &&
                  !action &&
                  ((req.method === "POST" && !id) || (req.method === "PATCH" && id))
                )
                  return admin.write(
                    resource as "roles" | "offices" | "business-profiles",
                    req.body,
                    id,
                    revision(req),
                  );
                if (req.method === "PATCH" && resource === "members" && id && !action)
                  return admin.updateMember(id, req.body, revision(req));
                if (req.method === "POST" && !id) return crm.create(resource, req.body);
                if (req.method === "PATCH" && id && !action)
                  return crm.update(resource, id, req.body, revision(req));
                if (req.method === "POST" && resource === "leads" && id && action === "notes")
                  return (await crm.notes(id, req.body, revision(req))) as {
                    body: unknown;
                    status: number;
                  };
                throw new AccessError(
                  503,
                  "feature_not_implemented",
                  "This operation is not implemented yet.",
                );
              },
              async (cached) => {
                if (resource === "deals") await deals.row((cached as { id: string }).id, true);
                if (resource === "leads" && action === "tags") requirePermission(context, "crm.tags.read");
                if (resource === "exports" && ["leads", "contacts"].includes(req.body.kind)) {
                  requirePermission(context, `crm.${req.body.kind}.read`);
                  await requireEntitlement(client, `crm.${req.body.kind}.read`);
                }
              },
            );
            if (resource === "member-invitations" && req.method === "POST") {
              const token = await admin.invitationTokenForJob((response.body as { id: string }).id);
              if (token) response.syntheticToken = token;
            }
            if (resource === "billing" && id === "change-previews")
              response.termsVersion = await billing.termsVersionForPreview(
                (response.body as { id: string }).id,
              );
            if (resource === "uploads" && req.method === "POST")
              response.body = await uploads.grantForAsset((response.body as { assetId: string }).assetId);
          }
          // Skip response contract check for merge commands: resultUrl is a relative path
          // that fails ajv-formats' strict absolute-URI check; mergeReceipt already validates.
          if (responseSchema && !(resource === "contacts" && action === "merges" && req.method === "POST"))
            validateSchema(schemaName(responseSchema), response.body, true);
          return response;
        },
        { lockOrganization: resource === "members" && req.method !== "GET" },
      );
      if (result.etag) res.setHeader("ETag", result.etag);
      if (result.syntheticToken) res.setHeader("X-Synthetic-Invitation-Token", result.syntheticToken);
      if (result.termsVersion) res.setHeader("X-Billing-Terms-Version", result.termsVersion);
      if (result.routingCanReplace !== undefined)
        res.setHeader("X-Routing-Can-Replace", String(result.routingCanReplace));
      res.status(result.status).json(result.body);
    } catch (error) {
      const body = problem(error, traceId, req.path);
      if (body.status === 429) res.setHeader("Retry-After", "60");
      // Only safe codes and trace references are emitted; no body, cookie or SQL values.
      if (body.status >= 500) console.error(JSON.stringify({ traceId, code: body.code }));
      res.status(body.status).type("application/problem+json").json(body);
    }
  }
}

@Module({ controllers: [ApiController] })
class ApiModule {}

export async function createApplication() {
  await assertRuntimeRole(runtimePool);
  // Staff uses explicit distinct logins. A member-only synthetic server can run without them.
  const staffPools =
    syntheticEnabled && (process.env.CONTROL_DATABASE_URL || process.env.STAFF_ISSUER_DATABASE_URL)
      ? createStaffPools()
      : undefined;
  let staffClosed = false;
  const closeStaff = async () => {
    if (!staffPools || staffClosed) return;
    staffClosed = true;
    await Promise.all([staffPools.control.end(), staffPools.issuer.end()]);
  };
  let staffAdapter: Awaited<ReturnType<typeof createStaffHttpAdapter>> | undefined;
  try {
    if (staffPools)
      staffAdapter = await createStaffHttpAdapter({ ...staffPools, allowedOrigins: [...allowedOrigins] });
  } catch (error) {
    await closeStaff();
    throw error;
  }
  const module = {
    module: ApiModule,
    providers: [
      { provide: "STAFF_DATABASE_LIFECYCLE", useValue: { onApplicationShutdown: closeStaff } },
      {
        provide: "RUNTIME_DATABASE_LIFECYCLE",
        useValue: {
          onApplicationShutdown: async () => {
            try {
              await closeRuntimePool();
            } catch {
              throw new Error("runtime_database_shutdown_failed");
            }
          },
        },
      },
    ],
  };
  const app = await NestFactory.create<NestExpressApplication>(module, {
    logger: ["error", "warn"],
    bodyParser: false,
  });
  // Only module-authored revision ETags are meaningful. Never hash private bodies automatically.
  app.set("etag", false);
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Trace-Id", randomUUID());
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  // This bounded adapter reads raw JSON itself; registration must precede either body parser.
  if (staffAdapter) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const owned =
        req.path === "/dev/staff/session" ||
        req.path === "/dev/staff/logout" ||
        req.path.startsWith("/dev/staff/support/") ||
        req.path === "/v1/platform/organizations" ||
        /^\/v1\/platform\/organizations\/[0-9a-f-]{36}\/access-grants$/.test(req.path) ||
        /^\/dev\/staff\/jobs\/[0-9a-f-]{36}(?:\/run)?$/.test(req.path);
      if (!owned) {
        next();
        return;
      }
      void (async () => {
        if (
          !loopback(req.socket.remoteAddress) ||
          req.headers.forwarded ||
          req.headers["x-forwarded-for"] ||
          req.headers["x-real-ip"]
        )
          throw new AccessError(
            403,
            "synthetic_loopback_required",
            "Synthetic staff access requires direct loopback.",
          );
        const reading = ["GET", "HEAD"].includes(req.method);
        const cookies = (req.headers.cookie ?? "").split(";").map((cookie) => cookie.trim());
        const staffCookies = cookies.filter((cookie) => cookie.startsWith("estate_staff_session="));
        if (staffCookies.length && cookies.some((cookie) => cookie.startsWith("estate_session=")))
          throw new AccessError(
            403,
            "identity_context_ambiguous",
            "Select one identity context before access.",
          );
        if (req.path === "/dev/staff/session" && req.method === "POST")
          rate(loginAttempts, `staff:${req.socket.remoteAddress ?? ""}`, 20);
        else if (staffCookies.length === 1)
          await withStaffTransaction(
            staffPools!.control,
            staffCookies[0].slice("estate_staff_session=".length),
            async (_client, staff) => {
              rate(
                requestRates,
                `staff:${staff.userId}:${reading ? "read" : "mutation"}`,
                reading ? 300 : 120,
              );
            },
            { intent: "identity" },
          );
        else
          rate(
            requestRates,
            `staff-anonymous:${req.socket.remoteAddress}:${reading ? "read" : "mutation"}`,
            reading ? 300 : 120,
          );
        if (!(await staffAdapter!(req, res)))
          throw new AccessError(404, "route_unavailable", "Route unavailable.");
      })().catch((error) => {
        const failure = problem(error, String(res.getHeader("X-Trace-Id")), req.path);
        if (failure.status === 429) res.setHeader("Retry-After", "60");
        res.status(failure.status).type("application/problem+json").json(failure);
      });
    });
  }
  app.useBodyParser("raw", {
    type: (req) => req.method === "PUT" && /^\/dev\/storage\/uploads\/[^/]+$/.test(req.url ?? ""),
    limit: 20 * 1024 * 1024,
    inflate: false,
  });
  app.useBodyParser("json", { limit: 256 * 1024, strict: true, inflate: false });
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    // Parser errors may include the private body. Never forward, log or serialize the error itself.
    const oversized = (error as { status?: number }).status === 413;
    const failure = new AccessError(
      oversized ? 413 : 400,
      oversized ? "request_too_large" : "request_body_invalid",
      oversized ? "Request body exceeds the allowed size." : "Request body is invalid.",
    );
    res
      .status(failure.status)
      .type("application/problem+json")
      .json(problem(failure, String(res.getHeader("X-Trace-Id")), req.path));
  });
  app.use(cookieParser());
  app.enableShutdownHooks();
  try {
    await app.init();
  } catch (error) {
    try {
      await app.close();
    } catch {
      /* The caller reports only a fixed startup code. */
    }
    await closeStaff();
    throw error;
  }
  return app;
}

if (typeof require === "function" && typeof module !== "undefined" && require.main === module) {
  let startingApplication: NestExpressApplication | undefined;
  const supervised = process.connected;
  let closing = false;
  let shutdownRequested = false;
  const shutdown = async () => {
    shutdownRequested = true;
    if (closing || !startingApplication) return;
    closing = true;
    try {
      await startingApplication.close();
    } catch {
      process.exitCode = 1;
    } finally {
      if (process.connected) process.disconnect();
    }
  };
  if (supervised) {
    process.on("message", (message: unknown) => {
      if ((message as { type?: unknown })?.type === "estate-shutdown") void shutdown();
    });
    process.on("disconnect", () => void shutdown());
  }
  createApplication()
    .then(async (app) => {
      startingApplication = app;
      if (shutdownRequested) {
        await shutdown();
        return;
      }
      await app.listen(Number(process.env.API_PORT ?? 3001), process.env.API_HOST ?? "127.0.0.1");
      if (shutdownRequested) {
        await app.close();
        return;
      }
      if (supervised && process.connected) {
        const address = app.getHttpServer().address();
        if (!address || typeof address === "string") throw new Error("api_address_invalid");
        process.send?.({ type: "estate-api-ready", port: address.port });
      }
      console.log(
        JSON.stringify({
          status: "listening",
          identityMode: syntheticEnabled ? "synthetic-loopback" : productionOidc ? "oidc" : "unconfigured",
          mlsMode: "mock",
          deliveryMode: "no-delivery",
        }),
      );
    })
    .catch(async (error) => {
      console.error(
        JSON.stringify({ code: error instanceof RuntimeRoleError ? error.code : "api_startup_failed" }),
      );
      process.exitCode = 1;
      try {
        await startingApplication?.close();
      } catch {
        /* Startup logs contain only fixed codes. */
      }
      try {
        await closeRuntimePool();
      } catch {
        /* Startup logs contain only fixed codes. */
      }
      if (process.connected) process.disconnect();
    });
}
