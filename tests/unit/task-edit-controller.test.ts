import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskEditProtocol,
  taskEditContext,
  taskEditReadContext,
  taskEditEligible,
  taskEditRequest,
  taskEditBodyLimit,
  type TaskEditCurrent,
} from "../../apps/web/components/task-edit";
import {
  readTaskEditTask,
  taskEditReadGuard,
  taskEditReadFailureDisposition,
} from "../../apps/web/components/task-edit-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";
const org = "db000000-0000-4000-8000-000000000001",
  id = "db000000-0000-4000-8000-000000000002",
  member = "db000000-0000-4000-8000-000000000003",
  key = "db000000-0000-4000-8000-000000000004",
  lead = "db000000-0000-4000-8000-000000000005",
  binding = "verified-task-binding";
const task = (): Schema<"Task"> => ({
  id,
  assigneeMemberId: member,
  leadId: lead,
  title: "Original title",
  description: "Private original",
  dueAt: "2026-11-01T09:30:00.123Z",
  timezone: "US/Pacific",
  priority: "high",
  state: "open",
  version: 1,
});
const body = (): Schema<"TaskWrite"> => ({
  assigneeMemberId: member,
  title: " Edited title ",
  dueAt: task().dueAt,
  timezone: task().timezone,
  state: "done",
});
const receipt = () => ({ ...task(), title: "Edited title", state: "done" as const, version: 2 });
function setup() {
  const protocol = new TaskEditProtocol();
  protocol.bind(binding);
  const input = body(),
    command = protocol.begin({ task: task(), body: input }, key);
  return { protocol, input, command };
}
const response = (data: unknown = receipt(), status = 200, etag: string | null = '"2"') =>
  new Response(JSON.stringify(data), { status, headers: etag ? { etag } : {} });
