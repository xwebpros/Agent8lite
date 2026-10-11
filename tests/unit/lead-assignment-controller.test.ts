import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LeadAssignmentProtocol,
  leadAssignmentBodyLimit,
  leadAssignmentContext,
  leadAssignmentEligible,
  leadAssignmentRequest,
  type LeadAssignmentCurrent,
} from "../../apps/web/components/lead-assignment";
import { ApiError, type Schema } from "../../apps/web/lib/api";
import {
  readLeadAssignmentLead,
  readLeadAssignmentMembers,
  requireLeadAssignmentMembers,
} from "../../apps/web/components/lead-assignment-controller";

const org = "ee000000-0000-4000-8000-000000000001",
  leadId = "ee000000-0000-4000-8000-000000000002",
  contactId = "ee000000-0000-4000-8000-000000000003",
  sourceId = "ee000000-0000-4000-8000-000000000004",
  originalStage = "ee000000-0000-4000-8000-000000000005",
  target = "ee000000-0000-4000-8000-000000000006",
  member = "ee000000-0000-4000-8000-000000000007",
  key = "ee000000-0000-4000-8000-000000000008";
const binding = "verified-user/org/member/csrf/access/grants";
const lead = (): Schema<"Lead"> => ({
  id: leadId,
  contactId,
  sourceId,
  stageId: originalStage,
  ownerMemberId: member,
  intent: "buyer",
  version: 1,
});

