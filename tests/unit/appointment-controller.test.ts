import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppointmentController,
  appointmentContextBinding,
  appointmentRequest,
  formatAppointmentInstant,
  requireAppointment,
  requireAppointmentPage,
  validAppointmentTimezone,
  type AppointmentClient,
} from "../../apps/web/components/appointment-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const id = (index = 1) => `d8000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function appointment(index = 1): Schema<"Appointment"> {
  return {
    id: id(index),
    leadId: id(800),
    startsAt: "2026-11-01T08:30:00.000Z",
    endsAt: "2026-11-01T09:30:00.000Z",
    timezone: "America/Los_Angeles",
    state: "scheduled",
  };
}
function page(start = 1, count = 1, cursor: string | null = null): Schema<"PageAppointment"> {
  return {
    items: Array.from({ length: count }, (_, index) => appointment(start + index)),
    nextCursor: cursor,
    hasMore: Boolean(cursor),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
function setup(options: { canRead?: boolean; online?: boolean } = {}) {
  let current = true;
  const revoked = vi.fn();
  const client = { list: vi.fn<AppointmentClient["list"]>(async () => page()) };
  const controller = new AppointmentController({
    binding: "private-member-agenda-binding",
    client,
    online: options.online ?? true,
    canRead: options.canRead ?? true,
    isCurrent: () => current,
    onAccessRevoked: revoked,
  });
  return {
    controller,
    client,
    revoked,
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bounded stored appointment controller", () => {
  it("distinguishes not-yet-read, verified empty and unavailable without inferring calendar activity", async () => {
    const { controller, client } = setup();
    expect(controller.getSnapshot()).toMatchObject({ page: null, refreshedAt: null, phase: "idle" });
    client.list.mockResolvedValueOnce(page(1, 0));
    await controller.loadPage();
    expect(controller.getSnapshot().page).toEqual(page(1, 0));
    expect(controller.getSnapshot().refreshedAt).toMatch(/Z$/);
    client.list.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_FAILURE"));
    await controller.loadPage();
    expect(controller.getSnapshot()).toMatchObject({
      page: null,
      phase: "unavailable",
      reading: false,
      refreshedAt: null,
    });
    expect(controller.getSnapshot().error).not.toContain("PRIVATE_PROVIDER_FAILURE");
  });
  it("detaches and freezes source rows before exposing them to consumers", async () => {
    const { controller, client } = setup(),
      response = page();
    client.list.mockResolvedValueOnce(response);
    await controller.loadPage();
    response.items[0].timezone = "UTC";
    expect(controller.getSnapshot().page!.items[0].timezone).toBe("America/Los_Angeles");
    expect(Object.isFrozen(controller.getSnapshot().page!.items[0])).toBe(true);
    expect(Object.isFrozen(controller.getSnapshot().page!.items)).toBe(true);
  });
  it("requests only supplied cursors and stops at200 loaded rows", async () => {
    const { controller, client } = setup();
    for (let start = 1; start <= 201; start += 25)
      client.list.mockResolvedValueOnce(page(start, 25, "cursor-" + start));
    await controller.loadPage(true);
    expect(client.list).not.toHaveBeenCalled();
    await controller.loadPage();
    for (let index = 0; index < 9; index++) await controller.loadPage(true);
    expect(controller.getSnapshot().page!.items).toHaveLength(200);
    expect(client.list).toHaveBeenCalledTimes(8);
    expect(client.list.mock.calls.map(([cursor]) => cursor)).toEqual([
      null,
      "cursor-1",
      "cursor-26",
      "cursor-51",
      "cursor-76",
      "cursor-101",
      "cursor-126",
      "cursor-151",
    ]);
  });
  it.each(["duplicate", "regression", "cycle"])(
    "clears inconsistent %s pages rather than retaining a partial authorized-looking agenda",
    async (kind) => {
      const { controller, client } = setup();
      client.list.mockResolvedValueOnce(page(5, 1, "cursor-a")).mockResolvedValueOnce(page(6, 1, "cursor-b"));
      client.list.mockResolvedValueOnce(
        kind === "duplicate" ? page(6) : kind === "regression" ? page(1) : page(7, 1, "cursor-a"),
      );
      await controller.loadPage();
      await controller.loadPage(true);
      await controller.loadPage(true);
      expect(controller.getSnapshot()).toMatchObject({ page: null, phase: "unavailable", reading: false });
    },
  );
  it.each(["offline", "hidden", "detach", "invalidate", "revoke", "permissions", "binding"])(
    "rejects late sensitive rows after %s changes and aborts reads where actively invalidated",
    async (change) => {
      const { controller, client, setCurrent } = setup(),
        response = deferred<unknown>();
      client.list.mockReturnValueOnce(response.promise);
      const pending = controller.loadPage();
      const signal = client.list.mock.calls[0][1]!;
      if (change === "offline") controller.setOnline(false);
      if (change === "hidden") controller.setVisible(false);
      if (change === "detach") controller.detach();
      if (change === "invalidate") controller.invalidate();
      if (change === "revoke") controller.revoke();
      if (change === "permissions") controller.setPermissions(false);
      if (change === "binding") setCurrent(false);
      if (change !== "binding") expect(signal.aborted).toBe(true);
      response.resolve(page());
      await pending;
      expect(controller.getSnapshot().page).toBeNull();
      expect(controller.getSnapshot().refreshedAt).toBeNull();
    },
  );
  it("allows only the fresh epoch following focus invalidation", async () => {
    const { controller, client } = setup(),
      old = deferred<unknown>();
    client.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(2));
    const first = controller.loadPage();
    controller.invalidate();
    await controller.loadPage();
    old.resolve(page());
    await first;
    expect(controller.getSnapshot().page!.items.map((item) => item.id)).toEqual([id(2)]);
  });
  it("starts fresh after hidden/offline and StrictMode detach without resuming a private cursor", async () => {
    const { controller, client } = setup();
    client.list.mockResolvedValue(page(1, 1, "private-cursor"));
    await controller.loadPage();
    controller.setVisible(false);
    await controller.loadPage();
    controller.setVisible(true);
    await controller.loadPage();
    controller.setOnline(false);
    await controller.loadPage();
    controller.setOnline(true);
    await controller.loadPage();
    controller.detach();
    controller.attach();
    await controller.loadPage();
    expect(client.list.mock.calls.map(([cursor]) => cursor)).toEqual([null, null, null, null]);
  });
  it.each([401, 403])(
    "treats current HTTP%s as access loss and cannot reattach revoked rows",
    async (status) => {
      const { controller, client, revoked } = setup();
      await controller.loadPage();
      client.list.mockRejectedValueOnce(new ApiError(status, "PRIVATE_DENIAL", "permission_denied"));
      await controller.loadPage();
      expect(controller.getSnapshot()).toMatchObject({
        page: null,
        canRead: false,
        phase: "denied",
        reading: false,
      });
      expect(revoked).toHaveBeenCalledOnce();
      controller.attach();
      controller.setPermissions(true);
      await controller.loadPage();
      expect(client.list).toHaveBeenCalledTimes(2);
    },
  );
  it.each([404, 408, 429, 503])(
    "treats HTTP%s as unavailable, preserving authority to make a new fresh read",
    async (status) => {
      const { controller, client, revoked } = setup();
      client.list.mockRejectedValueOnce(new ApiError(status, "PRIVATE_SOURCE", "source_unavailable"));
      await controller.loadPage();
      expect(controller.getSnapshot()).toMatchObject({ page: null, canRead: true, phase: "unavailable" });
      expect(revoked).not.toHaveBeenCalled();
      await controller.loadPage();
      expect(controller.getSnapshot().page).not.toBeNull();
    },
  );
  it("does not fetch while offline, hidden or permission-denied", async () => {
    for (const options of [{ online: false }, { canRead: false }]) {
      const { controller, client } = setup(options);
      await controller.loadPage();
      expect(client.list).not.toHaveBeenCalled();
    }
    const { controller, client } = setup();
    controller.setVisible(false);
    await controller.loadPage();
    expect(client.list).not.toHaveBeenCalled();
  });
  it("updates subscribers only until unsubscribed and exposes no mutation command", async () => {
    const { controller } = setup(),
      listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    await controller.loadPage();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    const count = listener.mock.calls.length;
    controller.invalidate();
    expect(listener).toHaveBeenCalledTimes(count);
    expect("cancel" in controller).toBe(false);
    expect("create" in controller).toBe(false);
  });
});

describe("closed appointment metadata and exact timezone presentation", () => {
  it.each(["scheduled", "cancelled", "completed"] as const)(
    "accepts stored %s without deriving state from the clock",
    (state) => {
      const entity = { ...appointment(), state };
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      expect(requireAppointment(entity).state).toBe(state);
    },
  );
  it.each([
    { id: "not-a-uuid" },
    { leadId: "" },
    { startsAt: "2026-11-01T01:30:00-07:00" },
    { startsAt: "2026-11-01T08:30:00Z" },
    { startsAt: "invalid" },
    { endsAt: "2026-11-01T08:30:00.000Z" },
    { endsAt: "2026-11-01T08:29:59.999Z" },
    { timezone: "+07:00" },
    { timezone: "PST" },
    { timezone: "PRIVATE_INVALID_ZONE" },
    { state: "rescheduled" },
    { providerEventId: "PRIVATE_PROVIDER_ID" },
    { connectionId: id(900) },
  ])("rejects invalid/extra source metadata%s", (patch) => {
    expect(() => requireAppointment({ ...appointment(), ...patch })).toThrow();
  });
  it("rejects hooks, nonown required fields and extraneous/sparse array data with zero getter execution", () => {
    let hooks = 0;
    const getter = Object.defineProperty(appointment(), "timezone", {
      enumerable: true,
      get() {
        hooks++;
        return "UTC";
      },
    });
    const hook = {
      ...appointment(),
      toJSON() {
        hooks++;
        return appointment();
      },
    };
    expect(() => requireAppointment(getter)).toThrow();
    expect(() => requireAppointment(hook)).toThrow();
    const inherited = Object.create(appointment());
    expect(() => requireAppointment(inherited)).toThrow();
    const sparse = page();
    delete sparse.items[0];
    expect(() => requireAppointmentPage(sparse)).toThrow();
    const extra = page();
    Object.defineProperty(extra.items, "private", { value: "hidden", enumerable: true });
    expect(() => requireAppointmentPage(extra)).toThrow();
    expect(hooks).toBe(0);
  });
  it("does not invoke inherited serialization or fill required fields from prototype data", () => {
    let hooks = 0;
    const previousObject = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const previousArray = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const previousTimezone = Object.getOwnPropertyDescriptor(Object.prototype, "timezone");
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        get() {
          hooks++;
          return () => {
            hooks++;
            return null;
          };
        },
      });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        get() {
          hooks++;
          return () => {
            hooks++;
            return null;
          };
        },
      });
      const valid = requireAppointmentPage(page());
      expect(valid.items[0].timezone).toBe("America/Los_Angeles");
      Object.defineProperty(Object.prototype, "timezone", { configurable: true, value: "UTC" });
      const missing = { ...appointment() } as Partial<Schema<"Appointment">>;
      delete missing.timezone;
      expect(() => requireAppointment(missing)).toThrow();
      expect(hooks).toBe(0);
    } finally {
      for (const [target, key, descriptor] of [
        [Object.prototype, "toJSON", previousObject],
        [Array.prototype, "toJSON", previousArray],
        [Object.prototype, "timezone", previousTimezone],
      ] as const) {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
      }
    }
  });
  it.each([
    { ...page(), nextCursor: "", hasMore: true },
    { ...page(1, 0), hasMore: true, nextCursor: "x" },
    { ...page(), nextCursor: "x", hasMore: false },
    { ...page(), nextCursor: "x".repeat(4097), hasMore: true },
    page(1, 26),
    { ...page(), items: [appointment(2), appointment(1)] },
    { ...page(), items: [appointment(), appointment()] },
    { ...page(), total: 1000 },
  ])("rejects incoherent, overlarge or unordered pages%s", (body) =>
    expect(() => requireAppointmentPage(body)).toThrow(),
  );
  it("formats the Los Angeles spring gap using actual UTC time and offsets", () => {
    expect(formatAppointmentInstant("2026-03-08T09:59:00.000Z", "America/Los_Angeles")).toContain(
      "01:59 GMT-8",
    );
    expect(formatAppointmentInstant("2026-03-08T10:00:00.000Z", "America/Los_Angeles")).toContain(
      "03:00 GMT-7",
    );
    expect(
      new Date("2026-03-08T10:30:00.000Z").getTime() - new Date("2026-03-08T09:30:00.000Z").getTime(),
    ).toBe(60 * 60 * 1000);
  });
  it("distinguishes both Los Angeles fall overlap occurrences and explicitly different user/org zones", () => {
    expect(formatAppointmentInstant("2026-11-01T08:30:00.000Z", "America/Los_Angeles")).toContain(
      "01:30 GMT-7",
    );
    expect(formatAppointmentInstant("2026-11-01T09:30:00.000Z", "America/Los_Angeles")).toContain(
      "01:30 GMT-8",
    );
    expect(formatAppointmentInstant("2026-11-01T08:30:00.000Z", "America/New_York")).toContain("03:30 GMT-5");
    expect(formatAppointmentInstant("2026-11-01T08:30:00.000Z", "UTC")).toContain("08:30 GMT");
  });
  it.each(["UTC", "America/Los_Angeles", "US/Pacific", "Etc/GMT+5", "Asia/Bangkok"])(
    "permits supported named source zone%s without silently renaming it",
    (zone) => expect(validAppointmentTimezone(zone)).toBe(true),
  );
  it.each(["", "PST", "+07:00", "UTC+7", "PRIVATE_INVALID_ZONE", "x".repeat(81), undefined, null])(
    "never substitutes workstation time for invalid zone%s",
    (zone) => {
      expect(validAppointmentTimezone(zone)).toBe(false);
      expect(formatAppointmentInstant(appointment().startsAt, zone)).toBeNull();
    },
  );
  it("returns unavailable formatting if the runtime formatter fails without leaking its error", () => {
    const original = Intl.DateTimeFormat;
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: class {
        constructor() {
          throw new Error("PRIVATE_INTL");
        }
      },
    });
    expect(formatAppointmentInstant(appointment().startsAt, "UTC")).toBeNull();
    expect(original).toBeTypeOf("function");
  });
  it("rejects hostile or nonstring instant inputs without coercion", () => {
    let hooks = 0;
    const hostile = {
      toString() {
        hooks++;
        return appointment().startsAt;
      },
      valueOf() {
        hooks++;
        return 0;
      },
    };
    for (const input of [hostile, null, undefined, 0, false, "PRIVATE_INVALID_INSTANT"]) {
      expect(formatAppointmentInstant(input, "UTC")).toBeNull();
    }
    expect(hooks).toBe(0);
  });
  it("changes private bindings on identity/member/org/access/permission differences, not permission order", () => {
    const session = {
      userId: id(801),
      activeOrgId: id(802),
      permissions: ["appointments.read", "crm.leads.read"],
    } as Schema<"Session">;
    const input = { session, memberId: id(803), accessRevision: 1 },
      binding = appointmentContextBinding(input);
    expect(
      appointmentContextBinding({
        ...input,
        session: { ...session, permissions: [...session.permissions].reverse() },
      }),
    ).toBe(binding);
    for (const changed of [
      { ...input, memberId: id(804) },
      { ...input, accessRevision: 2 },
      { ...input, session: { ...session, activeOrgId: id(805) } },
      { ...input, session: { ...session, userId: id(806) } },
      { ...input, session: { ...session, permissions: ["appointments.read"] } },
    ])
      expect(appointmentContextBinding(changed)).not.toBe(binding);
  });
});

