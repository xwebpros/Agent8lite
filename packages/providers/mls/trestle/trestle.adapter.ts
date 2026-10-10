import { randomUUID } from "node:crypto";
import type {
  CanonicalListing,
  Capabilities,
  FeedContext,
  ListingCriteria,
  LiveQueryAdapter,
  SearchPage,
} from "../port";
import { authorizeFeed, digest, instant, TrestleError } from "./safety";
import { TrestleClient } from "./trestle.client";
import { mapTrestleListing, matchesTrestleCriteria, selectedFields } from "./trestle.mapper";
import { continuation, propertyQuery } from "./trestle.query";
import type { TrestleAdapterOptions, TrestleFeedAuthorization } from "./types";

const providerFailures = new Set([
  "TRESTLE_QUOTA_EXCEEDED",
  "TRESTLE_AUTH_DENIED",
  "TRESTLE_UPSTREAM_ERROR",
  "TRESTLE_BAD_RESPONSE",
  "TRESTLE_RESPONSE_TOO_LARGE",
  "TRESTLE_REQUEST_TIMEOUT",
  "TRESTLE_TRANSPORT_ERROR",
  "TRESTLE_BAD_TOKEN_RESPONSE",
  "TRESTLE_BAD_METADATA_RESPONSE",
  "TRESTLE_BAD_PROPERTY_RESPONSE",
  "TRESTLE_PAGE_BOUND_EXCEEDED",
  "TRESTLE_DUPLICATE_SOURCE_RECORD",
  "TRESTLE_SOURCE_SCOPE_DENIED",
  "TRESTLE_UNTRUSTED_SOURCE_RECORD",
  "TRESTLE_CONTINUATION_DENIED",
  "TRESTLE_DETAIL_NOT_UNIQUE",
  "TRESTLE_CREDENTIAL_NOT_READY",
  "TRESTLE_OPERATION_FAILED",
]);

/** Unregistered live-query seam. Default application configuration remains mock. */
export class TrestleAdapter implements LiveQueryAdapter {
  readonly providerCode = "trestle";
  readonly mode = "live_query" as const;
  #client: TrestleClient;
  #options: TrestleAdapterOptions;
  #now: () => Date;
  #lastSuccessAt: string | null = null;
  #lastSuccessBinding: string | null = null;
  #lastFailureBinding: string | null = null;
  #cursors = new Map<string, { url: string; binding: string; expiresAt: number }>();

  constructor(options: TrestleAdapterOptions) {
    this.#options = { ...options, endpoints: { ...options.endpoints } };
    this.#now = options.now ?? (() => new Date());
    this.#client = new TrestleClient(options.endpoints, options.credentials, options.fetch, this.#now);
  }

