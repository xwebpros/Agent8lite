import { describe, expect, it, vi } from "vitest";
import type { FeedContext } from "../port";
import { endpointConfig, instant } from "./safety";
import { TrestleAdapter } from "./trestle.adapter";
import { EnvironmentTrestleCredentials } from "./trestle.client";
import { CONTROL_FIELDS, FIELD_GROUPS, mapTrestleListing } from "./trestle.mapper";
import { continuation, propertyQuery } from "./trestle.query";
import type { TrestleFeedAuthorization } from "./types";

const context: FeedContext = {
  organizationId: "fixture-org",
  feedId: "fixture-feed",
  policyVersion: "fixture-policy",
};
const endpoints = {
  tokenUrl: "https://api.cotality.com/trestle/oidc/connect/token",
  odataBaseUrl: "https://api.cotality.com/trestle/odata/",
  pageSize: 20,
  timeoutMs: 100,
};
function authorization(): TrestleFeedAuthorization {
  return {
    ...context,
    revision: "1",
    connectionState: "approved",
    brokerAuthorization: "approved",
    originatingSystemIds: ["fixture-mls"],
    observedPropertyFields: [...CONTROL_FIELDS, ...Object.values(FIELD_GROUPS).flat()],
    policy: {
      approvalState: "approved",
      rights: {
        display: "allowed",
        replicate: "unknown",
        cache: "unknown",
        storeMedia: "unknown",
        alerts: "unknown",
        aiUse: "unknown",
      },
      allowedFields: ["status", ...Object.keys(FIELD_GROUPS)],
      addressRule: "listing_specific",
      locationRule: "listing_specific",
      maxDataAgeSeconds: 300,
      maxCacheAgeSeconds: null,
      retentionDays: null,
      attributionText: "Fixture attribution",
      attributionLogoAssetId: null,
      disclaimerVersion: "1",
    },
  };
}
function row(overrides: Record<string, unknown> = {}) {
  return {
    ListingKey: "fixture-listing",
    OriginatingSystemID: "fixture-mls",
    StandardStatus: "Active",
    ModificationTimestamp: "2026-10-09T00:00:00Z",
    InternetEntireListingDisplayYN: true,
    InternetAddressDisplayYN: true,
    ListPrice: 500000,
    BedroomsTotal: 3,
    BathroomsTotalInteger: 2,
    LivingArea: 1500,
    LivingAreaUnits: "SquareFeet",
    UnparsedAddress: "Fixture address",
    Longitude: -80,
    Latitude: 30,
    PublicRemarks: "Fixture description",
    PropertyType: "Residential",
    ListOfficeName: "Fixture brokerage",
    ListAgentFullName: "Fixture agent",
    AttributionContact: "702-555-0100",
    PrivateRemarks: "must never escape",
    ...overrides,
  };
}
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);
function harness(enabled = true) {
  const state = {
    authorization: authorization(),
    now: new Date("2026-10-10T00:00:00Z"),
    credential: {
      clientId: "fixture-id+&",
      clientSecret: "fixture-secret+&=",
      version: "1",
      expiresAt: "2027-01-01T00:00:00Z",
    },
    respond: (_url: URL, _init?: RequestInit): Promise<Response> | Response => json({ value: [row()] }),
  };
  const credentials = vi.fn();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/token"))
      return json({ access_token: "fixture-token", token_type: "Bearer", expires_in: 120 });
    if (url.pathname.endsWith("/$metadata"))
      return new Response(
        '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"></edmx:Edmx>',
      );
    return state.respond(url, init);
  });
  const adapter = new TrestleAdapter({
    enabled,
    endpoints,
    authorization: { current: async () => state.authorization },
    credentials: {
      withClientCredentials: async (_context, run) => {
        credentials();
        return run(state.credential);
      },
    },
    fetch,
    now: () => state.now,
  });
  return { state, fetch, credentials, adapter };
}

