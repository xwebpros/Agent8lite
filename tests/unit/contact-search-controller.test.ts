import { describe, expect, it, vi } from "vitest";
import {
  ContactsSearchController,
  type ContactsSearchClient,
  type ContactsSearchScope,
} from "../../apps/web/components/contacts-search-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const memberId = "30000000-0000-4000-8000-000000000001";
const instant = "2026-10-10T12:00:00.000Z";
function page(start = 1, count = 25, cursor: string | null = "next-page"): Schema<"PageContact"> {
  return {
    items: Array.from({ length: count }, (_, offset) => ({
      id: "41000000-0000-4000-8000-" + String(start + offset).padStart(12, "0"),
      displayName: "PRIVATE row " + (start + offset),
      emails: [],
      phones: [],
      version: 1,
    })),
    hasMore: cursor !== null,
    nextCursor: cursor,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(
  options: {
    scope?: ContactsSearchScope;
    client?: ContactsSearchClient;
    canRead?: boolean;
    online?: boolean;
    member?: string;
  } = {},
) {
  let clock = instant,
    current = true;
  const list = vi.fn<ContactsSearchClient["list"]>(async () => page(1, 1, null));
  const revoked = vi.fn();
  const controller = new ContactsSearchController({
    binding: "PRIVATE_binding",
    memberId: options.member ?? memberId,
    scope: options.scope ?? "own",
    online: options.online ?? true,
    canRead: options.canRead ?? true,
    client: options.client ?? { list },
    now: () => clock,
    isCurrent: () => current,
    onAccessRevoked: revoked,
  });
  return {
    controller,
    list,
    revoked,
    setClock: (value: string) => {
      clock = value;
    },
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}

describe("contact search complete-batch state and scope", () => {
  it("starts unrequested, then publishes verified empty independently of an unavailable read", async () => {
    const { controller, list } = setup();
    expect(controller.getSnapshot()).toMatchObject({ page: null, phase: "idle", appliedQuery: null });
    list.mockResolvedValueOnce(page(1, 0, null));
    await controller.submit();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      page: { items: [], hasMore: false },
      refreshedAt: instant,
      appliedQuery: "",
    });
    list.mockRejectedValueOnce(new Error("PRIVATE_provider"));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ phase: "unavailable", page: null, refreshedAt: null });
    expect(controller.getSnapshot().error).not.toContain("PRIVATE_provider");
  });
  it.each(["own", "authorized"] as const)(
    "preserves exact names and sends explicit %s scope",
    async (scope) => {
      const { controller, list } = setup({ scope });
      controller.setQuery(" %_\\ 🏠 ");
      await controller.submit();
      expect(list.mock.calls[0][0]).toEqual(
        scope === "own" ? { q: " %_\\ 🏠 ", ownerMemberId: memberId } : { q: " %_\\ 🏠 " },
      );
      expect(list.mock.calls[0][1]).toBeNull();
      expect(list.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
      expect(controller.getSnapshot()).toMatchObject({ query: " %_\\ 🏠 ", appliedQuery: " %_\\ 🏠 " });
    },
  );
  it("omits q for an empty query without omitting the member selector", async () => {
    const { controller, list } = setup();
    await controller.submit();
    expect(list.mock.calls[0][0]).toEqual({ ownerMemberId: memberId });
  });
  it("hides results synchronously when input changes, without sending before explicit submit", async () => {
    const { controller, list } = setup();
    controller.setQuery("first");
    await controller.submit();
    controller.setQuery("second");
    expect(controller.getSnapshot()).toMatchObject({
      page: null,
      appliedQuery: null,
      query: "second",
      refreshedAt: null,
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(controller.hasCurrentContact(page(1, 1, null).items[0].id)).toBe(false);
    await controller.submit();
    expect(list.mock.calls[1][0].q).toBe("second");
  });
  it("rejects unbounded/coercive query text, hides old data and never executes value hooks", async () => {
    const { controller, list } = setup();
    await controller.submit();
    const hook = vi.fn();
    controller.setQuery({ toString: hook });
    expect(controller.getSnapshot()).toMatchObject({ phase: "unavailable", page: null, query: "" });
    expect(hook).not.toHaveBeenCalled();
    controller.setQuery("😀".repeat(201));
    expect(controller.getSnapshot().page).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });
  it("re-reads previous pages from the start for more and refresh instead of declaring cached rows fresh", async () => {
    const { controller, list } = setup();
    list.mockImplementation(async (_filter, cursor) => (cursor ? page(26, 2, null) : page()));
    await controller.submit();
    await controller.more();
    expect(list.mock.calls.map((call) => call[1])).toEqual([null, null, "next-page"]);
    expect(controller.getSnapshot().page?.items).toHaveLength(27);
    list.mockClear();
    await controller.refresh();
    expect(list.mock.calls.map((call) => call[1])).toEqual([null, "next-page"]);
    expect(controller.getSnapshot().page?.items).toHaveLength(27);
  });
  it("withholds all rows until the whole multi-page read succeeds", async () => {
    const second = deferred<unknown>(),
      { controller, list } = setup();
    list.mockResolvedValueOnce(page());
    await controller.submit();
    list.mockResolvedValueOnce(page()).mockReturnValueOnce(second.promise);
    const reading = controller.more();
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ reading: true, page: null, refreshedAt: null });
    second.resolve(page(26, 2, null));
    await reading;
    expect(controller.getSnapshot().page?.items).toHaveLength(27);
  });
  it("clears all pages if a later fresh page fails and never infers an empty search", async () => {
    const { controller, list } = setup();
    list.mockResolvedValueOnce(page());
    await controller.submit();
    list.mockResolvedValueOnce(page()).mockRejectedValueOnce(new ApiError(503, "PRIVATE_provider"));
    await controller.more();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "unavailable",
      page: null,
      appliedQuery: null,
      refreshedAt: null,
      reading: false,
    });
  });
  it.each(["duplicate", "descending", "cursor-cycle", "short-more"])(
    "rejects changed pagination %s",
    async (kind) => {
      const { controller, list } = setup();
      list.mockResolvedValueOnce(page());
      await controller.submit();
      const next =
        kind === "duplicate"
          ? page(1, 1, null)
          : kind === "descending"
            ? page(2, 1, null)
            : kind === "cursor-cycle"
              ? page(26, 25, "next-page")
              : page(26, 1, "new-cursor");
      list.mockResolvedValueOnce(page()).mockResolvedValueOnce(next);
      await controller.more();
      expect(controller.getSnapshot()).toMatchObject({ page: null, phase: "unavailable" });
    },
  );
  it("bounds complete fresh collections at200 and does not request beyond the presentation cap", async () => {
    const { controller, list } = setup();
    list.mockImplementation(async (_filter, cursor) => {
      const number = cursor ? Number(cursor.slice(1)) : 0;
      return page(number * 25 + 1, 25, "p" + (number + 1));
    });
    await controller.submit();
    for (let count = 1; count < 8; count++) await controller.more();
    expect(controller.getSnapshot().page?.items).toHaveLength(200);
    expect(controller.getSnapshot().page?.hasMore).toBe(true);
    const calls = list.mock.calls.length;
    await controller.more();
    expect(list.mock.calls.length).toBe(calls);
    expect(calls).toBe(36); // each successful request batch re-verifies all desired pages
  });
});

