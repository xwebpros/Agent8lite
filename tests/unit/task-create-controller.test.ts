import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskCreateProtocol,
  taskCreateRequest,
  taskCreateEligible,
  taskCreateBodyLimit,
  type TaskCreateCurrent,
} from "../../apps/web/components/task-create";
import { ApiError, type Schema } from "../../apps/web/lib/api";
const org = "fb000000-0000-4000-8000-000000000001",
  member = "fb000000-0000-4000-8000-000000000002",
  key = "fb000000-0000-4000-8000-000000000003",
  id = "fb000000-0000-4000-8000-000000000004",
  binding = "verified-user/org/member/csrf/access/grants";
function setup() {
  const protocol = new TaskCreateProtocol();
  protocol.bind(binding);
  const body: Schema<"TaskWrite"> = {
    title: " Original ",
    assigneeMemberId: member,
    dueAt: "2026-10-11T12:00:00.000Z",
    timezone: "UTC",
  };
  return { protocol, body, command: protocol.begin(body, key) };
}
const receipt = () => ({
  id,
  title: "Original",
  assigneeMemberId: member,
  dueAt: "2026-10-11T12:00:00.000Z",
  timezone: "UTC",
  priority: "normal",
  state: "open",
  version: 1,
});
const ok = (status = 201) => new Response(JSON.stringify(receipt()), { status, headers: { etag: '"1"' } });
function current(patch: Partial<TaskCreateCurrent> = {}): TaskCreateCurrent {
  return {
    binding,
    active: true,
    online: true,
    visible: true,
    changingOrganization: false,
    busy: false,
    loading: false,
    detailLoading: false,
    modal: "task",
    otherProtected: false,
    ...patch,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("exact Task POST transport and safe outcome state", () => {
  it("dispatches captured bytes/key/CSRF without If-Match and does not auto-refresh or replace current Task", async () => {
    const value = setup(),
      pending = deferred<Response>(),
      fetcher = vi.fn<typeof fetch>(() => pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const request = taskCreateRequest(org, value.command, "synthetic-csrf");
    value.body.title = "later";
    value.body.dueAt = "2026-10-12T12:00:00.000Z";
    pending.resolve(ok());
    const result = await request;
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/v1/orgs/${org}/tasks`);
    expect(options).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: value.command.serializedBody,
    });
    const headers = new Headers(options?.headers);
    expect(headers.get("idempotency-key")).toBe(key);
    expect(headers.get("x-csrf-token")).toBe("synthetic-csrf");
    expect(headers.has("if-match")).toBe(false);
    expect(value.protocol.acknowledge(value.command, result.data, result.etag)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([200, 202, 204])("unexpected successful %s retains unknown original command", async (status) => {
    const value = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => (status === 204 ? new Response(null, { status }) : ok(status))),
    );
    const error = await taskCreateRequest(org, value.command, "csrf").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(value.protocol.reject(value.command, error)).toBe("unknown");
  });
  it.each([401, 403, 408, 409, 412, 422, 429, 500, 503])(
    "HTTP %s preserves denial despite malformed private Problem text",
    async (status) => {
      const value = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response("PRIVATE_PROVIDER_TEXT", { status })),
      );
      const error = await taskCreateRequest(org, value.command, "csrf").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status });
      expect((error as Error).message).not.toContain("PRIVATE_PROVIDER_TEXT");
    },
  );
  it("receipt_expired remains unknown after a prior ambiguous outcome", async () => {
    const value = setup();
    value.protocol.reject(value.command, new TypeError("interrupted"));
    value.protocol.retry();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              type: "about:blank",
              title: "safe",
              status: 409,
              detail: "PRIVATE_DESCRIPTION",
              code: "receipt_expired",
              traceId: "synthetic",
            }),
            { status: 409 },
          ),
      ),
    );
    const error = await taskCreateRequest(org, value.command, "csrf").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 409, code: "receipt_expired" });
    expect(value.protocol.reject(value.command, error)).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it.each(["json", "utf8", "ascii-limit", "utf8-limit"])(
    "unverified successful %s cannot release recovery",
    async (kind) => {
      const value = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () =>
            new Response(
              kind === "json"
                ? "{"
                : kind === "utf8"
                  ? new Uint8Array([0xc3, 0x28])
                  : JSON.stringify({
                      secret: (kind === "utf8-limit" ? "😀" : "a").repeat(taskCreateBodyLimit),
                    }),
              { status: 201 },
            ),
        ),
      );
      const error = await taskCreateRequest(org, value.command, "csrf").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(value.protocol.reject(value.command, error)).toBe("unknown");
      expect(value.protocol.retry()).toBe(value.command);
    },
  );
  it.each(["not-uuid", "", "/../../tasks"])(
    "invalid organization %s cannot reach fetch",
    async (organization) => {
      const value = setup(),
        fetcher = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetcher);
      await expect(taskCreateRequest(organization, value.command, "csrf")).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("serialized-body mismatch refuses dispatch under original key", async () => {
    const value = setup(),
      fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      taskCreateRequest(org, { ...value.command, serializedBody: '{"title":"different"}' }, "csrf"),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("twenty-second timeout aborts its own request and keeps immutable recovery", async () => {
    vi.useFakeTimers();
    const value = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("safe abort")), { once: true });
          }),
      ),
    );
    const request = taskCreateRequest(org, value.command, "csrf").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20000);
    expect(value.protocol.reject(value.command, await request)).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it("late201 cannot acknowledge an old context after organization or access replacement", async () => {
    const value = setup(),
      pending = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => pending.promise),
    );
    const request = taskCreateRequest(org, value.command, "csrf");
    value.protocol.bind("replacement context");
    pending.resolve(ok());
    const result = await request;
    expect(value.protocol.acknowledge(value.command, result.data, result.etag)).toBe(false);
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "idle" });
  });
});
describe("live Task creation callback guards", () => {
  it.each([
    { binding: "replacement" },
    { active: false },
    { online: false },
    { visible: false },
    { changingOrganization: true },
    { busy: true },
    { loading: true },
    { detailLoading: true },
    { modal: null },
    { modal: "lead" },
    { otherProtected: true },
  ] satisfies Partial<TaskCreateCurrent>[])("current cut %j blocks a retained action", (patch) => {
    expect(taskCreateEligible(binding, current(patch))).toBe(false);
  });
  it("current eligible flags cannot revive the protocol's own cleared authority", () => {
    const value = setup();
    expect(taskCreateEligible(binding, current())).toBe(true);
    value.protocol.bind(null);
    expect(value.protocol.isBoundTo(binding)).toBe(false);
    expect(() => value.protocol.retry()).toThrow();
  });
  it("accessor current online flag fails closed with zero getter calls", () => {
    let calls = 0;
    const state = current();
    Object.defineProperty(state, "online", {
      enumerable: true,
      get: () => {
        calls++;
        return true;
      },
    });
    expect(taskCreateEligible(binding, state)).toBe(false);
    expect(calls).toBe(0);
  });
});