describe("Trestle authorization and safe transport", () => {
  it("is disabled before credentials and network", async () => {
    const h = harness(false);
    await expect(h.adapter.readMetadata(context)).rejects.toMatchObject({ code: "TRESTLE_NOT_ENABLED" });
    expect(h.credentials).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each(["pending", "suspended", "terminated"] as const)(
    "denies %s connections before credentials",
    async (connectionState) => {
      const h = harness();
      h.state.authorization = { ...h.state.authorization, connectionState };
      await expect(h.adapter.search(context, {})).rejects.toMatchObject({
        code: "TRESTLE_FEED_NOT_AUTHORIZED",
      });
      expect(h.credentials).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["unknown", "pending"] as const)("denies %s broker authorization", async (brokerAuthorization) => {
    const h = harness();
    h.state.authorization = { ...h.state.authorization, brokerAuthorization };
    await expect(h.adapter.readMetadata(context)).rejects.toMatchObject({
      code: "TRESTLE_FEED_NOT_AUTHORIZED",
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("rejects forged organization/feed/policy context", async () => {
    const h = harness();
    for (const key of ["organizationId", "feedId", "policyVersion"])
      await expect(h.adapter.readMetadata({ ...context, [key]: "other" })).rejects.toMatchObject({
        code: "TRESTLE_FEED_NOT_AUTHORIZED",
      });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("permits metadata after connection approval but denies unknown display rights", async () => {
    const h = harness();
    h.state.authorization = {
      ...h.state.authorization,
      observedPropertyFields: [],
      originatingSystemIds: [],
      policy: {
        ...h.state.authorization.policy,
        approvalState: "unapproved",
        rights: { ...h.state.authorization.policy.rights, display: "unknown" },
      },
    };
    expect(await h.adapter.readMetadata(context)).toContain("Edmx");
    await expect(h.adapter.search(context, {})).rejects.toMatchObject({
      code: "TRESTLE_DISPLAY_POLICY_DENIED",
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it("encodes form credentials, privately reuses tokens and uses no-store/no redirects", async () => {
    const h = harness();
    await h.adapter.search(context, {});
    await h.adapter.getListing(context, "fixture-listing");
    expect(h.fetch).toHaveBeenCalledTimes(3);
    const tokenInit = h.fetch.mock.calls[0][1];
    const body = new URLSearchParams(String(tokenInit?.body));
    expect(body.get("client_secret")).toBe(h.state.credential.clientSecret);
    expect(body.get("scope")).toBe("api");
    expect(body.get("grant_type")).toBe("client_credentials");
    for (const [, init] of h.fetch.mock.calls)
      expect(init).toMatchObject({ redirect: "error", cache: "no-store", credentials: "omit" });
    expect(JSON.stringify(h.adapter)).not.toContain("fixture-secret");
    expect(JSON.stringify(h.adapter)).not.toContain("fixture-token");
  });
  it("coalesces concurrent authentication and renews from returned lifetime", async () => {
    const h = harness();
    await Promise.all([h.adapter.search(context, {}), h.adapter.search(context, {})]);
    expect(h.fetch.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
    h.state.now = new Date(h.state.now.getTime() + 91000);
    await h.adapter.search(context, {});
    expect(h.fetch.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(2);
  });
  it("rotates cached tokens and denies expired credentials", async () => {
    const h = harness();
    await h.adapter.search(context, {});
    h.state.credential = { ...h.state.credential, version: "2", clientSecret: "rotated-fixture" };
    await h.adapter.search(context, {});
    expect(h.fetch.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(2);
    h.state.credential.expiresAt = h.state.now.toISOString();
    await expect(h.adapter.search(context, {})).rejects.toMatchObject({
      code: "TRESTLE_CREDENTIAL_NOT_READY",
    });
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });
  it("rechecks revocation after token response before fetching metadata", async () => {
    const h = harness();
    h.fetch.mockImplementationOnce(async () => {
      h.state.authorization = { ...h.state.authorization, connectionState: "terminated" };
      return json({ access_token: "fixture-token", token_type: "Bearer", expires_in: 120 });
    });
    await expect(h.adapter.readMetadata(context)).rejects.toMatchObject({
      code: "TRESTLE_FEED_NOT_AUTHORIZED",
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("withholds a response when authorization changes in flight", async () => {
    const h = harness();
    h.state.respond = () => {
      h.state.authorization = { ...h.state.authorization, revision: "2" };
      return json({ value: [row()] });
    };
    await expect(h.adapter.search(context, {})).rejects.toMatchObject({
      code: "TRESTLE_AUTHORIZATION_CHANGED",
    });
    expect(await h.adapter.health(context)).toMatchObject({ state: "unavailable" });
  });
  it.each([401, 403])("does not blindly retry HTTP %s and clears the token", async (status) => {
    const h = harness();
    h.state.respond = () => json({ secret: "never-log-this" }, { status });
    await expect(h.adapter.search(context, {})).rejects.toMatchObject({
      code: "TRESTLE_AUTH_DENIED",
      status,
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.state.respond = () => json({ value: [] });
    await h.adapter.search(context, {});
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });
  it("returns bounded quota diagnostics without provider bodies", async () => {
    const h = harness();
    h.state.respond = () =>
      json({ password: "never-log-this" }, { status: 429, headers: { "retry-after": "99999" } });
    const error = await h.adapter.search(context, {}).catch((error) => error);
    expect(error).toMatchObject({ code: "TRESTLE_QUOTA_EXCEEDED", retryAfterSeconds: 3600 });
    expect(String(error)).not.toContain("never-log-this");
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it("bounds response size and rejects metadata entities", async () => {
    const h = harness();
    h.state.respond = () => json({ value: [] }, { headers: { "content-length": "99999999" } });
    await expect(h.adapter.search(context, {})).rejects.toMatchObject({ code: "TRESTLE_RESPONSE_TOO_LARGE" });
    h.fetch.mockImplementationOnce(
      async () => new Response('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///private">]><Edmx/>'),
    );
    await expect(h.adapter.readMetadata(context)).rejects.toMatchObject({
      code: "TRESTLE_BAD_METADATA_RESPONSE",
    });
  });
  it("times out safely without leaking thrown transport details", async () => {
    const h = harness();
    h.state.respond = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("private transport detail")), {
          once: true,
        }),
      );
    await expect(h.adapter.search(context, {})).rejects.toMatchObject({
      code: "TRESTLE_REQUEST_TIMEOUT",
      message: "TRESTLE_REQUEST_TIMEOUT",
    });
  });
  it("rejects alternate endpoints and invalid calendar dates", () => {
    for (const tokenUrl of [
      "http://api.cotality.com/trestle/oidc/connect/token",
      "https://evil.example/trestle/oidc/connect/token",
      "https://api.cotality.com/trestle/oidc/connect/token?secret=x",
    ])
      expect(() => endpointConfig({ ...endpoints, tokenUrl })).toThrow("TRESTLE_ENDPOINT_DENIED");
    expect(Number.isNaN(instant("2026-02-30T00:00:00Z"))).toBe(true);
  });
  it("keeps environment credentials scoped and non-serializable", async () => {
    const source = new EnvironmentTrestleCredentials(context, {
      TRESTLE_CLIENT_ID: "fixture",
      TRESTLE_CLIENT_SECRET: "private-fixture",
      TRESTLE_CREDENTIAL_VERSION: "1",
      TRESTLE_CREDENTIAL_EXPIRES_AT: "2027-01-01T00:00:00Z",
    });
    await expect(
      source.withClientCredentials({ ...context, feedId: "other" }, async () => true),
    ).rejects.toMatchObject({ code: "TRESTLE_CREDENTIAL_SCOPE_DENIED" });
    expect(JSON.stringify(source)).not.toContain("private-fixture");
  });
});

describe("Trestle listing projection and continuations", () => {
  it.each(["ListOfficeName", "AttributionContact", "brokerage", "attributionContact"])(
    "denies unverified required attribution %s before credentials or network",
    async (field) => {
      const h = harness();
      h.state.authorization = {
        ...h.state.authorization,
        observedPropertyFields: h.state.authorization.observedPropertyFields.filter(
          (value) => value !== field,
        ),
        policy: {
          ...h.state.authorization.policy,
          allowedFields: h.state.authorization.policy.allowedFields.filter((value) => value !== field),
        },
      };
      await expect(h.adapter.search(context, {})).rejects.toMatchObject({
        code: "TRESTLE_REQUIRED_ATTRIBUTION_UNVERIFIED",
      });
      await expect(h.adapter.getListing(context, "fixture-listing")).rejects.toMatchObject({
        code: "TRESTLE_REQUIRED_ATTRIBUTION_UNVERIFIED",
      });
      await expect(h.adapter.capabilities(context)).rejects.toMatchObject({
        code: "TRESTLE_REQUIRED_ATTRIBUTION_UNVERIFIED",
      });
      expect(await h.adapter.health(context)).toEqual({ state: "unavailable", lastSuccessAt: null });
      expect(h.credentials).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["fictional-participant@example.invalid", "+1 (702) 555-0100 ext 42"])(
    "preserves the licensed provided attribution contact %s",
    (AttributionContact) => {
      const listing = mapTrestleListing(
        row({ AttributionContact }),
        authorization(),
        new Date("2026-10-10T00:00:00Z"),
      );
      expect(listing?.attribution).toMatchObject({
        brokerage: "Fixture brokerage",
        contact: {
          kind: AttributionContact.includes("@") ? "email" : "phone",
          value: AttributionContact,
        },
      });
    },
  );
  it.each([
    undefined,
    null,
    "",
    "unknown",
    "123 ext 4567",
    "mailto:fictional@example.invalid",
    "7025550100\n",
  ])(
    "suppresses unavailable or malformed contact without office or agent fallback %#",
    async (AttributionContact) => {
      const h = harness();
      h.state.respond = () =>
        json({
          value: [
            row({
              AttributionContact,
              ListOfficePhone: "702-555-0101",
              ListAgentDirectPhone: "702-555-0102",
              ListAgentEmail: "fictional-fallback@example.invalid",
              ownerContact: "702-555-0103",
            }),
          ],
        });
      expect((await h.adapter.search(context, {})).items).toEqual([]);
      expect(await h.adapter.getListing(context, "fixture-listing")).toBeNull();
    },
  );
  it.each([undefined, null, "", " ", "a".repeat(201)])(
    "suppresses listings with unavailable listing firm %#",
    (ListOfficeName) => {
      expect(
        mapTrestleListing(row({ ListOfficeName }), authorization(), new Date("2026-10-10T00:00:00Z")),
      ).toBeNull();
    },
  );
  it("clears previous health evidence when attribution rights are withdrawn", async () => {
    const h = harness();
    await h.adapter.search(context, {});
    expect((await h.adapter.health(context)).state).toBe("ready");
    h.state.authorization = {
      ...h.state.authorization,
      policy: {
        ...h.state.authorization.policy,
        allowedFields: h.state.authorization.policy.allowedFields.filter(
          (value) => value !== "attributionContact",
        ),
      },
    };
    expect(await h.adapter.health(context)).toEqual({ state: "unavailable", lastSuccessAt: null });
    h.state.authorization = authorization();
    expect(await h.adapter.health(context)).toEqual({ state: "unavailable", lastSuccessAt: null });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it("projects licensed fields, real provenance and expiration, never raw private fields", async () => {
    const h = harness();
    const result = (await h.adapter.search(context, {})).items[0];
    expect(result).toMatchObject({
      listPrice: 500000,
      area: { value: 1500, unit: "sqft" },
      synthetic: false,
      expiresAt: "2026-10-10T00:05:00.000Z",
      attribution: { disclaimer: "Fixture attribution", contact: { kind: "phone", value: "702-555-0100" } },
    });
    expect(JSON.stringify(result)).not.toContain("PrivateRemarks");
    expect(JSON.stringify(result)).not.toContain("must never escape");
    h.state.authorization = {
      ...h.state.authorization,
      policy: {
        ...h.state.authorization.policy,
        allowedFields: ["status", "brokerage", "attributionContact"],
      },
    };
    const restricted = (await h.adapter.search(context, {})).items[0];
    expect(restricted).toMatchObject({
      listPrice: null,
      area: null,
      address: null,
      coordinates: null,
      publicRemarks: null,
    });
  });
  it.each([false, "true", undefined])("hides addresses unless display flag is boolean true (%s)", (flag) => {
    expect(
      mapTrestleListing(
        row({ InternetAddressDisplayYN: flag }),
        authorization(),
        new Date("2026-10-10T00:00:00Z"),
      ),
    ).toMatchObject({ address: null, coordinates: null, addressAllowed: false });
  });
  it.each(["Withdrawn", "Closed", "UnknownStatus"])(
    "excludes %s listings from fresh detail reads",
    async (StandardStatus) => {
      const h = harness();
      expect(await h.adapter.getListing(context, "fixture-listing")).not.toBeNull();
      h.state.respond = () => json({ value: [row({ StandardStatus })] });
      expect(await h.adapter.getListing(context, "fixture-listing")).toBeNull();
    },
  );
  it("denies foreign MLS, synthetic, and duplicate source records", async () => {
    const h = harness();
    for (const [overrides, code] of [
      [{ OriginatingSystemID: "other-mls" }, "TRESTLE_SOURCE_SCOPE_DENIED"],
      [{ synthetic: true }, "TRESTLE_UNTRUSTED_SOURCE_RECORD"],
      [{ ListingKey: "SYNTHETIC-1" }, "TRESTLE_UNTRUSTED_SOURCE_RECORD"],
    ] as const) {
      h.state.respond = () => json({ value: [row(overrides)] });
      await expect(h.adapter.search(context, {})).rejects.toMatchObject({ code });
    }
    h.state.respond = () => json({ value: [row(), row()] });
    await expect(h.adapter.search(context, {})).rejects.toMatchObject({
      code: "TRESTLE_DUPLICATE_SOURCE_RECORD",
    });
  });
  it("leaves unknown numeric values and area units null", () => {
    expect(
      mapTrestleListing(
        row({ ListPrice: null, BedroomsTotal: "3", LivingAreaUnits: "Acres" }),
        authorization(),
        new Date("2026-10-10T00:00:00Z"),
      ),
    ).toMatchObject({ listPrice: null, bedrooms: null, area: null });
  });
  it("escapes literals, enforces feed filtering and selected source fields", () => {
    const auth = { ...authorization(), originatingSystemIds: ["MLS'quoted"] };
    const url = propertyQuery(endpoints.odataBaseUrl, context, { propertyTypes: ["House'quoted"] }, auth, 20);
    expect(url.searchParams.get("$filter")).toContain("OriginatingSystemID eq 'MLS''quoted'");
    expect(url.searchParams.get("$filter")).toContain("PropertyType eq 'House''quoted'");
    expect(url.searchParams.get("$select")).not.toContain("PrivateRemarks");
    expect(url.searchParams.get("$select")?.split(",")).toEqual(
      expect.arrayContaining(["ListOfficeName", "AttributionContact"]),
    );
    for (const fallback of ["ListOfficePhone", "ListAgentDirectPhone", "ListAgentEmail"])
      expect(url.searchParams.get("$select")?.split(",")).not.toContain(fallback);
  });
  it("denies hidden filter predicates, keyword search, and unverified control fields", async () => {
    const h = harness();
    h.state.authorization = {
      ...h.state.authorization,
      policy: {
        ...h.state.authorization.policy,
        allowedFields: ["status", "brokerage", "attributionContact"],
      },
    };
    await expect(h.adapter.search(context, { priceMin: 1 })).rejects.toMatchObject({
      code: "TRESTLE_FILTER_FIELD_DENIED",
    });
    await expect(h.adapter.search(context, { q: "house" })).rejects.toMatchObject({
      code: "TRESTLE_KEYWORD_NOT_IMPLEMENTED",
    });
    h.state.authorization = { ...h.state.authorization, observedPropertyFields: [] };
    await expect(h.adapter.search(context, {})).rejects.toMatchObject({
      code: "TRESTLE_REQUIRED_FIELD_UNVERIFIED",
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("rechecks actual projected filter values instead of trusting upstream search", async () => {
    const h = harness();
    expect((await h.adapter.search(context, { priceMin: 600000 })).items).toHaveLength(0);
    h.state.respond = () => json({ value: [row({ InternetAddressDisplayYN: false })] });
    expect((await h.adapter.search(context, { bbox: [-81, 29, -79, 31] })).items).toHaveLength(0);
  });
  it("binds opaque cursors to filter, tenant, policy and short process lifetime", async () => {
    const h = harness();
    h.state.respond = (url) => {
      const next = new URL(url);
      next.searchParams.set("$skip", "20");
      return json({ value: [], ...(url.searchParams.has("$skip") ? {} : { "@odata.nextLink": next.href }) });
    };
    const page = await h.adapter.search(context, {});
    expect(page.nextOpaqueCursor).not.toContain("https");
    expect(page.nextOpaqueCursor).not.toContain("fixture-mls");
    await expect(h.adapter.search(context, { priceMin: 1 }, page.nextOpaqueCursor)).rejects.toMatchObject({
      code: "TRESTLE_CURSOR_DENIED",
    });
    await h.adapter.search(context, {}, page.nextOpaqueCursor);
    h.state.now = new Date(h.state.now.getTime() + 240001);
    await expect(h.adapter.search(context, {}, page.nextOpaqueCursor)).rejects.toMatchObject({
      code: "TRESTLE_CURSOR_DENIED",
    });
  });
  it("rejects scope-changing, redirecting and stalled continuation URLs", () => {
    const query = propertyQuery(endpoints.odataBaseUrl, context, {}, authorization(), 20);
    const valid = new URL(query);
    valid.searchParams.set("$skip", "20");
    expect(continuation(valid.href, query)?.href).toBe(valid.href);
    for (const change of [
      (url: URL) => {
        url.hostname = "evil.example";
      },
      (url: URL) => {
        url.searchParams.delete("$filter");
      },
      (url: URL) => {
        url.searchParams.set("$expand", "Media");
      },
      (url: URL) => {
        url.searchParams.set("$skip", "0");
      },
      (url: URL) => {
        url.searchParams.append("$top", "20");
      },
    ]) {
      const next = new URL(valid);
      change(next);
      expect(() => continuation(next.href, query)).toThrow("TRESTLE_CONTINUATION_DENIED");
    }
    expect(() => continuation(valid.href, valid)).toThrow("TRESTLE_CONTINUATION_DENIED");
  });
  it("reports only implemented capabilities and invalidates old health on policy revision", async () => {
    const h = harness();
    const caps = await h.adapter.capabilities(context);
    expect(caps).toMatchObject({
      media: "none",
      reso: null,
      supports: { search: true, incremental: false, deletions: false, alerts: false },
    });
    expect(h.fetch).not.toHaveBeenCalled();
    await h.adapter.search(context, {});
    expect(await h.adapter.health(context)).toMatchObject({ state: "ready" });
    h.state.authorization = { ...h.state.authorization, revision: "2" };
    expect(await h.adapter.health(context)).toMatchObject({ state: "unavailable", lastSuccessAt: null });
  });
  it("expires readiness at the approved freshness boundary without fetching or renewing it", async () => {
    const h = harness();
    expect(await h.adapter.health(context)).toEqual({ state: "unavailable", lastSuccessAt: null });
    await h.adapter.search(context, {});
    const stamp = h.state.now.toISOString(),
      calls = h.fetch.mock.calls.length;
    h.state.now = new Date(h.state.now.getTime() + 299999);
    expect(await h.adapter.health(context)).toEqual({ state: "ready", lastSuccessAt: stamp });
    h.state.now = new Date(h.state.now.getTime() + 1);
    expect(await h.adapter.health(context)).toEqual({ state: "unavailable", lastSuccessAt: stamp });
    expect(h.fetch).toHaveBeenCalledTimes(calls);
  });
  it("reports a failed provider read as degraded and restores readiness only after success", async () => {
    const h = harness();
    await h.adapter.search(context, {});
    const stamp = h.state.now.toISOString(),
      calls = h.fetch.mock.calls.length;
    h.state.respond = () => json({ private: "must never escape" }, { status: 429 });
    await expect(h.adapter.search(context, {})).rejects.toMatchObject({ code: "TRESTLE_QUOTA_EXCEEDED" });
    expect(h.fetch).toHaveBeenCalledTimes(calls + 1);
    expect(await h.adapter.health(context)).toEqual({ state: "degraded", lastSuccessAt: stamp });
    await h.adapter.readMetadata(context);
    expect(await h.adapter.health(context)).toEqual({ state: "degraded", lastSuccessAt: stamp });
    // Invalid client input neither heals nor worsens the actual provider state.
    await expect(h.adapter.search(context, { q: "unsupported" })).rejects.toMatchObject({
      code: "TRESTLE_KEYWORD_NOT_IMPLEMENTED",
    });
    expect(await h.adapter.health(context)).toEqual({ state: "degraded", lastSuccessAt: stamp });
    h.state.respond = () => json({ value: [row()] });
    h.state.now = new Date(h.state.now.getTime() + 1);
    await h.adapter.getListing(context, "fixture-listing");
    expect(await h.adapter.health(context)).toEqual({
      state: "ready",
      lastSuccessAt: h.state.now.toISOString(),
    });
  });
  it("does not interpret malformed client filters as upstream failure", async () => {
    const h = harness();
    await h.adapter.search(context, {});
    await expect(h.adapter.search(context, { q: "unsupported" })).rejects.toMatchObject({
      code: "TRESTLE_KEYWORD_NOT_IMPLEMENTED",
    });
    expect(await h.adapter.health(context)).toMatchObject({ state: "ready" });
  });
  it.each([new Date(Number.NaN), new Date("2026-10-09T23:59:59Z")])(
    "withholds readiness under invalid or regressed clocks (%s)",
    async (now) => {
      const h = harness();
      await h.adapter.search(context, {});
      h.state.now = now;
      expect(await h.adapter.health(context)).toEqual({ state: "unavailable", lastSuccessAt: null });
    },
  );
  it("clears historical health on revoked authorization and does not heal it with metadata", async () => {
    const h = harness();
    await h.adapter.search(context, {});
    h.state.authorization = { ...h.state.authorization, connectionState: "suspended" };
    expect(await h.adapter.health(context)).toEqual({ state: "unavailable", lastSuccessAt: null });
    h.state.authorization = authorization();
    await h.adapter.readMetadata(context);
    expect(await h.adapter.health(context)).toEqual({ state: "unavailable", lastSuccessAt: null });
  });
  it("denies detail key substitution and excess page size", async () => {
    const h = harness();
    await expect(h.adapter.getListing(context, "other-key")).rejects.toMatchObject({
      code: "TRESTLE_DETAIL_NOT_UNIQUE",
    });
    h.state.respond = () =>
      json({ value: Array.from({ length: 21 }, (_, index) => row({ ListingKey: String(index) })) });
    await expect(h.adapter.search(context, {})).rejects.toMatchObject({
      code: "TRESTLE_PAGE_BOUND_EXCEEDED",
    });
  });
});
