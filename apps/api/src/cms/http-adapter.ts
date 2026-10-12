import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CmsProfileReferencePort } from "../../../../packages/cms/ports";
import { DraftConflictError, TemplateUnavailableError } from "../../../../packages/cms";
import { RecoveryEnvelopeError } from "../../../../packages/cms/recovery";
import { HistoryEnvelopeError } from "../../../../packages/cms/history";
import type { components } from "../../../../packages/contracts/generated/api";
import { readSession, sessionCookie, verifyCsrf } from "../../../../packages/auth/sessions";
import {
  AccessError,
  type TenantContext,
  withTenantTransaction,
} from "../../../../packages/db/tenant-transaction";
import { ContentValidationError, type PublishPolicy } from "../../../../packages/templates/registry";
import { validateSchema } from "../contract-validation";
import { CmsService } from "./service";

type Schemas = components["schemas"];
export type CmsHttpRequest = {
  method: string;
  url: string;
  headers: Readonly<Record<string, string | undefined>>;
  body?: unknown;
  remoteAddress: string | undefined;
};
export type CmsHttpResponse = { status: number; body: unknown; headers: Record<string, string> };

function failure(error: unknown): AccessError {
  if (error instanceof AccessError) return error;
  if (error instanceof DraftConflictError || error instanceof TemplateUnavailableError)
    return new AccessError(error.status, error.code, error.message);
  if (error instanceof ContentValidationError)
    return new AccessError(422, "draft_invalid", "The draft contains unsupported or unsafe content.");
  if (error instanceof RecoveryEnvelopeError)
    return new AccessError(422, "revision_recovery_unavailable", error.message);
  if (error instanceof HistoryEnvelopeError)
    return new AccessError(503, "revision_history_unavailable", error.message);
  const code = (error as { code?: string })?.code;
  if (code && ["23505", "40001", "40P01"].includes(code))
    return new AccessError(409, "command_conflict", "A conflicting operation occurred. Reload and retry.");
  if (code && ["23503", "23514", "22P02"].includes(code))
    return new AccessError(422, "business_validation_failed", "Referenced data or values are invalid.");
  return new AccessError(503, "service_unavailable", "The operation could not be completed.");
}

/**
 * Unregistered synthetic adapter for integration testing/shared-owner wiring review.
 * No Nest controller/module decorator, application registration, or listener is supplied here.
 * Production/frozen saveRevision activation is deliberately unavailable.
 */
export class CmsHttpAdapter {
  constructor(
    private readonly pool: Pool,
    private readonly dependencies: {
      profiles: (client: PoolClient, context: TenantContext) => CmsProfileReferencePort;
      trustedLinkPolicy: PublishPolicy;
      allowedOrigins: ReadonlySet<string>;
    },
  ) {}

