import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RecordArchiveProtocol,
  recordArchiveBodyLimit,
  recordArchiveContext,
  recordArchiveContextAllows,
  recordArchiveRequest,
  recordArchiveRoute,
  type RecordArchiveKind,
} from "../../apps/web/components/record-archive";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const org = "ac000000-0000-4000-8000-000000000001",
  user = "ac000000-0000-4000-8000-000000000002",
  member = "ac000000-0000-4000-8000-000000000003",
  contactId = "ac000000-0000-4000-8000-000000000004",
  leadId = "ac000000-0000-4000-8000-000000000005",
  key = "ac000000-0000-4000-8000-000000000006",
  jobId = "ac000000-0000-4000-8000-000000000007",
  csrf = "synthetic-csrf",
  horizon = 23 * 60 * 60 * 1000;
function session(permissions: string[] = ["crm.contacts.write", "crm.leads.write"]): Schema<"Session"> {
  return {
    userId: user,
    activeOrgId: org,
    organizations: [],
    permissions,
    profile: { displayName: "Synthetic", timezone: "UTC" },
  };
}
const binding = (permissions?: string[], token = csrf) =>
  recordArchiveContext({ session: session(permissions), memberId: member, csrf: token, accessRevision: 1 });
const job = (kind = "crm.contact.archived", patch: Record<string, unknown> = {}) => ({
  id: jobId,
  state: "succeeded",
  kind,
  createdAt: "2026-10-11T10:00:00.000Z",
  resultUrl: null,
  error: null,
  ...patch,
});
function setup(kind: RecordArchiveKind = "contact", version = 7, permissions?: string[]) {
  let wall = 1_000_000,
    mono = 1000;
  const protocol = new RecordArchiveProtocol({ wallNow: () => wall, monotonicNow: () => mono });
  const context = binding(permissions);
  protocol.bind(context);
  const target = { kind, resourceId: kind === "contact" ? contactId : leadId, version };
  const command = protocol.begin(target, key);
  return {
    protocol,
    context,
    target,
    command,
    clock: (w: number, m: number) => {
      wall = w;
      mono = m;
    },
  };
}
const accepted = (data: unknown = job(), etag: string | null = '"8"', status = 202) =>
  new Response(JSON.stringify(data), { status, headers: etag ? { etag } : {} });
const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: "about:blank", title: "safe", status, code, traceId: "synthetic" }), {
    status,
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ADR-047 verified binding", () => {
  it("requires a full verified identity and either archive grant", () => {
    expect(binding(["crm.contacts.write"])).toBeTypeOf("string");
    expect(binding(["crm.leads.write"])).toBeTypeOf("string");
    expect(binding(["crm.contacts.read", "crm.leads.read"])).toBeNull();
    expect(recordArchiveContext({ session: null, memberId: member, csrf, accessRevision: 1 })).toBeNull();
    expect(binding(undefined, "bad csrf with spaces")).toBeNull();
  });
  it("binds user/org/member/CSRF/access revision/full grants", () => {
    const base = { session: session(), memberId: member, csrf, accessRevision: 1 },
      first = recordArchiveContext(base);
    for (const patch of [
      { csrf: "rotated" },
      { accessRevision: 2 },
      { memberId: user },
      { session: session(["crm.contacts.write", "crm.leads.write", "crm.tasks.read"]) },
    ])
      expect(recordArchiveContext({ ...base, ...patch })).not.toBe(first);
  });
  it("kind permission is read from the bound grants", () => {
    const contactOnly = binding(["crm.contacts.write"]);
    expect(recordArchiveContextAllows(contactOnly, "contact")).toBe(true);
    expect(recordArchiveContextAllows(contactOnly, "lead")).toBe(false);
    expect(recordArchiveContextAllows("not-json", "contact")).toBe(false);
    const protocol = new RecordArchiveProtocol();
    protocol.bind(contactOnly);
    expect(() => protocol.begin({ kind: "lead", resourceId: leadId, version: 1 }, key)).toThrow();
  });
});

