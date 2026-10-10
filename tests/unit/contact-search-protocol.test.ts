import { createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parseContactQuery } from "../../apps/api/src/contact-query";
import { CrmService } from "../../apps/api/src/crm-service";
import { cursorBinding, decodeCursor, encodeCursor } from "../../apps/api/src/cursors";
import {
  contactSearchContextBinding,
  contactSearchExpired,
  contactSearchRequest,
  requireContactNameQuery,
  requireContactSearchPage,
  requireLoadedContactResults,
} from "../../apps/web/components/contacts-search-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";
import type { TenantContext } from "../../packages/db/tenant-transaction";

const cursorConfiguration = vi.hoisted(() => {
  const previous = process.env.CURSOR_SIGNING_KEY;
  const key = "synthetic-contact-unit-signing-no-network-only";
  process.env.CURSOR_SIGNING_KEY = key;
  return { previous, key };
});
afterAll(() => {
  if (cursorConfiguration.previous === undefined) delete process.env.CURSOR_SIGNING_KEY;
  else process.env.CURSOR_SIGNING_KEY = cursorConfiguration.previous;
});

const org = "10000000-0000-4000-8000-000000000001";
const now = "2026-10-10T12:00:00.123Z";
function row(index = 1): Schema<"Contact"> {
  return {
    id: "41000000-0000-4000-8000-" + String(index).padStart(12, "0"),
    displayName: "PRIVATE name " + index,
    emails: [],
    phones: [],
    version: 1,
  };
}
function page(count = 1, more = false): Schema<"PageContact"> {
  return {
    items: Array.from({ length: count }, (_, index) => row(index + 1)),
    hasMore: more,
    nextCursor: more ? "opaque-contact-cursor" : null,
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("closed own-data contact query before authority I/O", () => {
  it("detaches exact text, valid and empty ordinary tag arrays without changing frozen input", () => {
    const tags = [org];
    const input = {
      limit: "25",
      filter: JSON.stringify({ q: " %_\\ 🏠 ", tagIds: tags, ownerMemberId: org }),
    };
    const result = parseContactQuery(input);
    expect(result).toEqual({
      limit: 25,
      cursor: undefined,
      filter: { q: " %_\\ 🏠 ", tagIds: tags, ownerMemberId: org },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.filter)).toBe(true);
    expect(Object.isFrozen(result.filter.tagIds)).toBe(true);
    expect(result.filter.tagIds?.map((id) => id)).toEqual(tags);
    expect(parseContactQuery({ filter: '{"tagIds":[]}' }).filter.tagIds).toEqual([]);
    expect(input.filter).toContain("tagIds");
  });
  it.each([1, 25, 100, "1", "25", "100"])("accepts the approved internal/canonical limit %s", (limit) =>
    expect(parseContactQuery({ limit }).limit).toBe(Number(limit)),
  );
  it.each([0, 101, 1.1, NaN, "", "01", "1.0", "+1", " 1", [1], true, null, {}])(
    "rejects noncanonical limit case%#",
    (limit) => expect(() => parseContactQuery({ limit })).toThrow(),
  );
  it.each([
    null,
    [],
    "",
    2,
    { q: "name" },
    { sort: "name" },
    { limit: 25, cursor: "x", filter: "{}", extra: true },
  ])("rejects unapproved query case%#", (query) => expect(() => parseContactQuery(query)).toThrow());
  it.each([
    "",
    "{",
    "[]",
    "null",
    '{"q":1}',
    '{"q":"\\ud800"}',
    '{"intent":"buyer"}',
    '{"extra":true}',
    " ".repeat(16385),
  ])("rejects malformed/unsupported filter case%#", (filter) =>
    expect(() => parseContactQuery({ filter })).toThrow(),
  );
  it("counts Unicode code points and does not trim a permitted query", () => {
    expect(parseContactQuery({ filter: JSON.stringify({ q: "😀".repeat(200) }) }).filter.q).toHaveLength(400);
    expect(() => parseContactQuery({ filter: JSON.stringify({ q: "😀".repeat(201) }) })).toThrow();
    expect(parseContactQuery({ filter: '{"q":"  name  "}' }).filter.q).toBe("  name  ");
  });
  it("rejects accessor/proxy/symbol/nonenumerable queries without executing hooks", () => {
    let hooks = 0;
    const accessor = Object.defineProperty({}, "limit", {
      enumerable: true,
      get() {
        hooks++;
        return 1;
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          hooks++;
          return [];
        },
        getPrototypeOf() {
          hooks++;
          return null;
        },
      },
    );
    const symbol = { [Symbol("private")]: true };
    const hidden = Object.defineProperty({}, "limit", { value: 1 });
    for (const value of [accessor, proxy, symbol, hidden]) expect(() => parseContactQuery(value)).toThrow();
    expect(hooks).toBe(0);
  });
  it.each(["object-getter", "object-function", "array-getter", "array-function"] as const)(
    "keeps hasMore binding, authority and actual signed cursor inert under %s",
    async (kind) => {
      // Warm contract compilation before testing data serialization, not Ajv's code generator.
      parseContactQuery({ filter: '{"tagIds":[]}' });
      let hooks = 0,
        encoded: string | null = null;
      const observed: unknown[] = [];
      const context: TenantContext = {
        organizationId: org,
        userId: org,
        memberId: org,
        roleId: org,
        roleName: "Synthetic search",
        timezone: "UTC",
        permissions: [{ code: "crm.contacts.read", scope: "organization" }],
      };
      const client = {
        query: async (sql: string, parameters: unknown[]) => {
          if (sql.includes("FROM app.membership")) {
            observed.push(parameters[4]);
            return { rowCount: 1, rows: [{}] };
          }
          if (sql.includes("FROM app.entitlement")) return { rowCount: 1, rows: [{}] };
          if (sql.includes("FROM app.contact r"))
            return {
              rowCount: 2,
              rows: [1, 2].map((id) => ({
                id: row(id).id,
                display_name: "Synthetic",
                emails: [],
                phones: [],
                row_version: "1",
              })),
            };
          throw new Error("Unexpected no-database statement.");
        },
      } as unknown as PoolClient;
      const prototype = kind.startsWith("array") ? Array.prototype : Object.prototype;
      const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      try {
        Object.defineProperty(
          prototype,
          "toJSON",
          kind.endsWith("getter")
            ? {
                configurable: true,
                get() {
                  hooks++;
                  return undefined;
                },
              }
            : {
                configurable: true,
                value() {
                  hooks++;
                  return "POISON";
                },
              },
        );
        const result = await new CrmService(client, context, "synthetic-no-db").list("contacts", {
          limit: 1,
          filter: '{"q":"%_\\\\","tagIds":[]}',
        });
        expect(result.hasMore).toBe(true);
        encoded = result.nextCursor;
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(hooks).toBe(0);
      expect(observed.length).toBeGreaterThanOrEqual(3);
      for (const authority of observed) expect(JSON.parse(authority as string)).toEqual(context.permissions);
      expect(encoded).toBeTruthy();
      const [wire, signature] = encoded!.split(".");
      const body = JSON.parse(Buffer.from(wire, "base64url").toString("utf8"));
      expect(Object.keys(body)).toEqual(["id", "binding", "expires"]);
      expect(body.id).toBe(row().id);
      expect(body.binding).toMatch(/^[a-f0-9]{64}$/);
      expect(body.expires - Date.now()).toBeGreaterThan(890000);
      expect(signature).toBe(createHmac("sha256", cursorConfiguration.key).update(wire).digest("base64url"));
      expect(decodeCursor(encoded, body.binding)).toBe(row().id);
      expect(() => decodeCursor(encoded, "changed-current-context")).toThrow();
      const old = encodeCursor(
        row().id,
        cursorBinding(context, "contacts", "organization", { q: "%_\\", tagIds: [] }),
      );
      await expect(
        new CrmService(client, context, "synthetic-no-db").list("contacts", {
          limit: 1,
          cursor: old,
          filter: '{"q":"%_\\\\","tagIds":[]}',
        }),
      ).rejects.toMatchObject({ status: 422, code: "cursor_invalid" });
    },
  );
});

describe("private generated contact page boundary", () => {
  it("detaches and freezes generated data without filling inherited optional fields", () => {
    const input = page();
    const output = requireContactSearchPage(input);
    input.items[0].displayName = "changed";
    expect(output.items[0].displayName).toBe("PRIVATE name 1");
    expect(Object.isFrozen(output.items[0])).toBe(true);
    expect(Object.isFrozen(output.items)).toBe(true);
    expect(Object.hasOwn(output.items[0], "birthday")).toBe(false);
  });
  it("ignores inherited optional query/response getters without executing or retaining them", () => {
    parseContactQuery({ filter: "{}" });
    let hooks = 0;
    const originals = ["q", "birthday"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const,
    );
    let query: ReturnType<typeof parseContactQuery> | undefined;
    let result: Schema<"PageContact"> | undefined;
    try {
      for (const [key] of originals)
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() {
            hooks++;
            return "PRIVATE_INHERITED";
          },
        });
      query = parseContactQuery({ filter: "{}" });
      result = requireContactSearchPage(page());
    } finally {
      for (const [key, original] of originals)
        if (original) Object.defineProperty(Object.prototype, key, original);
        else Reflect.deleteProperty(Object.prototype, key);
    }
    expect(hooks).toBe(0);
    expect(Object.hasOwn(query!.filter, "q")).toBe(false);
    expect(Object.hasOwn(result!.items[0], "birthday")).toBe(false);
  });
  it.each([0, 1, 25])("accepts a complete final page of%s rows", (count) =>
    expect(requireContactSearchPage(page(count)).items).toHaveLength(count),
  );
  it("separates a transport25 page from a locally accumulated200 collection", () => {
    expect(() => requireContactSearchPage(page(26))).toThrow();
    expect(requireLoadedContactResults(page(200)).items).toHaveLength(200);
    expect(() => requireLoadedContactResults(page(201))).toThrow();
  });
  it.each([0, 1, 24])(
    "rejects short hasMore pages that contradict the fixed server page size case%#",
    (count) => expect(() => requireContactSearchPage(page(count, true))).toThrow(),
  );
  it.each([
    "extra",
    "bad-email",
    "unsafe-version",
    "duplicate",
    "descending",
    "cursor-mismatch",
    "blank-cursor",
    "oversize",
  ])("rejects an unverifiable generated projection %s", (kind) => {
    const input = page(2) as Schema<"PageContact"> & { extra?: string };
    if (kind === "extra") input.extra = "PRIVATE";
    if (kind === "bad-email") input.items[0].emails = ["invalid"];
    if (kind === "unsafe-version") input.items[0].version = Number.MAX_SAFE_INTEGER + 1;
    if (kind === "duplicate") input.items[1].id = input.items[0].id;
    if (kind === "descending") input.items.reverse();
    if (kind === "cursor-mismatch") input.nextCursor = "cursor";
    if (kind === "blank-cursor") input.nextCursor = " ";
    if (kind === "oversize") input.items[0].displayName = "p".repeat(1024 * 1024);
    expect(() => requireContactSearchPage(input)).toThrow();
  });
  it("rejects accessors and sparse/extraneous arrays without calling a getter", () => {
    let hooks = 0;
    const input = page();
    Object.defineProperty(input.items[0], "displayName", {
      enumerable: true,
      get() {
        hooks++;
        return "PRIVATE";
      },
    });
    expect(() => requireContactSearchPage(input)).toThrow();
    expect(hooks).toBe(0);
    const sparse = page();
    sparse.items = new Array(1);
    expect(() => requireContactSearchPage(sparse)).toThrow();
    const extra = page();
    Object.assign(extra.items, { extra: "private" });
    expect(() => requireContactSearchPage(extra)).toThrow();
  });
  it.each(["object-getter", "array-getter", "object-function", "array-function"] as const)(
    "does not execute inherited response JSON hooks %s",
    (kind) => {
      let hooks = 0;
      const prototype = kind.startsWith("array") ? Array.prototype : Object.prototype,
        previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let result: unknown;
      try {
        Object.defineProperty(
          prototype,
          "toJSON",
          kind.endsWith("getter")
            ? {
                configurable: true,
                get() {
                  hooks++;
                  return undefined;
                },
              }
            : {
                configurable: true,
                value() {
                  hooks++;
                  return null;
                },
              },
        );
        result = requireContactSearchPage(page());
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(hooks).toBe(0);
      expect(result).toEqual(page());
    },
  );
  it.each(["", " %_\\ 🏠 ", "😀".repeat(200)])("preserves valid exact name input case%#", (text) =>
    expect(requireContactNameQuery(text)).toBe(text),
  );
  it.each([null, {}, 3, "😀".repeat(201), "\ud800"])(
    "rejects invalid query without coercion case%#",
    (text) => expect(() => requireContactNameQuery(text)).toThrow(),
  );
  it("expires at five minutes and fails closed on invalid/backwards clocks", () => {
    expect(contactSearchExpired(now, "2026-10-10T12:05:00.122Z")).toBe(false);
    for (const current of ["2026-10-10T12:05:00.123Z", "2026-10-10T11:59:00.123Z", "bad", null])
      expect(contactSearchExpired(now, current)).toBe(true);
  });
  it("changes context for user, organization, member, permissions, revision and explicit scope", () => {
    const session = {
      userId: org,
      activeOrgId: org,
      permissions: ["crm.contacts.read"],
    } as Schema<"Session">;
    const input = { session, memberId: org, accessRevision: 1, scope: "own" as const };
    const binding = contactSearchContextBinding(input);
    for (const changed of [
      { ...input, memberId: row().id },
      { ...input, accessRevision: 2 },
      { ...input, scope: "authorized" as const },
      { ...input, session: { ...session, activeOrgId: row().id } },
      { ...input, session: { ...session, userId: row().id } },
      { ...input, session: { ...session, permissions: [] } },
    ])
      expect(contactSearchContextBinding(changed)).not.toBe(binding);
  });
});

describe("read-only bounded contact transport", () => {
  it("sends only exact query/filter/cursor through no-store same-origin GET", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(page()), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await contactSearchRequest(org, { q: " %_\\ 🏠 ", ownerMemberId: org }, "signed-cursor");
    const [url, options] = fetcher.mock.calls[0];
    const target = new URL(String(url), "http://localhost");
    expect(target.pathname).toBe("/api/v1/orgs/" + org + "/contacts");
    expect([...target.searchParams.keys()].sort()).toEqual(["cursor", "filter", "limit"]);
    expect(JSON.parse(target.searchParams.get("filter")!)).toEqual({ q: " %_\\ 🏠 ", ownerMemberId: org });
    expect(target.searchParams.get("limit")).toBe("25");
    expect(target.searchParams.get("cursor")).toBe("signed-cursor");
    expect(options).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(options?.body).toBeUndefined();
  });
  it("omits an empty filter/cursor and rejects unsupported request inputs before fetch", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    await contactSearchRequest(org, {});
    expect(String(fetcher.mock.calls[0][0])).toMatch(/contacts\?limit=25$/);
    for (const filter of [{ tagIds: [org] }, { stageId: org }])
      await expect(contactSearchRequest(org, filter)).rejects.toThrow();
    await expect(contactSearchRequest("PRIVATE_INVALID_ORG", {})).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404, 503])(
    "preserves actual denial/failure%d despite a malformed private error body",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("PRIVATE_BAD_ERROR", { status })),
      );
      await expect(contactSearchRequest(org, {})).rejects.toMatchObject({
        status,
        code: "contact_search_failed",
      });
    },
  );
  it("rejects oversized success and fatal UTF8 instead of returning partial/empty data", async () => {
    for (const body of [new Uint8Array(1024 * 1024 + 1), new Uint8Array([0xff])]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 200 })),
      );
      await expect(contactSearchRequest(org, {})).rejects.toThrow();
    }
  });
  it("aborts an unresponsive transport at the documented deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, options: RequestInit) =>
          new Promise((_resolve, reject) =>
            options.signal?.addEventListener("abort", () => reject(new ApiError(0, "interrupted")), {
              once: true,
            }),
          ),
      ),
    );
    const pending = contactSearchRequest(org, {}).catch((error) => error);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await pending).toBeInstanceOf(ApiError);
  });
});