const current = (patch: Partial<TaskEditCurrent> = {}): TaskEditCurrent => ({
  binding,
  active: true,
  online: true,
  visible: true,
  changingOrganization: false,
  busy: false,
  loading: false,
  detailLoading: false,
  dirty: false,
  otherProtected: false,
  taskId: id,
  ...patch,
});
function session(permissions: string[]): Schema<"Session"> {
  return {
    userId: member,
    activeOrgId: org,
    organizations: [],
    permissions,
    profile: { displayName: "Synthetic", timezone: "UTC" },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("verified write binding and retained callback eligibility", () => {
  it("write-only gate does not invent Task/Lead read prerequisites", () => {
    const s = session(["crm.tasks.write"]);
    expect(taskEditContext({ session: s, memberId: member, csrf: "csrf", accessRevision: 1 })).toBeTypeOf(
      "string",
    );
    expect(taskEditReadContext({ session: s, memberId: member, csrf: "csrf", accessRevision: 1 })).toBeNull();
  });
  it("read gate is separate and context contains permission/access/CSRF identity", () => {
    const base = {
        session: session(["crm.tasks.write", "crm.tasks.read"]),
        memberId: member,
        csrf: "csrf",
        accessRevision: 1,
      },
      first = taskEditContext(base);
    expect(taskEditReadContext(base)).toBeTypeOf("string");
    for (const patch of [
      { csrf: "rotated" },
      { accessRevision: 2 },
      { memberId: lead },
      { session: session(["crm.tasks.write"]) },
    ])
      expect(taskEditContext({ ...base, ...patch })).not.toBe(first);
  });
  it.each([
    { binding: "old" },
    { active: false },
    { online: false },
    { visible: false },
    { changingOrganization: true },
    { busy: true },
    { loading: true },
    { detailLoading: true },
    { dirty: true },
    { otherProtected: true },
    { taskId: lead },
  ])("retained callback cut %j cannot begin/send", (patch) =>
    expect(taskEditEligible(binding, current(patch), id)).toBe(false),
  );
  it("eligible exact drawer accepts case-normalized identity only", () => {
    expect(taskEditEligible(binding, current({ taskId: id.toUpperCase() }), id)).toBe(true);
    expect(taskEditEligible(null, current(), id)).toBe(false);
  });
});
describe("read authority survives display cuts but never old source/binding", () => {
  const ticket = { binding, taskId: id, generation: 2 },
    live = {
      binding,
      taskId: id,
      generation: 2,
      active: true,
      online: true,
      visible: true,
      changingOrganization: false,
    };
  it.each([{ online: false }, { visible: false }, { changingOrganization: true }])(
    "current %j display cut still obeys known access/source loss",
    (patch) => {
      const state = { ...live, ...patch };
      expect(taskEditReadGuard(ticket, state)).toEqual({ authorityCurrent: true, displayCurrent: false });
      expect(taskEditReadFailureDisposition(ticket, state, 401)).toBe("access-denied");
      expect(taskEditReadFailureDisposition(ticket, state, 403)).toBe("access-denied");
      expect(taskEditReadFailureDisposition(ticket, state, 404)).toBe("source-unavailable");
    },
  );
  it.each([{ binding: "old" }, { taskId: lead }, { generation: 3 }, { active: false }, { binding: null }])(
    "stale %j response can neither cut current private authority nor install data",
    (patch) => {
      const state = { ...live, ...patch };
      expect(taskEditReadGuard(ticket, state)).toEqual({ authorityCurrent: false, displayCurrent: false });
      expect(taskEditReadFailureDisposition(ticket, state, 403)).toBe("ignore");
      expect(taskEditReadFailureDisposition(ticket, state, 404)).toBe("ignore");
    },
  );
  it("current named source matches case-insensitive UUID and permits verified display", () => {
    expect(taskEditReadGuard(ticket, { ...live, taskId: id.toUpperCase() })).toEqual({
      authorityCurrent: true,
      displayCurrent: true,
    });
  });
  it("hostile read-current accessor has zero side effects and no authority", () => {
    let calls = 0;
    const state = { ...live };
    Object.defineProperty(state, "online", {
      enumerable: true,
      get() {
        calls++;
        return true;
      },
    });
    expect(taskEditReadGuard(ticket, state)).toEqual({ authorityCurrent: false, displayCurrent: false });
    expect(calls).toBe(0);
  });
});
describe("exact immutable PATCH transport and safe uncertainty", () => {
  it("sends exact original bytes/key/IfMatch and no-store without automatic current refresh", async () => {
    const v = setup(),
      fetcher = vi.fn<typeof fetch>(async () => response());
    vi.stubGlobal("fetch", fetcher);
    v.input.title = "later";
    const result = await taskEditRequest(org, v.command, "synthetic-csrf");
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/v1/orgs/${org}/tasks/${id}`);
    expect(options).toMatchObject({
      method: "PATCH",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: v.command.serializedBody,
    });
    const headers = new Headers(options?.headers);
    expect(headers.get("if-match")).toBe('"1"');
    expect(headers.get("idempotency-key")).toBe(key);
    expect(headers.get("x-csrf-token")).toBe("synthetic-csrf");
    expect(v.protocol.acknowledge(v.command, result.data, result.etag)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("historical ACK remains ACK when separate authorized current GET is now unavailable", async () => {
    const v = setup();
    expect(v.protocol.acknowledge(v.command, receipt(), '"2"')).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("PRIVATE_SOURCE", { status: 404 })),
    );
    await expect(readTaskEditTask(org, id)).rejects.toMatchObject({ status: 404 });
    expect(v.protocol.getSnapshot()).toEqual({ command: null, phase: "acknowledged" });
  });
  it.each([201, 202, 204])("unexpected successful %s stays unknown", async (status) => {
    const v = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        status === 204 ? new Response(null, { status }) : response({}, status),
      ),
    );
    const error = await taskEditRequest(org, v.command, "csrf").catch((e: unknown) => e);
    expect(v.protocol.reject(v.command, error)).toBe("unknown");
  });
  it.each([401, 403])("malformed/private %s denial remains authoritative", async (status) => {
    const v = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("PRIVATE_PROVIDER", { status })),
    );
    const error = await taskEditRequest(org, v.command, "csrf").catch((e: unknown) => e);
    expect(error).toMatchObject({ status });
    expect((error as Error).message).not.toContain("PRIVATE");
    expect(v.protocol.reject(v.command, error)).toBe("cleared");
    expect(v.protocol.getSnapshot().phase).toBe("denied");
  });
  it.each([400, 404, 409, 412, 422, 429])(
    "unverifiable nonauth %s response cannot prove nonexecution",
    async (status) => {
      const v = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response("PRIVATE_PROVIDER", { status })),
      );
      const error = await taskEditRequest(org, v.command, "csrf").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ApiError);
      expect(v.protocol.reject(v.command, error)).toBe("unknown");
    },
  );
  it("verified expired receipt leaves prior unknown command intact", async () => {
    const v = setup();
    v.protocol.reject(v.command, new Error());
    v.protocol.retry();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        response(
          { type: "about:blank", title: "safe", status: 409, code: "receipt_expired", traceId: "synthetic" },
          409,
          null,
        ),
      ),
    );
    const error = await taskEditRequest(org, v.command, "csrf").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 409, code: "receipt_expired" });
    expect(v.protocol.reject(v.command, error)).toBe("unknown");
    expect(v.protocol.getSnapshot().command).toBe(v.command);
  });
  it.each(["json", "utf8", "ascii-size", "utf8-size"])("invalid successful %s cannot ACK", async (kind) => {
    const v = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            kind === "json"
              ? "{"
              : kind === "utf8"
                ? new Uint8Array([0xc3, 0x28])
                : JSON.stringify({ private: (kind === "utf8-size" ? "😀" : "a").repeat(taskEditBodyLimit) }),
            { status: 200 },
          ),
      ),
    );
    const error = await taskEditRequest(org, v.command, "csrf").catch((e: unknown) => e);
    expect(v.protocol.reject(v.command, error)).toBe("unknown");
    expect(v.protocol.retry()).toBe(v.command);
  });
  it("altered serialized body cannot fetch with original key", async () => {
    const v = setup(),
      fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(taskEditRequest(org, { ...v.command, serializedBody: "{}" }, "csrf")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["bad", "", "/../../tasks"])("invalid org %s cannot dispatch", async (value) => {
    const v = setup(),
      fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(taskEditRequest(value, v.command, "csrf")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("20-second timeout aborts and retains exact unknown command", async () => {
    vi.useFakeTimers();
    const v = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options?.signal?.addEventListener("abort", () => reject(new Error("safe abort")), { once: true }),
          ),
      ),
    );
    const pending = taskEditRequest(org, v.command, "csrf").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20000);
    expect(v.protocol.reject(v.command, await pending)).toBe("unknown");
    expect(v.protocol.getSnapshot().command).toBe(v.command);
  });
  it("late response after context replacement cannot ACK or apply denial", async () => {
    const v = setup();
    let resolve!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    );
    const pending = taskEditRequest(org, v.command, "csrf");
    v.protocol.bind("other-context");
    resolve(response());
    const result = await pending;
    expect(v.protocol.acknowledge(v.command, result.data, result.etag)).toBe(false);
    expect(v.protocol.reject(v.command, new ApiError(403, "late"))).toBe("ignored");
  });
  it.each([null, 'W/"2"', '"1"'])("current detail ETag %s cannot supply display state", async (etag) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => response(receipt(), 200, etag)),
    );
    await expect(readTaskEditTask(org, id)).rejects.toThrow();
  });
  it("different Task UUID cannot fill original drawer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => response({ ...receipt(), id: lead })),
    );
    await expect(readTaskEditTask(org, id)).rejects.toThrow();
  });
  it("current GET is read-only/private and independent of original command", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response());
    vi.stubGlobal("fetch", fetcher);
    expect(await readTaskEditTask(org, id)).toMatchObject({ data: receipt(), etag: '"2"' });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has("idempotency-key")).toBe(false);
  });
});