describe("immutable command capture", () => {
  it("captures kind, resource, organization, route, key, version and clocks before any await", () => {
    let wall = 5000,
      mono = 50;
    const protocol = new RecordArchiveProtocol({ wallNow: () => wall, monotonicNow: () => mono });
    protocol.bind(binding());
    const input = { kind: "contact" as RecordArchiveKind, resourceId: contactId, version: 7 };
    const command = protocol.begin(input, key);
    input.kind = "lead";
    input.resourceId = leadId;
    input.version = 99;
    wall = 9000;
    mono = 90;
    expect(command).toEqual({
      context: binding(),
      kind: "contact",
      resourceId: contactId,
      organizationId: org,
      route: `/v1/orgs/${org}/contacts/${contactId}/archive`,
      version: 7,
      key,
      jobKind: "crm.contact.archived",
      firstWall: 5000,
      firstMonotonic: 50,
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(() => {
      (command as { key: string }).key = "other";
    }).toThrow();
    expect(protocol.getSnapshot()).toMatchObject({ phase: "sending", command });
  });
  it("lead route and job kind", () => {
    const { command } = setup("lead", 3);
    expect(command.route).toBe(`/v1/orgs/${org}/leads/${leadId}/archive`);
    expect(command.jobKind).toBe("crm.lead.archived");
    expect(recordArchiveRoute(org, "lead", leadId)).toBe(command.route);
  });
  it.each([
    ["non-UUID key", { kind: "contact", resourceId: contactId, version: 1 }, "key-1"],
    ["zero version", { kind: "contact", resourceId: contactId, version: 0 }, key],
    ["fractional version", { kind: "contact", resourceId: contactId, version: 1.5 }, key],
    ["max version", { kind: "contact", resourceId: contactId, version: Number.MAX_SAFE_INTEGER }, key],
    ["bad id", { kind: "contact", resourceId: "../tasks", version: 1 }, key],
    ["bad kind", { kind: "task", resourceId: contactId, version: 1 }, key],
  ])("%s cannot begin", (_, input, k) => {
    const protocol = new RecordArchiveProtocol();
    protocol.bind(binding());
    expect(() => protocol.begin(input as never, k)).toThrow();
    expect(protocol.getSnapshot()).toEqual({ command: null, phase: "idle", subject: null });
  });
  it("an unbound protocol or a retained command cannot begin another", () => {
    const unbound = new RecordArchiveProtocol();
    expect(() => unbound.begin({ kind: "contact", resourceId: contactId, version: 1 }, key)).toThrow();
    const v = setup();
    expect(() => v.protocol.begin({ kind: "lead", resourceId: leadId, version: 1 }, jobId)).toThrow();
    v.protocol.reject(v.command, new TypeError("network"));
    expect(() => v.protocol.begin({ kind: "lead", resourceId: leadId, version: 1 }, jobId)).toThrow();
    expect(v.protocol.retry()).toBe(v.command);
  });
});

describe("exact request shape", () => {
  it.each(["contact", "lead"] as const)(
    "%s archive POSTs the captured route with no body and no If-Match",
    async (kind) => {
      const v = setup(kind);
      const fetcher = vi.fn<typeof fetch>(async () =>
        accepted(job(kind === "contact" ? "crm.contact.archived" : "crm.lead.archived")),
      );
      vi.stubGlobal("fetch", fetcher);
      const result = await recordArchiveRequest(v.command, csrf);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, options] = fetcher.mock.calls[0]!;
      expect(url).toBe(
        `/api/v1/orgs/${org}/${kind === "contact" ? "contacts" : "leads"}/${v.target.resourceId}/archive`,
      );
      expect(options).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      expect(options?.body).toBeUndefined();
      const headers = new Headers(options?.headers);
      const names: string[] = [];
      headers.forEach((_value, name) => names.push(name));
      expect(names.sort()).toEqual(["idempotency-key", "x-csrf-token"]);
      expect(headers.get("idempotency-key")).toBe(key);
      expect(headers.get("x-csrf-token")).toBe(csrf);
      expect(headers.has("if-match")).toBe(false);
      expect(headers.has("content-type")).toBe(false);
      expect(v.protocol.acknowledge(v.command, result.data, result.etag)).toBe(true);
    },
  );
  it.each([
    ["altered route", { route: `/v1/orgs/${org}/contacts/${leadId}/archive` }],
    ["altered org", { organizationId: user }],
    ["altered kind", { kind: "lead" }],
    ["altered job kind", { jobKind: "crm.lead.archived" }],
    ["altered key", { key: "x" }],
  ])("%s cannot dispatch", async (_, patch) => {
    const v = setup(),
      fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(recordArchiveRequest({ ...v.command, ...patch } as never, csrf)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("a CSRF token other than the bound one cannot dispatch", async () => {
    const v = setup(),
      fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(recordArchiveRequest(v.command, "rotated")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([200, 201, 204])("unexpected successful %s stays unknown", async (status) => {
    const v = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        status === 204 ? new Response(null, { status }) : accepted(job(), '"8"', status),
      ),
    );
    const error = await recordArchiveRequest(v.command, csrf).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(v.protocol.reject(v.command, error)).toBe("unknown");
  });
  it.each(["json", "utf8", "size"])("invalid accepted %s body cannot acknowledge", async (kind) => {
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
                : JSON.stringify({ private: "a".repeat(recordArchiveBodyLimit) }),
            { status: 202, headers: { etag: '"8"' } },
          ),
      ),
    );
    const error = await recordArchiveRequest(v.command, csrf).catch((e: unknown) => e);
    expect(v.protocol.reject(v.command, error)).toBe("unknown");
    expect(v.protocol.retry()).toBe(v.command);
  });
  it("20-second timeout aborts and retains the exact unknown command", async () => {
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
    const pending = recordArchiveRequest(v.command, csrf).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20000);
    expect(v.protocol.reject(v.command, await pending)).toBe("unknown");
    expect(v.protocol.getSnapshot().command).toBe(v.command);
  });
});

describe("strict historical acknowledgement", () => {
  it("accepts an exact succeeded Job and any next-version ETag above the captured version", () => {
    const v = setup();
    expect(v.protocol.acknowledge(v.command, job(), '"12"')).toBe(true);
    expect(v.protocol.getSnapshot()).toEqual({
      command: null,
      phase: "acknowledged",
      subject: { kind: "contact", resourceId: contactId },
    });
    expect(v.protocol.isCurrent(v.command)).toBe(false);
  });
  it("accepts absent resultUrl and error", () => {
    const v = setup("lead");
    const { resultUrl: _r, error: _e, ...bare } = job("crm.lead.archived");
    expect(v.protocol.acknowledge(v.command, bare, '"8"')).toBe(true);
  });
  it.each([
    ["wrong kind", job("crm.lead.archived"), '"8"'],
    ["foreign kind", job("crm.contact.updated"), '"8"'],
    ["queued state", job(undefined, { state: "queued" }), '"8"'],
    ["failed state", job(undefined, { state: "failed" }), '"8"'],
    ["unknown state", job(undefined, { state: "unknown" }), '"8"'],
    ["result URL", job(undefined, { resultUrl: "https://example.test/r" }), '"8"'],
    [
      "error",
      job(undefined, {
        error: { type: "about:blank", title: "x", status: 500, code: "x", traceId: "t" },
      }),
      '"8"',
    ],
    ["extra property", job(undefined, { resourceId: contactId }), '"8"'],
    ["missing createdAt", job(undefined, { createdAt: undefined }), '"8"'],
    ["non-UUID id", job(undefined, { id: "job-1" }), '"8"'],
    ["null body", null, '"8"'],
    ["missing ETag", job(), null],
    ["weak ETag", job(), 'W/"8"'],
    ["unquoted ETag", job(), "8"],
    ["same version", job(), '"7"'],
    ["older version", job(), '"6"'],
    ["leading zero", job(), '"08"'],
    ["zero", job(), '"0"'],
    ["unsafe integer", job(), '"99999999999999999"'],
  ])("%s keeps the original command unknown", (_, data, etag) => {
    const v = setup();
    const input = data && Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
    expect(v.protocol.acknowledge(v.command, input, etag)).toBe(false);
    expect(v.protocol.getSnapshot()).toMatchObject({ phase: "unknown", command: v.command });
    expect(v.protocol.retry()).toBe(v.command);
  });
  it("late response after context replacement can neither acknowledge nor deny", () => {
    const v = setup();
    v.protocol.bind(binding(["crm.contacts.write"]));
    expect(v.protocol.acknowledge(v.command, job(), '"8"')).toBe(false);
    expect(v.protocol.reject(v.command, new ApiError(403, "late"))).toBe("ignored");
    expect(v.protocol.getSnapshot()).toEqual({ command: null, phase: "idle", subject: null });
  });
});

describe("definitive and indefinite rejections", () => {
  it("initial 409 contact_has_active_leads releases with an explicit blocked phase", async () => {
    const v = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => problem(409, "contact_has_active_leads")),
    );
    const error = await recordArchiveRequest(v.command, csrf).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 409, code: "contact_has_active_leads" });
    expect(v.protocol.reject(v.command, error)).toBe("cleared");
    expect(v.protocol.getSnapshot()).toEqual({
      command: null,
      phase: "blocked",
      subject: { kind: "contact", resourceId: contactId },
    });
    expect(v.protocol.begin({ kind: "contact", resourceId: contactId, version: 7 }, jobId)).toBeTruthy();
  });
  it("initial 404 is a definitive unavailable rejection", () => {
    const v = setup("lead");
    expect(v.protocol.reject(v.command, new ApiError(404, "x", "resource_unavailable"))).toBe("cleared");
    expect(v.protocol.getSnapshot().phase).toBe("unavailable");
  });
  it.each([
    ["404", new ApiError(404, "x", "resource_unavailable")],
    ["409 receipt_expired", new ApiError(409, "x", "receipt_expired")],
    ["409 active leads", new ApiError(409, "x", "contact_has_active_leads")],
    ["422", new ApiError(422, "x", "body_not_allowed")],
  ])("%s on an unknown-outcome retry does not prove non-execution", (_, error) => {
    const v = setup();
    v.protocol.reject(v.command, new TypeError("network"));
    expect(v.protocol.retry()).toBe(v.command);
    expect(v.protocol.reject(v.command, error)).toBe("unknown");
    expect(v.protocol.getSnapshot()).toMatchObject({ phase: "unknown", command: v.command });
  });
  it.each([401, 403])("%s clears private state even when the problem body is malformed", async (status) => {
    const v = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("PRIVATE_PROVIDER", { status })),
    );
    const error = await recordArchiveRequest(v.command, csrf).catch((e: unknown) => e);
    expect(error).toMatchObject({ status });
    expect((error as Error).message).not.toContain("PRIVATE");
    expect(v.protocol.reject(v.command, error)).toBe("cleared");
    expect(v.protocol.getSnapshot().phase).toBe("denied");
    expect(v.protocol.isBoundTo(v.context)).toBe(false);
  });
  it.each([400, 404, 409, 422, 429])(
    "unverifiable %s response cannot prove non-execution",
    async (status) => {
      const v = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response("PRIVATE_PROVIDER", { status })),
      );
      const error = await recordArchiveRequest(v.command, csrf).catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(ApiError);
      expect(v.protocol.reject(v.command, error)).toBe("unknown");
    },
  );
  it.each([408, 500, 503])("%s stays unknown", (status) => {
    const v = setup();
    expect(v.protocol.reject(v.command, new ApiError(status, "x", "x"))).toBe("unknown");
  });
});