describe("private read-only appointment transport", () => {
  it("uses the exact frozen GET with no commands, body, date or wider-owner filters", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(page()));
    vi.stubGlobal("fetch", fetch);
    await appointmentRequest(id(801), "opaque+=cursor");
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/v1/orgs/" + id(801) + "/appointments?limit=25&cursor=opaque%2B%3Dcursor",
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(fetch.mock.calls[0][1]).not.toHaveProperty("body");
  });
  it.each([401, 403, 503])("preserves actual HTTP%s on malformed problem responses", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("PRIVATE_BAD_PROBLEM", { status })),
    );
    await expect(appointmentRequest(id(801))).rejects.toMatchObject({
      status,
      code: "appointments_request_failed",
    });
  });
  it("bounds actual UTF8 bytes and cancels an oversized successful response", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("😀".repeat(70000)));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    await expect(appointmentRequest(id(801))).rejects.toThrow("private memory limit");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels the transport on supplied abort and enforces its own20s deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });
          }),
      ),
    );
    const abort = new AbortController(),
      supplied = appointmentRequest(id(801), null, abort.signal);
    const suppliedExpectation = expect(supplied).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await suppliedExpectation;
    const timed = appointmentRequest(id(801)),
      deadlineExpectation = expect(timed).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(20000);
    await deadlineExpectation;
  });
  it("rejects malformed organization/cursor before network activity", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(appointmentRequest("not-org")).rejects.toThrow();
    await expect(appointmentRequest(id(801), "")).rejects.toThrow();
    await expect(appointmentRequest(id(801), "x".repeat(4097))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