describe("current source reads remain separate from historical acknowledgement", () => {
  it("successful handoff stays acknowledged when current read becomes out of scope", async () => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, receipt(), '"2"')).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("PRIVATE_MEMBER_SOURCE", { status: 404 })),
    );
    const error = await readLeadAssignmentLead(org, leadId).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 404 });
    expect((error as Error).message).not.toContain("PRIVATE_MEMBER_SOURCE");
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "acknowledged" });
  });
  it.each([null, 'W/"2"', '"1"'])(
    "current detail with ETag %s cannot replace a verified record",
    async (etag) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () => new Response(JSON.stringify(receipt()), { headers: etag ? { etag } : {} }),
        ),
      );
      await expect(readLeadAssignmentLead(org, leadId)).rejects.toThrow();
    },
  );
  it("a current response for a different Lead cannot authorize the original drawer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => response({ ...receipt(), id: target })),
    );
    await expect(readLeadAssignmentLead(org, leadId)).rejects.toThrow();
  });
  it("member discovery is read-only, exact-page bounded and separate from write authority", async () => {
    const memberPage = {
      items: [
        { id: member, displayName: "Synthetic recipient", roleId: target, status: "active", version: 1 },
      ],
      nextCursor: null,
      hasMore: false,
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(memberPage)));
    vi.stubGlobal("fetch", fetcher);
    expect(await readLeadAssignmentMembers(org)).toEqual(memberPage);
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/orgs/${org}/members?limit=25`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(Object.isFrozen(requireLeadAssignmentMembers(memberPage).items)).toBe(true);
  });
  it.each(["duplicate", "short-more", "extra", "version", "blank"])(
    "invalid member catalogue %s cannot populate choices",
    (kind) => {
      const item = { id: member, displayName: "Synthetic", roleId: target, status: "active", version: 1 };
      const page = { items: [item], nextCursor: null as string | null, hasMore: false };
      if (kind === "duplicate") page.items.push({ ...item, id: member.toUpperCase() });
      if (kind === "short-more") {
        page.hasMore = true;
        page.nextCursor = "cursor";
      }
      if (kind === "extra") Object.assign(item, { privateBody: "PRIVATE" });
      if (kind === "version") item.version = Number.MAX_SAFE_INTEGER + 1;
      if (kind === "blank") item.displayName = " ";
      expect(() => requireLeadAssignmentMembers(page)).toThrow();
    },
  );
});
function setup() {
  const protocol = new LeadAssignmentProtocol();
  protocol.bind(binding);
  const body = { ownerMemberId: target, timeline: " Exact timeline " };
  return { protocol, body, command: protocol.begin({ lead: lead(), body }, key) };
}
const current = (patch: Partial<LeadAssignmentCurrent> = {}): LeadAssignmentCurrent => ({
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
  leadId,
  ...patch,
});
const receipt = () => ({ ...lead(), version: 2, ownerMemberId: target, timeline: " Exact timeline " });
const response = (data: unknown = receipt(), status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { etag: '"2"' } });
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

describe("assignment command exact transport and outcome classification", () => {
  it("dispatches captured original body/key/revision with no-store, same-origin and no automatic current read", async () => {
    const value = setup(),
      pending = deferred<Response>(),
      fetcher = vi.fn<typeof fetch>(() => pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const request = leadAssignmentRequest(org, value.command, "synthetic-csrf");
    value.body.timeline = "later edit";
    value.body.ownerMemberId = originalStage;
    pending.resolve(response());
    const result = await request;
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/v1/orgs/${org}/leads/${leadId}`);
    expect(options).toMatchObject({
      method: "PATCH",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: value.command.serializedBody,
    });
    const headers = new Headers(options?.headers);
    expect(headers.get("idempotency-key")).toBe(key);
    expect(headers.get("if-match")).toBe('"1"');
    expect(headers.get("x-csrf-token")).toBe("synthetic-csrf");
    expect(value.protocol.acknowledge(value.command, result.data, result.etag)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(value.protocol.getSnapshot().phase).toBe("acknowledged");
  });
  it.each([201, 202, 204])("unexpected successful %s does not acknowledge", async (status) => {
    const value = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        status === 204 ? new Response(null, { status }) : response({}, status),
      ),
    );
    const error = await leadAssignmentRequest(org, value.command, "csrf").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(value.protocol.reject(value.command, error)).toBe("unknown");
  });
  it.each([401, 403, 408, 409, 412, 422, 429, 500, 503])(
    "HTTP %s survives malformed private Problem without displaying its content",
    async (status) => {
      const value = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response("PRIVATE_PROVIDER_TEXT", { status })),
      );
      const error = await leadAssignmentRequest(org, value.command, "csrf").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status });
      expect((error as Error).message).not.toContain("PRIVATE_PROVIDER_TEXT");
    },
  );
  it("expired receipt response retains original unknown outcome instead of offering another command", async () => {
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
              detail: "PRIVATE_REASON",
              code: "receipt_expired",
              traceId: "synthetic",
            }),
            { status: 409 },
          ),
      ),
    );
    const error = await leadAssignmentRequest(org, value.command, "csrf").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 409, code: "receipt_expired" });
    expect(value.protocol.reject(value.command, error)).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it.each(["json", "utf8", "ascii-size", "utf8-size"])(
    "invalid successful %s response retains exact retry",
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
                      secret: (kind === "utf8-size" ? "😀" : "a").repeat(leadAssignmentBodyLimit),
                    }),
              { status: 200 },
            ),
        ),
      );
      const error = await leadAssignmentRequest(org, value.command, "csrf").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(value.protocol.reject(value.command, error)).toBe("unknown");
      expect(value.protocol.retry()).toBe(value.command);
    },
  );
  it.each(["not-uuid", "", "/../../leads"])("invalid organization %s cannot reach fetch", async (value) => {
    const command = setup().command,
      fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(leadAssignmentRequest(value, command, "csrf")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("changed serialized bytes cannot dispatch under original body/key", async () => {
    const value = setup(),
      fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      leadAssignmentRequest(
        org,
        { ...value.command, serializedBody: '{"ownerMemberId":"different"}' },
        "csrf",
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("own twenty-second timeout aborts transport and leaves the original command unknown", async () => {
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
    const pending = leadAssignmentRequest(org, value.command, "csrf").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20000);
    expect(value.protocol.reject(value.command, await pending)).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it("a late response after binding replacement cannot acknowledge or revive old authority", async () => {
    const value = setup(),
      pending = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => pending.promise),
    );
    const request = leadAssignmentRequest(org, value.command, "csrf");
    value.protocol.bind("replacement context");
    pending.resolve(response());
    const result = await request;
    expect(value.protocol.acknowledge(value.command, result.data, result.etag)).toBe(false);
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "idle" });
  });
});

describe("current assignment action and write-only context guards", () => {
  const session = (): Schema<"Session"> => ({
    userId: leadId,
    profile: { displayName: "Synthetic agent", timezone: "UTC" },
    activeOrgId: org,
    organizations: [
      { id: org, name: "Synthetic", status: "active", timezone: "UTC", locale: "en-US", version: 1 },
    ],
    permissions: ["crm.leads.write"],
  });
  it("only the frozen write permission is required, while full grants and CSRF/revision bind identity", () => {
    const input = { session: session(), memberId: member, csrf: "synthetic-csrf", accessRevision: 1 };
    const original = leadAssignmentContext(input);
    expect(original).not.toBeNull();
    expect(leadAssignmentContext({ ...input, session: { ...session(), permissions: [] } })).toBeNull();
    expect(leadAssignmentContext({ ...input, csrf: "replacement" })).not.toBe(original);
    expect(leadAssignmentContext({ ...input, accessRevision: 2 })).not.toBe(original);
    expect(
      leadAssignmentContext({
        ...input,
        session: { ...session(), permissions: ["crm.leads.write", "crm.pipeline.read"] },
      }),
    ).not.toBe(original);
  });
  it.each([
    { active: false },
    { online: false },
    { visible: false },
    { changingOrganization: true },
    { busy: true },
    { loading: true },
    { detailLoading: true },
    { dirty: true },
    { otherProtected: true },
    { binding: "another context" },
  ])("a retained action fails closed after current flags %j", (patch) => {
    expect(leadAssignmentEligible(binding, current(patch))).toBe(false);
  });
  it("a live eligible state still cannot override protocol's own revoked binding", () => {
    const value = setup();
    expect(leadAssignmentEligible(binding, current())).toBe(true);
    value.protocol.bind(null);
    expect(value.protocol.isBoundTo(binding)).toBe(false);
    expect(() => value.protocol.retry()).toThrow();
  });
  it("accessor-provided eligibility is rejected without invoking the getter", () => {
    let calls = 0;
    const state = current();
    Object.defineProperty(state, "online", {
      enumerable: true,
      get: () => {
        calls++;
        return true;
      },
    });
    expect(leadAssignmentEligible(binding, state)).toBe(false);
    expect(calls).toBe(0);
  });
  it("a retained drawer action cannot send against a different Lead identity", () => {
    expect(leadAssignmentEligible(binding, current(), leadId.toUpperCase())).toBe(true);
    expect(leadAssignmentEligible(binding, current({ leadId: target }), leadId)).toBe(false);
    expect(leadAssignmentEligible(binding, current({ leadId: null }), leadId)).toBe(false);
  });
});