describe("private contact context, read races and current action authority", () => {
  it.each(["query", "offline", "hidden", "detach", "invalidate", "permission", "context"])(
    "drops a late result after %s cut",
    async (kind) => {
      const pending = deferred<unknown>(),
        { controller, list, setCurrent } = setup();
      list.mockReturnValueOnce(pending.promise);
      controller.setQuery("PRIVATE_query");
      const read = controller.submit();
      const signal = list.mock.calls[0][2];
      if (kind === "query") controller.setQuery("new");
      if (kind === "offline") controller.setOnline(false);
      if (kind === "hidden") controller.setVisible(false);
      if (kind === "detach") controller.detach();
      if (kind === "invalidate") controller.invalidate();
      if (kind === "permission") controller.setPermissions(false);
      if (kind === "context") {
        setCurrent(false);
        controller.tick();
      }
      pending.resolve(page(1, 1, null));
      await read;
      expect(controller.getSnapshot().page).toBeNull();
      expect(controller.getSnapshot().refreshedAt).toBeNull();
      expect(controller.hasCurrentContact(page(1, 1, null).items[0].id)).toBe(false);
      if (kind !== "query") expect(controller.getSnapshot().query).toBe("");
      expect(signal?.aborted).toBe(true);
    },
  );
  it("accepts only the newest query generation when responses resolve out of order", async () => {
    const first = deferred<unknown>(),
      second = deferred<unknown>(),
      { controller, list } = setup();
    list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    controller.setQuery("old");
    const old = controller.submit();
    controller.setQuery("new");
    const current = controller.submit();
    second.resolve(page(2, 1, null));
    await current;
    first.resolve(page(1, 1, null));
    await old;
    expect(controller.getSnapshot().page?.items[0].id).toBe(page(2, 1, null).items[0].id);
    expect(controller.getSnapshot().appliedQuery).toBe("new");
  });
  it.each([401, 403])(
    "clears source/query on HTTP%d and cannot revive through local refresh/permissions",
    async (status) => {
      const { controller, list, revoked } = setup();
      controller.setQuery("PRIVATE");
      list.mockRejectedValueOnce(new ApiError(status, "PRIVATE_denial"));
      await controller.submit();
      expect(controller.getSnapshot()).toMatchObject({
        phase: "denied",
        canRead: false,
        page: null,
        query: "",
      });
      expect(revoked).toHaveBeenCalledTimes(1);
      controller.setPermissions(true);
      controller.attach();
      controller.setOnline(true);
      await controller.refresh();
      expect(list).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().canRead).toBe(false);
    },
  );
  it.each([404, 422, 503])(
    "keeps HTTP%d unavailable retryable without claiming current authority lost",
    async (status) => {
      const { controller, list, revoked } = setup();
      list.mockRejectedValueOnce(new ApiError(status, "PRIVATE"));
      await controller.submit();
      expect(controller.getSnapshot()).toMatchObject({ phase: "unavailable", canRead: true, page: null });
      expect(revoked).not.toHaveBeenCalled();
      await controller.refresh();
      expect(controller.getSnapshot().phase).toBe("ready");
    },
  );
  it("keeps invalid immutable member/scope denied despite permission renewal", async () => {
    for (const options of [{ member: "invalid" }, { scope: "invalid" as ContactsSearchScope }]) {
      const { controller, list } = setup(options);
      controller.setPermissions(true);
      await controller.refresh();
      expect(list).not.toHaveBeenCalled();
      expect(controller.getSnapshot().canRead).toBe(false);
    }
  });
  it("supports StrictMode attach after detach but does not resurrect old private reads", async () => {
    const pending = deferred<unknown>(),
      { controller, list } = setup();
    list.mockReturnValueOnce(pending.promise);
    const first = controller.submit();
    controller.detach();
    controller.attach();
    await controller.submit();
    pending.resolve(page(2, 1, null));
    await first;
    expect(controller.getSnapshot().page?.items[0].id).toBe(page(1, 1, null).items[0].id);
  });
  it("removes a measured projection at exact freshness expiry and requires an explicit fresh read", async () => {
    const { controller, list, setClock } = setup();
    await controller.submit();
    const id = page(1, 1, null).items[0].id;
    setClock("2026-10-10T12:04:59.999Z");
    expect(controller.hasCurrentContact(id)).toBe(true);
    setClock("2026-10-10T12:05:00.000Z");
    expect(controller.hasCurrentContact(id)).toBe(false);
    controller.tick();
    expect(controller.getSnapshot()).toMatchObject({ phase: "stale", page: null });
    expect(list).toHaveBeenCalledTimes(1);
    await controller.refresh();
    expect(controller.getSnapshot().phase).toBe("ready");
    expect(list).toHaveBeenCalledTimes(2);
  });
  it.each(["bad", "2026-10-10T11:59:59.999Z"])(
    "fails current action authority closed on clock%s",
    async (clock) => {
      const { controller, setClock } = setup();
      await controller.submit();
      setClock(clock);
      expect(controller.hasCurrentContact(page(1, 1, null).items[0].id)).toBe(false);
      controller.tick();
      expect(controller.getSnapshot().page).toBeNull();
    },
  );
  it("allows only an actually loaded fresh ID and cuts retained action checks during refresh", async () => {
    const { controller, list, setCurrent } = setup();
    await controller.submit();
    const id = page(1, 1, null).items[0].id;
    expect(controller.hasCurrentContact(id.toUpperCase())).toBe(true);
    expect(controller.hasCurrentContact(page(2, 1, null).items[0].id)).toBe(false);
    const pending = deferred<unknown>();
    list.mockReturnValueOnce(pending.promise);
    const read = controller.refresh();
    expect(controller.hasCurrentContact(id)).toBe(false);
    setCurrent(false);
    pending.resolve(page(1, 1, null));
    await read;
    expect(controller.hasCurrentContact(id)).toBe(false);
  });
});
