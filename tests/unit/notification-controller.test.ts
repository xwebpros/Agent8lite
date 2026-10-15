import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotificationController,
  notificationContextBinding,
  notificationRequest,
  requireNotification,
  requireNotificationPage,
  safeNotificationHref,
  type NotificationClient,
} from "../../apps/web/components/notification-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const id = (index = 1) => `d6000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const instant = "2026-10-10T08:34:56.789Z";
const entity = (index = 1): Schema<"Notification"> => ({
  id: id(index),
  kind: "synthetic.lead.assigned",
  title: "PRIVATE_SYNTHETIC_NOTICE_" + index,
  href: "/pipeline?leadId=" + id(900),
  readAt: null,
});
const page = (start = 1, count = 1, cursor: string | null = null): Schema<"PageNotification"> => ({
  items: Array.from({ length: count }, (_, index) => entity(start + index)),
  hasMore: Boolean(cursor),
  nextCursor: cursor,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(options: { canRead?: boolean; canWrite?: boolean; online?: boolean } = {}) {
  let keys = 0,
    current = true;
  const protectedChange = vi.fn(),
    revoked = vi.fn();
  const client = {
    list: vi.fn<NotificationClient["list"]>(async () => page()),
    markRead: vi.fn<NotificationClient["markRead"]>(async (command) => ({
      ...entity(),
      id: command.notificationId,
      readAt: instant,
    })),
  };
  const controller = new NotificationController({
    binding: "private-current-member-binding",
    client,
    online: options.online ?? true,
    canRead: options.canRead ?? true,
    canWrite: options.canWrite ?? true,
    createKey: () => id(500 + ++keys),
    isCurrent: () => current,
    onProtectedChange: protectedChange,
    onAccessRevoked: revoked,
  });
  return {
    controller,
    client,
    protectedChange,
    revoked,
    keys: () => keys,
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("member notification state and bounded pagination", () => {
  it("distinguishes unread from a successfully empty list and unavailable reads", async () => {
    const { controller, client } = setup();
    expect(controller.getSnapshot().page).toBeNull();
    client.list.mockResolvedValueOnce(page(1, 0));
    await controller.loadPage();
    expect(controller.getSnapshot().page).toEqual(page(1, 0));
    client.list.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_FAILURE"));
    await controller.loadPage();
    expect(controller.getSnapshot()).toMatchObject({ page: null, phase: "unavailable", reading: false });
    expect(controller.getSnapshot().error).not.toContain("PRIVATE_PROVIDER_FAILURE");
  });
  it("accepts detached frozen exact rows and never marks an absent or alreadyread row", async () => {
    const { controller, client, keys } = setup();
    const response = page();
    client.list.mockResolvedValueOnce(response);
    await controller.loadPage();
    response.items[0].title = "Later mutation";
    expect(controller.getSnapshot().page!.items[0].title).toBe(entity().title);
    expect(Object.isFrozen(controller.getSnapshot().page!.items[0])).toBe(true);
    await controller.markRead(id(999));
    expect(client.markRead).not.toHaveBeenCalled();
    expect(keys()).toBe(0);
    await controller.markRead(id());
    await controller.markRead(id());
    expect(client.markRead).toHaveBeenCalledOnce();
    expect(keys()).toBe(1);
  });
  it("bounds retained pages at200 rows and never requests an invented cursor", async () => {
    const { controller, client } = setup();
    for (let start = 1; start <= 201; start += 50)
      client.list.mockResolvedValueOnce(page(start, 50, "cursor-" + start));
    await controller.loadPage(true);
    expect(client.list).not.toHaveBeenCalled();
    await controller.loadPage();
    await controller.loadPage(true);
    await controller.loadPage(true);
    await controller.loadPage(true);
    await controller.loadPage(true);
    expect(controller.getSnapshot().page!.items).toHaveLength(200);
    expect(client.list.mock.calls.map(([cursor]) => cursor)).toEqual([
      null,
      "cursor-1",
      "cursor-51",
      "cursor-101",
    ]);
  });
  it.each(["duplicate", "cycle"])(
    "rejects %s across successful pages and clears the old projection",
    async (kind) => {
      const { controller, client } = setup();
      client.list.mockResolvedValueOnce(page(1, 1, "cursor-a"));
      client.list.mockResolvedValueOnce(page(2, 1, "cursor-b"));
      client.list.mockResolvedValueOnce(kind === "duplicate" ? page(1) : page(3, 1, "cursor-a"));
      await controller.loadPage();
      await controller.loadPage(true);
      await controller.loadPage(true);
      expect(controller.getSnapshot()).toMatchObject({ page: null, phase: "unavailable", reading: false });
    },
  );
  it.each(["offline", "detach", "invalidate", "revoke", "permissions", "binding"])(
    "ignores a late private list after %s changes",
    async (change) => {
      const { controller, client, setCurrent } = setup(),
        read = deferred<unknown>();
      client.list.mockReturnValueOnce(read.promise);
      const running = controller.loadPage();
      if (change === "offline") controller.setOnline(false);
      if (change === "detach") controller.detach();
      if (change === "invalidate") controller.invalidate();
      if (change === "revoke") controller.revoke();
      if (change === "permissions") controller.setPermissions(false, false);
      if (change === "binding") setCurrent(false);
      read.resolve(page());
      await running;
      expect(controller.getSnapshot().page).toBeNull();
      expect(JSON.stringify(controller.getSnapshot())).not.toContain(entity().title);
    },
  );
  it("accepts only the fresh epoch after focus invalidation, not a delayed prior response", async () => {
    const { controller, client } = setup(),
      old = deferred<unknown>();
    client.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(2));
    const pending = controller.loadPage();
    controller.invalidate();
    await controller.loadPage();
    old.resolve(page());
    await pending;
    expect(controller.getSnapshot().page!.items.map((item) => item.id)).toEqual([id(2)]);
  });
  it.each([401, 403])(
    "clears all private state and calls access invalidation on read denial%d",
    async (status) => {
      const { controller, client, revoked } = setup();
      await controller.loadPage();
      client.list.mockRejectedValueOnce(new ApiError(status, "PRIVATE_AUTHORITY_DETAIL"));
      await controller.loadPage();
      expect(controller.getSnapshot()).toMatchObject({
        page: null,
        pending: null,
        canRead: false,
        canWrite: false,
        phase: "denied",
      });
      expect(revoked).toHaveBeenCalledOnce();
      expect(JSON.stringify(controller.getSnapshot())).not.toContain("PRIVATE_AUTHORITY_DETAIL");
    },
  );
  it.each([404, 503])(
    "shows source unavailable for read%d without inventing an empty list or revoking workspace",
    async (status) => {
      const { controller, client, revoked } = setup();
      client.list.mockRejectedValueOnce(new ApiError(status, "PRIVATE_SOURCE_DETAIL"));
      await controller.loadPage();
      expect(controller.getSnapshot()).toMatchObject({ page: null, phase: "unavailable", canRead: true });
      expect(revoked).not.toHaveBeenCalled();
    },
  );
});

describe("exact uncertain notification read commands", () => {
  it("waits for a valid timestamp without optimistic read state or duplicate concurrent commands", async () => {
    const { controller, client, keys, protectedChange } = setup(),
      write = deferred<unknown>();
    await controller.loadPage();
    client.markRead.mockReturnValueOnce(write.promise);
    const running = controller.markRead(id());
    expect(controller.getSnapshot()).toMatchObject({
      phase: "sending",
      pending: { notificationId: id(), idempotencyKey: id(501) },
    });
    expect(controller.getSnapshot().page!.items[0].readAt).toBeNull();
    expect(controller.isProtected()).toBe(true);
    await controller.markRead(id());
    await controller.reconcile();
    expect(client.markRead).toHaveBeenCalledOnce();
    expect(keys()).toBe(1);
    write.resolve({ ...entity(), readAt: instant });
    await running;
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", pending: null });
    expect(controller.getSnapshot().page!.items[0].readAt).toBe(instant);
    expect(protectedChange).toHaveBeenLastCalledWith(false);
  });
  it.each([
    new Error("Network acceptance unknown"),
    new ApiError(408, "Timeout after acceptance"),
    new ApiError(500, "Provider unavailable"),
    new ApiError(503, "Upstream acceptance unavailable"),
  ])(
    "keeps the original command after ambiguous failure%s and reconciles without another key",
    async (error) => {
      const { controller, client, keys } = setup();
      await controller.loadPage();
      client.markRead.mockRejectedValueOnce(error);
      await controller.markRead(id());
      const command = client.markRead.mock.calls[0][0];
      expect(controller.getSnapshot()).toMatchObject({ phase: "uncertain", pending: command });
      expect(Object.isFrozen(command)).toBe(true);
      await controller.markRead(id());
      expect(client.markRead).toHaveBeenCalledOnce();
      await controller.reconcile();
      expect(client.markRead.mock.calls[1][0]).toBe(command);
      expect(keys()).toBe(1);
      expect(controller.getSnapshot().pending).toBeNull();
    },
  );
  it.each([400, 404, 409, 422, 429])(
    "clears a known initial rejection%d but keeps an earlier ambiguous command on retry",
    async (status) => {
      const { controller, client } = setup();
      await controller.loadPage();
      client.markRead.mockRejectedValueOnce(new ApiError(status, "PRIVATE_REJECTION"));
      await controller.markRead(id());
      expect(controller.getSnapshot()).toMatchObject({ phase: "unavailable", pending: null });
      expect(controller.getSnapshot().error).not.toContain("PRIVATE_REJECTION");
      client.markRead.mockRejectedValueOnce(new Error("Unknown"));
      await controller.markRead(id());
      const command = controller.getSnapshot().pending;
      client.markRead.mockRejectedValueOnce(new ApiError(status, "Retry rejection"));
      await controller.reconcile();
      expect(controller.getSnapshot()).toMatchObject({ phase: "uncertain", pending: command });
    },
  );
  it.each([null, undefined, "", "not-an-instant"])(
    "does not accept an unconfirmed timestamp%s as successful",
    async (readAt) => {
      const { controller, client } = setup();
      await controller.loadPage();
      client.markRead.mockResolvedValueOnce({ ...entity(), readAt });
      await controller.markRead(id());
      expect(controller.getSnapshot().phase).toBe("uncertain");
      expect(controller.getSnapshot().pending).not.toBeNull();
      expect(controller.getSnapshot().page!.items[0].readAt).toBeNull();
    },
  );
  it("rejects wrong-resource or extra-field receipts while preserving the original key", async () => {
    const { controller, client } = setup();
    await controller.loadPage();
    client.markRead.mockResolvedValueOnce({ ...entity(2), readAt: instant });
    await controller.markRead(id());
    const command = controller.getSnapshot().pending;
    client.markRead.mockResolvedValueOnce({ ...entity(), readAt: instant, memberId: id(800) });
    await controller.reconcile();
    expect(controller.getSnapshot().pending).toBe(command);
    expect(controller.getSnapshot().phase).toBe("uncertain");
  });
  it.each(["offline", "detach", "invalidate"])(
    "retains the exact key through %s while clearing private projections and late receipts",
    async (change) => {
      const { controller, client, keys } = setup(),
        write = deferred<unknown>();
      await controller.loadPage();
      client.markRead.mockReturnValueOnce(write.promise);
      const running = controller.markRead(id());
      const command = controller.getSnapshot().pending;
      if (change === "offline") controller.setOnline(false);
      if (change === "detach") controller.detach();
      if (change === "invalidate") controller.invalidate();
      write.resolve({ ...entity(), readAt: instant });
      await running;
      expect(controller.getSnapshot()).toMatchObject({ page: null, phase: "uncertain", pending: command });
      if (change === "offline") controller.setOnline(true);
      if (change === "detach") controller.attach();
      await controller.reconcile();
      expect(client.markRead.mock.calls[1][0]).toBe(command);
      expect(keys()).toBe(1);
      expect(controller.getSnapshot().pending).toBeNull();
    },
  );
  it.each(["revoke", "permissions"])(
    "forgets commands and all private state after current %s denial",
    async (change) => {
      const { controller, client } = setup(),
        write = deferred<unknown>();
      await controller.loadPage();
      client.markRead.mockReturnValueOnce(write.promise);
      const running = controller.markRead(id());
      if (change === "revoke") controller.revoke();
      else controller.setPermissions(true, false);
      write.resolve({ ...entity(), readAt: instant });
      await running;
      expect(controller.getSnapshot().page).toBeNull();
      expect(controller.getSnapshot().pending).toBeNull();
      await controller.reconcile();
      expect(client.markRead).toHaveBeenCalledOnce();
    },
  );
  it.each([401, 403])(
    "revokes even an uncertain original command on current mutation denial%d",
    async (status) => {
      const { controller, client, revoked } = setup();
      await controller.loadPage();
      client.markRead.mockRejectedValueOnce(new Error("Unknown"));
      await controller.markRead(id());
      client.markRead.mockRejectedValueOnce(new ApiError(status, "PRIVATE_AUTHORITY_DETAIL"));
      await controller.reconcile();
      expect(controller.getSnapshot()).toMatchObject({ page: null, pending: null, phase: "denied" });
      expect(revoked).toHaveBeenCalledOnce();
    },
  );
  it("never starts offline, read-only, denied, detached or stale binding commands", async () => {
    for (const mode of ["offline", "readonly", "denied", "detached", "binding"]) {
      const { controller, client, keys, setCurrent } = setup();
      await controller.loadPage();
      if (mode === "offline") controller.setOnline(false);
      if (mode === "readonly") controller.setPermissions(true, false);
      if (mode === "denied") controller.revoke();
      if (mode === "detached") controller.detach();
      if (mode === "binding") setCurrent(false);
      await controller.markRead(id());
      await controller.reconcile();
      expect(client.markRead).not.toHaveBeenCalled();
      expect(keys()).toBe(0);
    }
  });
});

describe("closed notification response and request boundaries", () => {
  it.each([
    { ...entity(), id: "not-uuid" },
    { ...entity(), title: " " },
    { ...entity(), title: "x".repeat(201) },
    { ...entity(), kind: "x".repeat(256) },
    { ...entity(), kind: "bad\u0000kind" },
    { ...entity(), href: "https://elsewhere.example.test/private" },
    { ...entity(), title: "bad\uD800" },
    { ...entity(), version: 2 },
    { ...entity(), readAt: "invalid" },
  ])("rejects invalid/extra frozen metadata without fabricating a row%j", (value) => {
    expect(() => requireNotification(value)).toThrow();
  });
  it("rejects oversized, duplicate, empty-with-more and malformed pages", () => {
    for (const value of [
      page(1, 51),
      { ...page(), items: [entity(), entity()] },
      page(1, 0, "cursor"),
      { ...page(), hasMore: true },
      { ...page(), nextCursor: "private-but-no-more" },
      { ...page(), nextCursor: "x".repeat(4097) },
    ])
      expect(() => requireNotificationPage(value)).toThrow();
  });
  it("does not execute inherited optional href or serialization hooks and rejects own accessors", () => {
    let hooks = 0;
    const savedHref = Object.getOwnPropertyDescriptor(Object.prototype, "href"),
      savedObjectHook = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"),
      savedArrayHook = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const input = { id: id(), kind: "plain", title: "Exact😀 data" };
    try {
      Object.defineProperty(Object.prototype, "href", {
        configurable: true,
        get() {
          hooks++;
          return "https://private.example.test";
        },
      });
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        get() {
          hooks++;
          return () => "changed";
        },
      });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value() {
          hooks++;
          return [];
        },
      });
      const notification = requireNotification(input);
      const result = requireNotificationPage({ items: [input], hasMore: false, nextCursor: null });
      expect(Object.hasOwn(notification, "href")).toBe(false);
      expect(result.items[0].title).toBe("Exact😀 data");
      const accessor = Object.defineProperty({ ...input }, "title", {
        enumerable: true,
        get() {
          hooks++;
          return "Forged";
        },
      });
      expect(() => requireNotification(accessor)).toThrow();
      expect(hooks).toBe(0);
    } finally {
      for (const [target, key, descriptor] of [
        [Object.prototype, "href", savedHref],
        [Object.prototype, "toJSON", savedObjectHook],
        [Array.prototype, "toJSON", savedArrayHook],
      ] as const)
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
    }
  });
  it("rejects sparse/extraneous arrays and oversized response graphs", () => {
    const sparse = new Array(1),
      extra = [entity()] as Schema<"Notification">[] & { private?: string };
    extra.private = "unverified";
    for (const items of [sparse, extra])
      expect(() => requireNotificationPage({ ...page(), items })).toThrow();
    expect(() => requireNotification({ ...entity(), privatePayload: "x".repeat(256 * 1024) })).toThrow();
  });
  it("binds access revision, CSRF, membership, actor and organization without depending on grant order", () => {
    const session = {
      userId: id(601),
      activeOrgId: id(602),
      permissions: ["self.notifications.write", "self.notifications.read"],
    } as Schema<"Session">;
    const input = { session, memberId: id(603), csrf: "opaque-csrf", accessRevision: 4 };
    const original = notificationContextBinding(input);
    expect(
      notificationContextBinding({
        ...input,
        session: { ...session, permissions: [...session.permissions].reverse() },
      }),
    ).toBe(original);
    for (const changed of [
      { ...input, accessRevision: 5 },
      { ...input, csrf: "new-csrf" },
      { ...input, memberId: id(604) },
      { ...input, session: { ...session, userId: id(605) } },
      { ...input, session: { ...session, activeOrgId: id(606) } },
      { ...input, session: { ...session, permissions: ["self.notifications.read"] } },
    ])
      expect(notificationContextBinding(changed)).not.toBe(original);
  });
  it.each([
    "/",
    "/dashboard",
    "/contacts?contactId=" + id(),
    "/tasks#today",
    "/notifications",
    "/settings?panel=profile",
  ])("allows an explicit safe member view%s", (href) => {
    expect(safeNotificationHref(href)).toBe(href);
  });
  it.each([
    "//outside.example.test",
    "https://outside.example.test",
    "javascript:alert(1)",
    "/api/v1/session",
    "/dev/session",
    "/login",
    "/pipeline/../settings",
    "/pipeline/%2e%2e/settings",
    "/tasks%2fprivate",
    "/tasks\\private",
    "/tasks?token=%250a",
    "/tasks?x=%0A",
    "/tasks?x=%20bad",
    "/tasks?x=%zz",
    "/tasks ",
  ])("denies executable, traversal or unsafe links%s", (href) => {
    expect(safeNotificationHref(href)).toBeNull();
  });
  it("uses private same-origin bounded transport with no body/revision added and no redirected request", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(entity()), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await notificationRequest(
        "/v1/orgs/" + id(700) + "/notifications/" + id() + "/read",
        { method: "POST", headers: { "Idempotency-Key": id(701), "X-CSRF-Token": "opaque" } },
        201,
      ),
    ).toEqual(entity());
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(options).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(options.body).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(options.headers).has("if-match")).toBe(false);
  });
  it.each([401, 403])(
    "preserves actual HTTP denial%d even if problem body is malformed and private",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("PRIVATE_NOT_A_PROBLEM", { status })),
      );
      await expect(notificationRequest("/v1/orgs/" + id(700) + "/notifications")).rejects.toMatchObject({
        status,
        message: "The notification request could not be completed.",
      });
    },
  );
  it("rejects unexpected success status, invalid UTF8 and response streams beyond the byte cap", async () => {
    for (const response of [
      new Response(JSON.stringify(page()), { status: 202 }),
      new Response(new Uint8Array([0xc0, 0xaf]), { status: 200 }),
      new Response("x".repeat(256 * 1024 + 1), { status: 200 }),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      await expect(notificationRequest("/v1/orgs/" + id(700) + "/notifications")).rejects.toThrow();
    }
  });
});
