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
  createSyntheticSession,
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
import { createCmsProfileReferencePort } from "./admin-profile-reference";
import { createStaffPools } from "../../../packages/db/staff-pools";
import { createStaffHttpAdapter } from "./control/http-adapter";
import { withStaffTransaction } from "../../../packages/auth/staff-sessions";
import { CampaignDraftService, campaignEtag } from "./marketing";
import { CampaignWorkflowService, WorkflowCommandError } from "./marketing/workflow-service";
import { MessageDesignDraftService } from "./marketing/message-design-service";
import { MessageDesignCommandError } from "./marketing/message-design-errors";
import { messageDesignEtag } from "./marketing/message-design-model";

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
    res.setHeader("X-Synthetic-Identity", "true");
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
          identityMode: syntheticEnabled ? "synthetic-loopback" : "unconfigured",
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
        rate(loginAttempts, req.socket.remoteAddress ?? "", 20);
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
        const verified = oidc!.verifyIdentityToken(token.idToken, {
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
      if (!syntheticEnabled)
        throw new AccessError(
          401,
          "identity_provider_unconfigured",
          "An approved identity provider is required.",
        );
      const session = await readSession(runtimePool, req.cookies?.[sessionCookie]);
      localAccess(req);
      const reading = ["GET", "HEAD"].includes(req.method);
      rate(requestRates, `${session.userId}:${reading ? "read" : "mutation"}`, reading ? 300 : 120);
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
      if (req.path === "/dev/logout" && req.method === "POST") {
        localIdentity(req);
        await revokeSession(runtimePool, session);
        res.clearCookie(sessionCookie, { path: "/" });
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
        /^\/v1\/orgs\/[^/]+\/(?:sites|documents|revisions)(?:\/|$)/.test(req.path) ||
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
      const match = req.path.match(/^\/v1\/orgs\/([^/]+)\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
      if (!match) throw new AccessError(404, "route_unavailable", "Route unavailable.");
      const [, org, resource, id, action] = match;
      assertUuid(org);
      if (org !== session.organizationId)
        throw new AccessError(
          403,
          "active_organization_mismatch",
          "Select this organization before accessing its records.",
        );
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
            } else throw new AccessError(404, "route_unavailable", "Route unavailable.");
            if (responseSchema) validateSchema(schemaName(responseSchema), response.body, true);
            return response;
          }
          if (resource === "campaigns") {
            localAccess(req);
            if (action) throw new AccessError(404, "route_unavailable", "Route unavailable.");
            const campaigns = new CampaignDraftService(client, context, traceId);
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
            else if (["offices", "business-profiles"].includes(resource) && !action)
              body = id
                ? await admin.get(resource as "offices" | "business-profiles", id)
                : await admin.list(resource as "offices" | "business-profiles", req.query);
            else if (resource === "leads" && id && action === "notes") body = await crm.notes(id);
            else if (resource === "leads" && id && action === "activity") body = await crm.activity(id);
            else if (!action)
              body = id ? await crm.detail(resource, id) : await crm.list(resource, req.query);
            else throw new AccessError(404, "route_unavailable", "Route unavailable.");
            const version = (body as { version?: number }).version;
            response = {
              body,
              status: Number(successEntry?.[0] ?? 200),
              etag: version ? `"${version}"` : undefined,
            };
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
                if (req.method === "POST" && !id) return crm.create(resource, req.body);
                if (req.method === "PATCH" && id && !action)
                  return crm.update(resource, id, req.body, revision(req));
                if (req.method === "POST" && resource === "leads" && id && action === "stage-transitions")
                  return crm.transition(id, req.body, revision(req));
                if (req.method === "POST" && resource === "leads" && id && action === "notes")
                  return (await crm.notes(id, req.body, revision(req))) as { body: unknown; status: number };
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
          if (responseSchema) validateSchema(schemaName(responseSchema), response.body, true);
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
          identityMode: syntheticEnabled ? "synthetic-loopback" : "unconfigured",
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
