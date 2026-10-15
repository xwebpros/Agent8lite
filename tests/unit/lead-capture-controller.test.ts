import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LeadCaptureProtocol,
  leadCaptureEligible,
  leadCaptureRequest,
  leadCaptureBodyLimit,
  type LeadCaptureCurrent,
} from "../../apps/web/components/lead-capture";
import { ApiError } from "../../apps/web/lib/api";
const org = "eb000000-0000-4000-8000-000000000001",
  id = "eb000000-0000-4000-8000-000000000002",
  sourceId = "eb000000-0000-4000-8000-000000000003",
  memberId = "eb000000-0000-4000-8000-000000000004",
  ck = "eb000000-0000-4000-8000-000000000005",
  lk = "eb000000-0000-4000-8000-000000000006";
const binding = "verified-user/org/member/csrf/access/grants";
function setup() {
  const protocol = new LeadCaptureProtocol();
  protocol.bind(binding);
  const body = {
    contact: { displayName: " Original ", emails: ["original@example.test"] },
    lead: { sourceId, ownerMemberId: memberId, intent: "buyer" as const, timeline: "original" },
  };
  const command = protocol.begin(body, ck, lk);
  return { protocol, command, body };
}
function current(patch: Partial<LeadCaptureCurrent> = {}): LeadCaptureCurrent {
  return {
    binding,
    active: true,
    online: true,
    visible: true,
    changingOrganization: false,
    modal: "lead",
    busy: false,
    loading: false,
    detailLoading: false,
    otherProtected: false,
    ...patch,
  };
}
function ok(
  data: unknown = { id, displayName: "Original", emails: ["original@example.test"], phones: [], version: 1 },
  status = 201,
  etag = '"1"',
) {
  return new Response(JSON.stringify(data), { status, headers: { etag } });
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

describe("exact frozen two-step transport and truthful response classification", () => {
  it("POSTs only captured contact bytes/key/CSRF with no If-Match and private same-origin transport", async () => {
    const value = setup(),
      pending = deferred<Response>(),
      fetcher = vi.fn<typeof fetch>(() => pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const request = leadCaptureRequest(org, value.command, "synthetic-csrf");
    value.body.contact.displayName = "edited";
    value.body.lead.timeline = "edited";
    pending.resolve(ok());
    const response = await request;
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("/api/v1/orgs/" + org + "/contacts");
    expect(options).toMatchObject({
      method: "POST",
      body: value.command.serializedBody,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    const headers = new Headers(options?.headers);
    expect(headers.get("idempotency-key")).toBe(ck);
    expect(headers.get("x-csrf-token")).toBe("synthetic-csrf");
    expect(headers.has("if-match")).toBe(false);
    expect(response.etag).toBe('"1"');
    expect(value.protocol.acknowledge(value.command, response.data, response.etag)).toBe("contact");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(value.protocol.getSnapshot().phase).toBe("lead-ready");
  });
  it("explicit lead send uses only acknowledged contact ID and original lead bytes/key", async () => {
    const value = setup();
    value.protocol.acknowledge(value.command, await ok().json(), '"1"');
    const command = value.protocol.startLead(),
      fetcher = vi.fn<typeof fetch>(async () =>
        ok({
          id: lk,
          contactId: id,
          sourceId,
          ownerMemberId: memberId,
          stageId: ck,
          intent: "buyer",
          timeline: "original",
          version: 1,
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const response = await leadCaptureRequest(org, command, "synthetic-csrf");
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("/api/v1/orgs/" + org + "/leads");
    expect(options?.body).toBe(command.serializedBody);
    expect(new Headers(options?.headers).get("idempotency-key")).toBe(lk);
    expect(value.protocol.acknowledge(command, response.data, response.etag)).toBe("lead");
  });
  it.each([200, 202, 204])(
    "unexpected successful status%s cannot acknowledge or start lead",
    async (status) => {
      const value = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => (status === 204 ? new Response(null, { status }) : ok({}, status))),
      );
      let error: unknown;
      try {
        await leadCaptureRequest(org, value.command, "synthetic-csrf");
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(value.protocol.reject(value.command, error)).toBe("unknown");
      expect(() => value.protocol.startLead()).toThrow();
    },
  );
  it.each([401, 403, 408, 409, 422, 429, 500, 503])(
    "HTTP%s preserves actual status despite malformed private Problem text",
    async (status) => {
      const value = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response("PRIVATE_PROVIDER_ERROR", { status })),
      );
      const error = await leadCaptureRequest(org, value.command, "synthetic-csrf").catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status });
      expect((error as Error).message).not.toContain("PRIVATE_PROVIDER_ERROR");
    },
  );
  it("receipt_expired is preserved safely but a retry rejection cannot reset the unknown command", async () => {
    const value = setup();
    value.protocol.reject(value.command, new TypeError("unknown"));
    const command = value.protocol.retry();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              type: "about:blank",
              title: "safe",
              status: 409,
              detail: "PRIVATE_BODY",
              code: "receipt_expired",
              traceId: "synthetic",
            }),
            { status: 409 },
          ),
      ),
    );
    const error = await leadCaptureRequest(org, command, "synthetic-csrf").catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "receipt_expired", status: 409 });
    expect(value.protocol.reject(command, error)).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(command);
  });
  it.each(["malformed-json", "invalid-utf8", "oversized-ascii", "oversized-utf8"])(
    "unverified201%s stays unknown with unchanged bytes/key",
    async (kind) => {
      const value = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () =>
            new Response(
              kind === "malformed-json"
                ? "{"
                : kind === "invalid-utf8"
                  ? new Uint8Array([0xc3, 0x28])
                  : JSON.stringify({
                      secret: (kind === "oversized-utf8" ? "😀" : "a").repeat(leadCaptureBodyLimit),
                    }),
              { status: 201 },
            ),
        ),
      );
      const error = await leadCaptureRequest(org, value.command, "synthetic-csrf").catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(value.protocol.reject(value.command, error)).toBe("unknown");
      expect(value.protocol.retry()).toBe(value.command);
    },
  );
  it("body/key mismatch cannot dispatch changed command bytes", async () => {
    const value = setup(),
      fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      leadCaptureRequest(
        org,
        { ...value.command, serializedBody: '{"displayName":"different"}' },
        "synthetic-csrf",
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["not-uuid", "", "/../../leads"])(
    "malformed organization%s never reaches fetch",
    async (organization) => {
      const value = setup(),
        fetcher = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetcher);
      await expect(leadCaptureRequest(organization, value.command, "synthetic-csrf")).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("an interrupted request is bounded by its own20s abort and keeps the original step", async () => {
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
    const request = leadCaptureRequest(org, value.command, "synthetic-csrf").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20000);
    const error = await request;
    expect(value.protocol.reject(value.command, error)).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it("a context change before a late201 cuts acknowledgement without sending another step", async () => {
    const value = setup(),
      pending = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => pending.promise),
    );
    const request = leadCaptureRequest(org, value.command, "synthetic-csrf");
    value.protocol.bind("different context");
    pending.resolve(ok());
    const response = await request;
    expect(value.protocol.acknowledge(value.command, response.data, response.etag)).toBe(false);
    expect(value.protocol.getSnapshot().sequence).toBeNull();
    expect(() => value.protocol.startLead()).toThrow();
  });
});

