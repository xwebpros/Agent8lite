import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import contract from "../../../../packages/contracts/openapi.json";
import type { components } from "../../../../packages/contracts/generated/api";
import type {
  IdxTemplateProviderFactory,
  IdxTemplateQuery,
} from "../../../../packages/contracts/internal/idx-template-provider";
import { AccessError, withTenantTransaction } from "../../../../packages/db/tenant-transaction";
import { assertUuid } from "../crm-service";
import { resolveIdxTemplateBinding } from "./repository";
import { IdxTemplateService, type IdxTemplateContentProjector } from "./service";

export type IdxTemplateHttpRequest = {
  method: string;
  url: string;
  headers: Readonly<Record<string, string | undefined>>;
  body?: unknown;
  remoteAddress: string | undefined;
};
export type IdxTemplateHttpResponse = { status: number; body: unknown; headers: Record<string, string> };
export type IdxTemplateHttpOptions = {
  allowedOrigins: ReadonlySet<string>;
  trustedOrigin: (request: IdxTemplateHttpRequest) => string | Promise<string>;
  createProvider: IdxTemplateProviderFactory;
  projectContent: IdxTemplateContentProjector;
  environment?: Readonly<Record<string, string | undefined>>;
};

const queryParameters = contract.paths[
  "/v1/public/sites/{siteId}/idx-template/listings"
].get.parameters.filter((parameter) => parameter.in === "query");
const queryProperties = Object.fromEntries(
  queryParameters.map((parameter) => [parameter.name, parameter.schema]),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateQuery = ajv.compile({
  type: "object",
  additionalProperties: false,
  properties: queryProperties,
});

function parseQuery(url: URL): IdxTemplateQuery {
  const query: Record<string, unknown> = {};
  for (const [key, raw] of url.searchParams) {
    if (Object.hasOwn(query, key))
      throw new AccessError(422, "query_invalid", "Repeated search parameters are unavailable.");
    const schema = (queryProperties as Record<string, { type: string }>)[key];
    if (!schema) throw new AccessError(422, "query_invalid", "Unsupported search parameter.");
    if (schema.type === "boolean") {
      if (raw !== "true" && raw !== "false")
        throw new AccessError(422, "query_invalid", "Search flags must be true or false.");
      query[key] = raw === "true";
    } else if (schema.type === "number" || schema.type === "integer") {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw))
        throw new AccessError(422, "query_invalid", "Search numbers must be finite decimal values.");
      query[key] = Number(raw);
    } else query[key] = raw;
  }
  if (!validateQuery(query))
    throw new AccessError(422, "query_invalid", "Search parameters exceed the published bounds.");
  for (const [minimum, maximum] of [
    ["minPrice", "maxPrice"],
    ["minSqft", "maxSqft"],
    ["minYearBuilt", "maxYearBuilt"],
    ["minLatitude", "maxLatitude"],
    ["minLongitude", "maxLongitude"],
  ]) {
    if (
      query[minimum] !== undefined &&
      query[maximum] !== undefined &&
      Number(query[minimum]) > Number(query[maximum])
    )
      throw new AccessError(422, "query_invalid", "The search minimum exceeds its maximum.");
  }
  return query as IdxTemplateQuery;
}

/** Public bridge only; no member cookie, arbitrary Host header or Owner selection. */
export class IdxTemplateHttpAdapter {
  constructor(
    private readonly pool: Pool,
    private readonly options: IdxTemplateHttpOptions,
  ) {}

  async handle(request: IdxTemplateHttpRequest): Promise<IdxTemplateHttpResponse> {
    const traceId = randomUUID();
    const headers = {
      "cache-control": "private, no-store",
      "x-trace-id": traceId,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-type": "application/json",
    };
    try {
      const origin = await this.options.trustedOrigin(request);
      if (!this.options.allowedOrigins.has(origin))
        throw new AccessError(403, "idx_origin_denied", "This template origin is not configured.");
      const normalized = new URL(origin);
      if (
        normalized.origin !== origin ||
        normalized.username ||
        normalized.password ||
        normalized.pathname !== "/" ||
        normalized.search ||
        normalized.hash
      )
        throw new AccessError(403, "idx_origin_denied", "This template origin is not configured.");
      const url = new URL(request.url, "http://idx-private.invalid");
      const matched =
        /^\/v1\/public\/sites\/([^/]+)\/idx-template\/(content|status|listings|inquiries)(?:\/([^/]+))?$/.exec(
          url.pathname,
        );
      if (!matched) throw new AccessError(404, "route_unavailable", "Route unavailable.");
      const [, siteId, resource, key] = matched;
      assertUuid(siteId);
      const method = request.method.toUpperCase();
      if (method !== "GET" && !(method === "POST" && resource === "inquiries" && !key))
        throw new AccessError(404, "route_unavailable", "Route unavailable.");
      if (method === "GET" && (resource === "inquiries" || (key && resource !== "listings")))
        throw new AccessError(404, "route_unavailable", "Route unavailable.");
      if (method === "GET" && request.body !== undefined)
        throw new AccessError(422, "body_not_allowed", "This read accepts no request body.");
      if (resource !== "listings" || key)
        if (url.search)
          throw new AccessError(422, "query_invalid", "This operation has no query parameters.");
      let listingKey: string | undefined;
      if (key) {
        try {
          listingKey = decodeURIComponent(key);
        } catch {
          throw new AccessError(422, "listing_key_invalid", "Listing key is invalid.");
        }
        if (!listingKey || listingKey.length > 200 || /[\u0000-\u001f\u007f]/.test(listingKey))
          throw new AccessError(422, "listing_key_invalid", "Listing key is invalid.");
      }
      const submissionKey = request.headers["idempotency-key"];
      if (method === "POST") {
        if (!submissionKey)
          throw new AccessError(400, "idempotency_required", "A UUID Idempotency-Key is required.");
        assertUuid(submissionKey);
        if (request.headers.origin && request.headers.origin !== origin)
          throw new AccessError(403, "origin_denied", "Request origin is not allowed.");
      }
      const query = resource === "listings" && !key ? parseQuery(url) : {};
      const resolved = await resolveIdxTemplateBinding(this.pool, siteId, origin);
      const body = await withTenantTransaction(
        this.pool,
        { userId: resolved.capture_user_id, organizationId: resolved.tenant_id },
        async (client, context) => {
          const service = new IdxTemplateService(client, context, traceId, {
            origin,
            siteId,
            bindingId: resolved.binding_id,
            expectedBindingVersion: resolved.binding_version.toString(),
            createProvider: this.options.createProvider,
            projectContent: this.options.projectContent,
            environment: this.options.environment,
          });
          if (resource === "content") return service.content();
          if (resource === "status") return service.status();
          if (resource === "listings") return listingKey ? service.detail(listingKey) : service.search(query);
          return service.submit(
            request.body as components["schemas"]["IdxTemplateInquiryWrite"],
            submissionKey!,
          );
        },
      );
      return { status: 200, body, headers };
    } catch (error) {
      const failure =
        error instanceof AccessError
          ? error
          : new AccessError(
              503,
              "idx_service_unavailable",
              "The template service is temporarily unavailable.",
            );
      return {
        status: failure.status,
        headers: {
          ...headers,
          "content-type": "application/problem+json",
          ...(failure.status === 429 ? { "retry-after": "60" } : {}),
        },
        body: {
          type: "about:blank",
          title: failure.status === 503 ? "Service unavailable" : "Request rejected",
          status: failure.status,
          detail: failure.message,
          code: failure.code,
          traceId,
        },
      };
    }
  }
}