  async handle(request: CmsHttpRequest): Promise<CmsHttpResponse> {
    const traceId = randomUUID();
    const headers: Record<string, string> = {
      "cache-control": "private, no-store",
      "x-trace-id": traceId,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-type": "application/json",
    };
    try {
      if (
        !["development", "test"].includes(process.env.APP_ENV ?? "") ||
        process.env.DEV_AUTH_ENABLED !== "true"
      )
        throw new AccessError(404, "cms_adapter_unregistered", "CMS adapter is not registered.");
      const forwarded = request.headers["x-forwarded-for"];
      const loopback = (value: string | undefined) =>
        !!value && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(value);
      if (
        !loopback(request.remoteAddress) ||
        (forwarded && forwarded.split(",").some((address) => !loopback(address.trim())))
      )
        throw new AccessError(403, "loopback_required", "Synthetic CMS access is loopback only.");
      const cookie = request.headers.cookie ?? "";
      const matches = cookie
        .split(";")
        .map((value) => value.trim())
        .filter((value) => value.startsWith(`${sessionCookie}=`));
      const session = await readSession(
        this.pool,
        matches.length === 1 ? matches[0].slice(sessionCookie.length + 1) : undefined,
      );
      const method = request.method.toUpperCase();
      if (method !== "GET") {
        if (!request.headers.origin || !this.dependencies.allowedOrigins.has(request.headers.origin))
          throw new AccessError(403, "origin_denied", "Request origin is not allowed.");
        verifyCsrf(session, request.headers["x-csrf-token"]);
      }
      const url = new URL(request.url, "http://cms-unregistered.invalid");
      const org = /^\/(?:v1\/orgs|dev\/orgs)\/([^/]+)\//.exec(url.pathname)?.[1];
      if (org && org !== session.organizationId)
        throw new AccessError(
          403,
          "organization_mismatch",
          "Select the organization before accessing its resources.",
        );
      const query: Record<string, string> = Object.create(null);
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(query, key))
          throw new AccessError(422, "query_invalid", "Repeated pagination query.");
        query[key] = value;
      }
      const commandHeaders = {
        key: request.headers["idempotency-key"],
        ifMatch: request.headers["if-match"],
      };
      const result = await withTenantTransaction(this.pool, session, async (client, context) => {
        const service = new CmsService(client, context, traceId, {
          profiles: this.dependencies.profiles(client, context),
          trustedLinkPolicy: this.dependencies.trustedLinkPolicy,
        });
        const path = url.pathname;
        const prefix = `/v1/orgs/${context.organizationId}`;
        if (path === "/v1/templates" && method === "GET")
          return { body: await service.listTemplates(query), status: 200 };
        if (path === `${prefix}/sites`) {
          if (method === "GET") return { body: await service.listSites(query), status: 200 };
          if (method === "POST")
            return service.createSite(request.body as Schemas["SiteWrite"], commandHeaders);
        }
        const site = new RegExp(`^${prefix}/sites/([^/]+)$`).exec(path);
        if (site && method === "GET") {
          const body = await service.getSite(site[1]);
          return { body, status: 200, etag: `"${body.version}"` };
        }
        const documents = new RegExp(`^${prefix}/sites/([^/]+)/documents$`).exec(path);
        if (documents) {
          if (method === "GET")
            return { body: await service.listDocuments(documents[1], query), status: 200 };
          if (method === "POST")
            return service.createDocument(
              documents[1],
              request.body as Schemas["DocumentWrite"],
              commandHeaders,
            );
        }
        const document = new RegExp(`^${prefix}/documents/([^/]+)$`).exec(path);
        if (document) {
          if (method === "GET") {
            const body = await service.getDocument(document[1]);
            return { body, status: 200, etag: `"${body.version}"` };
          }
          if (method === "PATCH")
            return service.updateDocument(
              document[1],
              request.body as Schemas["DocumentWrite"],
              commandHeaders,
            );
        }
        const history = new RegExp(
          `^/dev/orgs/${context.organizationId}/cms/documents/([^/]+)/revision-history$`,
        ).exec(path);
        if (history && method === "GET")
          return { body: await service.listRevisionHistory(history[1], query), status: 200 };
        const recovery = new RegExp(
          `^/dev/orgs/${context.organizationId}/cms/documents/([^/]+)/revisions/([^/]+)/recovery$`,
        ).exec(path);
        if (recovery && method === "GET") {
          if (Object.keys(query).length)
            throw new AccessError(422, "query_invalid", "Recovery reads do not accept query parameters.");
          return { body: await service.getRevisionRecovery(recovery[1], recovery[2]), status: 200 };
        }
        const draft = new RegExp(`^/dev/orgs/${context.organizationId}/cms/documents/([^/]+)/drafts$`).exec(
          path,
        );
        if (draft && method === "POST")
          return service.saveDraft(draft[1], request.body as Schemas["RevisionWrite"], commandHeaders);
        const revisions = new RegExp(`^${prefix}/documents/([^/]+)/revisions$`).exec(path);
        if (revisions && method === "GET")
          return { body: await service.listRevisions(revisions[1], query), status: 200 };
        const revision = new RegExp(`^${prefix}/revisions/([^/]+)$`).exec(path);
        if (revision && method === "GET")
          return { body: await service.getRevision(revision[1]), status: 200 };

        // ADR-053: domain management
        const siteDomains = new RegExp(`^${prefix}/sites/([^/]+)/domains$`).exec(path);
        if (siteDomains) {
          if (method === "GET") return { body: await service.listDomains(siteDomains[1]), status: 200 };
          if (method === "POST")
            return service.createDomain(
              siteDomains[1],
              request.body as Schemas["DomainWrite"],
              commandHeaders,
            );
        }
        const siteArchive = new RegExp(`^${prefix}/sites/([^/]+)/archive$`).exec(path);
        if (siteArchive && method === "POST") return service.archiveSite(siteArchive[1]);
        const domainVerify = new RegExp(`^${prefix}/domains/([^/]+)/verify$`).exec(path);
        if (domainVerify && method === "POST") return service.verifyDomain(domainVerify[1]);
        const domainArchive = new RegExp(`^${prefix}/domains/([^/]+)/archive$`).exec(path);
        if (domainArchive && method === "POST") return service.archiveDomain(domainArchive[1]);

        // ADR-053: media management
        if (path === `${prefix}/media`) {
          if (method === "GET") return { body: await service.listMedia(query), status: 200 };
        }
        if (path === `${prefix}/media/finalize` && method === "POST")
          return service.finalizeMedia(request.body as Schemas["MediaFinalize"], commandHeaders);

        // ADR-053: form management
        const siteForms = new RegExp(`^${prefix}/sites/([^/]+)/forms$`).exec(path);
        if (siteForms) {
          if (method === "GET") return { body: await service.listForms(siteForms[1], query), status: 200 };
          if (method === "POST")
            return service.createForm(siteForms[1], request.body as Schemas["FormWrite"], commandHeaders);
        }
        const formById = new RegExp(`^${prefix}/forms/([^/]+)$`).exec(path);
        if (formById && method === "GET") return { body: await service.getForm(formById[1]), status: 200 };
        const formVersions = new RegExp(`^${prefix}/forms/([^/]+)/versions$`).exec(path);
        if (formVersions && method === "POST")
          return service.publishFormVersion(
            formVersions[1],
            request.body as Schemas["FormWrite"],
            commandHeaders,
          );

        // ADR-055: document publication
        const docPublish = new RegExp(`^${prefix}/documents/([^/]+)/publish$`).exec(path);
        if (docPublish && method === "POST")
          return service.publishDocument(
            docPublish[1],
            request.body as Schemas["PublishRequest"],
            commandHeaders,
          );

        const docRollback = new RegExp(`^${prefix}/documents/([^/]+)/rollback$`).exec(path);
        if (docRollback && method === "POST")
          return service.rollbackDocument(
            docRollback[1],
            request.body as Schemas["PublishRequest"],
            commandHeaders,
          );

        // ADR-057: document archive and site update
        const docArchive = new RegExp(`^${prefix}/documents/([^/]+)/archive$`).exec(path);
        if (docArchive && method === "POST")
          return service.archiveDocument(docArchive[1], commandHeaders);

        const siteById = new RegExp(`^${prefix}/sites/([^/]+)$`).exec(path);
        if (siteById && method === "PATCH")
          return service.updateSite(siteById[1], request.body as Schemas["SiteWrite"], commandHeaders);

        // frozen saveRevision POST remains unavailable
        throw new AccessError(404, "route_unavailable", "Route unavailable.");
      });
      if ("etag" in result && result.etag) headers.etag = result.etag;
      return { body: result.body, status: result.status, headers };
    } catch (error) {
      const safe = failure(error);
      const body = {
        type: `https://estate.example/problems/${safe.code}`,
        title: safe.message,
        status: safe.status,
        code: safe.code,
        traceId,
      };
      validateSchema("Problem", body, true);
      headers["content-type"] = "application/problem+json";
      return { status: safe.status, body, headers };
    }
  }
}
