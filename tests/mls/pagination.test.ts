import { beforeEach, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import {
  getNativeMockListing,
  type Listing,
  type ListingSort,
  type NativeMockSnapshot,
  searchNativeMockListings,
} from "../../packages/mls";
import { decodeListingCursor } from "../../packages/mls/cursor";
import { MOCK_CLOCK } from "../../packages/providers/mls/mock";
import { assertContract } from "../helpers/api";
import { context, displayPolicy, mockSnapshot, nativeRights, options } from "./fixtures";

let snapshot: NativeMockSnapshot;
beforeEach(async () => {
  snapshot = await mockSnapshot();
});
const page = (cursor?: string | null) =>
  searchNativeMockListings(snapshot, context, { limit: 1, cursor }, options);

describe("W07 stable bounded pagination", () => {
  it.each(["updated_desc", "price_asc", "price_desc"] as const)(
    "pages %s without missing/duplicate IDs across equal timestamps",
    (sort: ListingSort) => {
      const expected = searchNativeMockListings(snapshot, context, { limit: 100, sort }, options).items;
      const items: Listing[] = [];
      let cursor: string | null = null;
      do {
        const result = searchNativeMockListings(snapshot, context, { limit: 1, sort, cursor }, options);
        assertContract("PageListing", result);
        items.push(...result.items);
        expect(result.hasMore).toBe(result.nextCursor !== null);
        cursor = result.nextCursor;
      } while (cursor);
      expect(items).toEqual(expected);
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    },
  );

  it("sorts permitted values with nulls last and durable UUIDs breaking ties", () => {
    const rows = snapshot.listings.slice(0, 3).map((row, index) => ({
      ...row,
      canonical: { ...row.canonical, listPrice: index === 0 ? null : 400000, sourceModifiedAt: null },
    }));
    snapshot = { ...snapshot, listings: rows };
    for (const sort of ["price_asc", "price_desc"] as const)
      expect(
        searchNativeMockListings(snapshot, context, { sort }, options).items.map((item) => item.id),
      ).toEqual([rows[1].id, rows[2].id, rows[0].id]);
    expect(searchNativeMockListings(snapshot, context, {}, options).items.map((item) => item.id)).toEqual(
      rows.map((row) => row.id),
    );
  });

  it("binds normalized equivalent filters and source ordering consistently", () => {
    const result = searchNativeMockListings(
      snapshot,
      context,
      { limit: 1, filter: { status: ["pending", "active"], q: "SYNTHETIC" } },
      options,
    );
    expect(result.hasMore).toBe(true);
    snapshot = { ...snapshot, listings: [...snapshot.listings].reverse() };
    expect(
      searchNativeMockListings(
        snapshot,
        context,
        {
          limit: 1,
          filter: { q: "synthetic", status: ["active", "pending", "active"] },
          cursor: result.nextCursor,
        },
        options,
      ).items[0].id,
    ).not.toBe(result.items[0].id);
  });

  it("cursor body includes only native position, hash binding and expiry", () => {
    const cursor = page().nextCursor!;
    const body = JSON.parse(Buffer.from(cursor.split(".")[0], "base64url").toString("utf8"));
    expect(Object.keys(body).sort()).toEqual(["binding", "expires", "id", "v"]);
    expect(body.expires).toBe(MOCK_CLOCK.getTime() + 15 * 60_000);
    expect(JSON.stringify(body)).not.toMatch(/Juniper|SYNTHETIC|listPrice|address|sourceListingKey/);
  });

  it("binds verified scope explicitly without depending on extra session credentials", () => {
    const first = searchNativeMockListings(
      snapshot,
      { ...context, csrfToken: "private-first", tokenHash: "session-one" } as typeof context,
      { limit: 1 },
      options,
    );
    const second = searchNativeMockListings(
      snapshot,
      { ...context, csrfToken: "private-second", tokenHash: "session-two" } as typeof context,
      { limit: 1, cursor: first.nextCursor },
      options,
    );
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });

  it.each([
    "filter",
    "sort",
    "limit",
    "member",
    "role",
    "grants",
    "tenant",
    "policy",
    "fields",
    "withdrawal",
    "listing",
  ])("rejects a cursor after %s changes", (change) => {
    const cursor = page().nextCursor!;
    let reader = context;
    let query: Parameters<typeof searchNativeMockListings>[2] = { limit: 1, cursor };
    if (change === "filter") query = { ...query, filter: { status: ["active"] } };
    if (change === "sort") query = { ...query, sort: "price_asc" };
    if (change === "limit") query = { ...query, limit: 2 };
    if (change === "member") reader = { ...context, memberId: fixtures.agentMemberA };
    if (change === "role") reader = { ...context, roleId: "40000000-0000-4000-8000-000000000102" };
    if (change === "grants")
      reader = {
        ...context,
        permissions: [...context.permissions, { code: "mls.feeds.read", scope: "organization" }],
      };
    if (change === "tenant") {
      reader = { ...context, organizationId: fixtures.orgB };
      snapshot = {
        feeds: snapshot.feeds.map((row) => ({ ...row, tenantId: fixtures.orgB })),
        listings: snapshot.listings.map((row) => ({ ...row, tenantId: fixtures.orgB })),
      };
    }
    if (change === "policy")
      snapshot = {
        ...snapshot,
        feeds: snapshot.feeds.map((row) => ({
          ...row,
          nativeRights: { ...nativeRights, approvalState: "revoked" },
        })),
      };
    if (change === "fields")
      snapshot = {
        ...snapshot,
        feeds: snapshot.feeds.map((row) => ({
          ...row,
          nativeRights: { ...nativeRights, allowedFields: ["status"] },
        })),
      };
    if (change === "withdrawal")
      snapshot = {
        ...snapshot,
        listings: snapshot.listings.map((row, index) =>
          index === 0 ? { ...row, withdrawnAt: MOCK_CLOCK.toISOString() } : row,
        ),
      };
    if (change === "listing")
      snapshot = {
        ...snapshot,
        listings: snapshot.listings.map((row, index) =>
          index === 0 ? { ...row, canonical: { ...row.canonical, listPrice: 1 } } : row,
        ),
      };
    expect(() => searchNativeMockListings(snapshot, reader, query, options)).toThrow(/Pagination/);
  });

  it("expires no later than the earliest current listing rights/expiry and rejects tampering", () => {
    snapshot = {
      ...snapshot,
      feeds: snapshot.feeds.map((row) => ({
        ...row,
        displayPolicy: { ...displayPolicy, maxStaleSeconds: 60 },
      })),
    };
    const cursor = page().nextCursor!;
    const body = JSON.parse(Buffer.from(cursor.split(".")[0], "base64url").toString("utf8"));
    expect(body.expires).toBe(MOCK_CLOCK.getTime() + 60_000);
    expect(() =>
      searchNativeMockListings(
        snapshot,
        context,
        { limit: 1, cursor },
        { ...options, now: new Date(body.expires) },
      ),
    ).toThrow(/Pagination/);
    for (const value of ["", "mock:1", "x".repeat(2049), `${cursor}x`, `${cursor.split(".")[0]}.AAAA`, 42])
      expect(() => decodeListingCursor(value, body.binding, options.now, options.signingKey)).toThrow();
    expect(() =>
      decodeListingCursor(
        cursor,
        body.binding,
        options.now,
        "different-synthetic-signing-key-more-than-32-bytes",
      ),
    ).toThrow();
  });

  it("requires configured signing for multi-page reads and rejects invalid request bounds", () => {
    expect(() =>
      searchNativeMockListings(snapshot, context, { limit: 1 }, { ...options, signingKey: "" }),
    ).toThrow(/signing/);
    for (const limit of [0, 101, 1.5, Number.NaN])
      expect(() => searchNativeMockListings(snapshot, context, { limit }, options)).toThrow();
    expect(() =>
      searchNativeMockListings(snapshot, context, { sort: "source_secret" as ListingSort }, options),
    ).toThrow();
    expect(() =>
      searchNativeMockListings(snapshot, context, {}, { ...options, now: new Date("invalid") }),
    ).toThrow();
  });

  it("rereads current rights for details and rejects revoked/nonorganization grants", () => {
    const id = snapshot.listings[0].id;
    expect(getNativeMockListing(snapshot, context, id, options.now)).not.toBeNull();
    snapshot = {
      ...snapshot,
      feeds: snapshot.feeds.map((row) => ({
        ...row,
        nativeRights: { ...nativeRights, rights: { ...nativeRights.rights, display: "unknown" } },
      })),
    };
    expect(getNativeMockListing(snapshot, context, id, options.now)).toBeNull();
    for (const permissions of [
      [],
      [{ code: "mls.read", scope: "own" as const }],
      [{ code: "mls.read", scope: "team" as const }],
    ]) {
      expect(() => searchNativeMockListings(snapshot, { ...context, permissions }, {}, options)).toThrow(
        /permission/,
      );
      expect(() => getNativeMockListing(snapshot, { ...context, permissions }, id, options.now)).toThrow(
        /permission/,
      );
    }
  });

  it("rejects mixed-tenant/duplicate/orphan snapshots and an oversized cohort without truncation", () => {
    const invalid: NativeMockSnapshot[] = [
      { ...snapshot, feeds: [{ ...snapshot.feeds[0], tenantId: fixtures.orgB }] },
      { ...snapshot, listings: [{ ...snapshot.listings[0], tenantId: fixtures.orgB }] },
      { ...snapshot, feeds: [...snapshot.feeds, snapshot.feeds[0]] },
      { ...snapshot, listings: [...snapshot.listings, snapshot.listings[0]] },
      { ...snapshot, feeds: [] },
      { ...snapshot, listings: Array(501).fill(snapshot.listings[0]) },
    ];
    for (const current of invalid)
      expect(() => searchNativeMockListings(current, context, {}, options)).toThrow(/snapshot|bounded/);
  });
});