describe("dual clocks and ADR-042 forgetting", () => {
  it("retry is available inside both 23-hour windows only", () => {
    const v = setup();
    v.protocol.reject(v.command, new TypeError("network"));
    v.clock(1_000_000 + horizon - 1, 1000 + horizon - 1);
    expect(v.protocol.canRetry()).toBe(true);
    expect(v.protocol.canForget()).toBe(false);
    expect(v.protocol.forget()).toBe(false);
  });
  it.each([
    ["wall window", 1_000_000 + horizon, 2000],
    ["monotonic window", 1_000_001, 1000 + horizon],
    ["wall rollback", 999_999, 2000],
    ["monotonic rollback", 1_000_001, 999],
    ["non-finite wall", Number.NaN, 2000],
  ])("%s disables resend permanently and permits local forgetting", (_, wall, mono) => {
    const v = setup();
    v.protocol.reject(v.command, new TypeError("network"));
    v.clock(wall, mono);
    expect(v.protocol.canRetry()).toBe(false);
    v.clock(1_000_001, 1001);
    expect(v.protocol.canRetry()).toBe(false);
    expect(() => v.protocol.retry()).toThrow();
    expect(v.protocol.canForget()).toBe(true);
    expect(v.protocol.forget()).toBe(true);
    expect(v.protocol.getSnapshot()).toEqual({ command: null, phase: "forgotten", subject: null });
    expect(() => v.protocol.begin({ kind: "contact", resourceId: contactId, version: 7 }, jobId)).toThrow();
  });
  it("an in-flight command cannot be forgotten", () => {
    const v = setup();
    v.clock(1_000_000 + horizon, 1000 + horizon);
    expect(v.protocol.canForget()).toBe(false);
    expect(v.protocol.forget()).toBe(false);
    expect(v.protocol.getSnapshot().command).toBe(v.command);
  });
  it("rebinding to a new verified context is the only way out of forgotten", () => {
    const v = setup();
    v.protocol.reject(v.command, new TypeError("network"));
    v.clock(1_000_000 + horizon, 1000 + horizon);
    expect(v.protocol.forget()).toBe(true);
    v.protocol.bind(binding(["crm.contacts.write"]));
    expect(v.protocol.getSnapshot().phase).toBe("idle");
  });
});