  async #authorized(context: FeedContext, display: boolean): Promise<TrestleFeedAuthorization> {
    if (!this.#options.enabled) throw new TrestleError("TRESTLE_NOT_ENABLED");
    try {
      return authorizeFeed(context, await this.#options.authorization.current(context), display);
    } catch (error) {
      this.#client.invalidate();
      this.#cursors.clear();
      this.#lastSuccessAt = null;
      this.#lastSuccessBinding = null;
      this.#lastFailureBinding = null;
      if (error instanceof TrestleError) throw error;
      throw new TrestleError("TRESTLE_FEED_NOT_AUTHORIZED");
    }
  }

  async #run<T>(
    context: FeedContext,
    display: boolean,
    work: (authorization: TrestleFeedAuthorization, guard: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const authorization = await this.#authorized(context, display);
    const fingerprint = digest(authorization);
    const guard = async () => {
      if (digest(await this.#authorized(context, display)) !== fingerprint) {
        this.#client.invalidate();
        this.#cursors.clear();
        this.#lastSuccessAt = null;
        this.#lastSuccessBinding = null;
        this.#lastFailureBinding = null;
        throw new TrestleError("TRESTLE_AUTHORIZATION_CHANGED");
      }
    };
    try {
      const result = await work(authorization, guard);
      await guard();
      if (display) this.#lastFailureBinding = null;
      return result;
    } catch (error) {
      if (!(error instanceof TrestleError) || providerFailures.has(error.code))
        this.#lastFailureBinding = digest([context, authorization]);
      if (error instanceof TrestleError) throw error;
      throw new TrestleError("TRESTLE_OPERATION_FAILED");
    }
  }

  async readMetadata(context: FeedContext): Promise<string> {
    context = structuredClone(context);
    return this.#run(context, false, async (_authorization, guard) => {
      const xml = await this.#client.get(
        context,
        new URL("$metadata", this.#client.endpoints.odataBaseUrl).href,
        true,
        guard,
      );
      if (!/^\s*(?:<\?xml[^>]*>\s*)?<([A-Za-z_][\w.-]*:)?Edmx\b/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml))
        throw new TrestleError("TRESTLE_BAD_METADATA_RESPONSE");
      return xml; // Opaque server XML; no parser, browser rendering, persistence or logs.
    });
  }

  async capabilities(context: FeedContext): Promise<Capabilities> {
    context = structuredClone(context);
    const authorization = await this.#authorized(context, true);
    const fields = selectedFields(authorization);
    return {
      mode: this.mode,
      reso: null,
      supports: {
        search: true,
        maps:
          ["exact", "listing_specific"].includes(authorization.policy.locationRule) &&
          ["visible", "listing_specific"].includes(authorization.policy.addressRule) &&
          ["Longitude", "Latitude", "UnparsedAddress"].every((field) => fields.includes(field)),
        incremental: false,
        deletions: false,
        savedSearches: false,
        alerts: false,
        openHouses: false,
        inquiryWebhook: false,
      },
      media: "none",
      rate: { requestsPerMinute: null, maxPageSize: this.#client.endpoints.pageSize },
    };
  }

  async health(context: FeedContext) {
    context = structuredClone(context);
    try {
      const authorization = await this.#authorized(context, true);
      const binding = digest([context, authorization]);
      const current = this.#lastSuccessBinding === binding;
      const now = this.#now().getTime();
      const success = this.#lastSuccessAt ? instant(this.#lastSuccessAt) : Number.NaN;
      if (!Number.isFinite(now) || !Number.isFinite(success) || success > now)
        return { state: "unavailable" as const, lastSuccessAt: null };
      const fresh = now - success < authorization.policy.maxDataAgeSeconds! * 1000;
      return {
        state:
          current && fresh
            ? this.#lastFailureBinding === binding
              ? ("degraded" as const)
              : ("ready" as const)
            : ("unavailable" as const),
        lastSuccessAt: current ? this.#lastSuccessAt : null,
      };
    } catch {
      return { state: "unavailable" as const, lastSuccessAt: null };
    }
  }

  async #properties(
    context: FeedContext,
    url: URL,
    authorization: TrestleFeedAuthorization,
    guard: () => Promise<void>,
    maximum: number,
  ) {
    const text = await this.#client.get(context, url.href, false, guard);
    await guard();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TrestleError("TRESTLE_BAD_PROPERTY_RESPONSE");
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !Array.isArray((body as Record<string, unknown>).value)
    )
      throw new TrestleError("TRESTLE_BAD_PROPERTY_RESPONSE");
    const envelope = body as { value: unknown[]; "@odata.nextLink"?: unknown };
    if (envelope.value.length > maximum) throw new TrestleError("TRESTLE_PAGE_BOUND_EXCEEDED");
    const now = this.#now();
    const items = envelope.value
      .map((row) => mapTrestleListing(row, authorization, now))
      .filter((item): item is CanonicalListing => item !== null);
    if (new Set(items.map((item) => item.sourceListingKey)).size !== items.length)
      throw new TrestleError("TRESTLE_DUPLICATE_SOURCE_RECORD");
    return { items, next: continuation(envelope["@odata.nextLink"], url), asOf: now.toISOString() };
  }

  async search(
    context: FeedContext,
    input: ListingCriteria,
    cursor: string | null = null,
  ): Promise<SearchPage> {
    context = structuredClone(context);
    const criteria = structuredClone(input);
    return this.#run(context, true, async (authorization, guard) => {
      const query = propertyQuery(
        this.#client.endpoints.odataBaseUrl,
        context,
        criteria,
        authorization,
        this.#client.endpoints.pageSize,
      );
      const binding = digest([context, authorization, query.href]);
      for (const [key, entry] of this.#cursors)
        if (entry.expiresAt <= this.#now().getTime()) this.#cursors.delete(key);
      let url = query;
      if (cursor !== null) {
        const entry = this.#cursors.get(cursor);
        if (!entry || entry.binding !== binding) throw new TrestleError("TRESTLE_CURSOR_DENIED");
        url = new URL(entry.url);
      }
      const page = await this.#properties(
        context,
        url,
        authorization,
        guard,
        this.#client.endpoints.pageSize,
      );
      const items = page.items.filter((item) => matchesTrestleCriteria(item, criteria));
      let nextOpaqueCursor: string | null = null;
      if (page.next) {
        if (this.#cursors.size >= 200) throw new TrestleError("TRESTLE_CURSOR_CAPACITY_EXCEEDED");
        nextOpaqueCursor = randomUUID();
        this.#cursors.set(nextOpaqueCursor, {
          url: page.next.href,
          binding,
          expiresAt: this.#now().getTime() + 240000,
        });
      }
      this.#lastSuccessAt = page.asOf;
      this.#lastSuccessBinding = digest([context, authorization]);
      return { items, nextOpaqueCursor, asOf: page.asOf };
    });
  }

  async getListing(context: FeedContext, sourceListingKey: string): Promise<CanonicalListing | null> {
    context = structuredClone(context);
    return this.#run(context, true, async (authorization, guard) => {
      const query = propertyQuery(
        this.#client.endpoints.odataBaseUrl,
        context,
        {},
        authorization,
        this.#client.endpoints.pageSize,
        sourceListingKey,
      );
      const page = await this.#properties(context, query, authorization, guard, 2);
      if (
        page.next ||
        page.items.length > 1 ||
        page.items.some((item) => item.sourceListingKey !== sourceListingKey)
      )
        throw new TrestleError("TRESTLE_DETAIL_NOT_UNIQUE");
      this.#lastSuccessAt = page.asOf;
      this.#lastSuccessBinding = digest([context, authorization]);
      return page.items[0] ?? null;
    });
  }
}