describe("synchronous current-context guards before first/next/reconciliation send", () => {
  it("allows only an active visible online lead dialog with current binding and no competing work", () => {
    expect(leadCaptureEligible(binding, current())).toBe(true);
  });
  it.each([
    { binding: "different" },
    { binding: null },
    { active: false },
    { online: false },
    { visible: false },
    { changingOrganization: true },
    { modal: "task" },
    { modal: null },
    { busy: true },
    { loading: true },
    { detailLoading: true },
    { otherProtected: true },
  ] satisfies Partial<LeadCaptureCurrent>[])(
    "retained callback eligibility cut%# denies before protocol advancement or sending",
    (patch) => {
      const value = setup();
      value.protocol.acknowledge(
        value.command,
        { id, displayName: "Original", emails: ["original@example.test"], phones: [], version: 1 },
        '"1"',
      );
      const state = current(patch);
      if (leadCaptureEligible(binding, state)) value.protocol.startLead();
      expect(leadCaptureEligible(binding, state)).toBe(false);
      expect(value.protocol.getSnapshot().phase).toBe("lead-ready");
    },
  );
  it("an accessor-provided current eligibility flag is rejected without running its getter", () => {
    let calls = 0;
    const state = current();
    Object.defineProperty(state, "online", {
      enumerable: true,
      get: () => {
        calls++;
        return true;
      },
    });
    expect(leadCaptureEligible(binding, state)).toBe(false);
    expect(calls).toBe(0);
  });
  it("same binding cannot override the protocol's own context cut before begin/retry", () => {
    const value = setup();
    value.protocol.bind(null);
    expect(value.protocol.isBoundTo(binding)).toBe(false);
    expect(value.protocol.isBoundTo(null)).toBe(false);
    expect(() => value.protocol.startLead()).toThrow();
    expect(() => value.protocol.retry()).toThrow();
  });
});
