import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContactEditProtocol,
  contactEditBodyLimit,
  contactEditReadGuard,
  contactEditReadFailureDisposition,
  type ContactEditReadCurrent,
  type ContactEditReadTicket,
  contactEditRequest,
  readContactEditContact,
} from "../../apps/web/components/contact-edit";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const org = "de000000-0000-4000-8000-000000000001";
const id = "de000000-0000-4000-8000-000000000002";
const key = "de000000-0000-4000-8000-000000000003";
function contact(version = 2): Schema<"Contact"> {
  return { id, displayName: "Original", emails: ["original@example.test"], phones: [], version };
}
function setup() {
  const protocol = new ContactEditProtocol();
  protocol.bind("verified-context");
  const body = { displayName: " Original ", emails: ["original@example.test"] };
  const command = protocol.begin({ contactId: id, version: 1, body }, key);
  return { protocol, command, body };
}
function ok(body: unknown = contact(), etag = '"2"', status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { etag } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("late contact reads distinguish current authority from private display eligibility", () => {
  const ticket: ContactEditReadTicket = { binding: "verified-context", contactId: id, generation: 7 };
  function current(patch: Partial<ContactEditReadCurrent> = {}): ContactEditReadCurrent {
    return {
      ...ticket,
      kind: "contact",
      active: true,
      online: true,
      visible: true,
      changingOrganization: false,
      ...patch,
    };
  }
  it("accepts a current successful read only while the bound display remains eligible", () => {
    expect(contactEditReadGuard(ticket, current())).toEqual({ authorityCurrent: true, displayCurrent: true });
    expect(Object.isFrozen(contactEditReadGuard(ticket, current()))).toBe(true);
  });
  it("recognizes the same canonical contact UUID without changing the retained command identity", () => {
    expect(contactEditReadGuard({ ...ticket, contactId: id.toUpperCase() }, current())).toEqual({
      authorityCurrent: true,
      displayCurrent: true,
    });
  });
  it.each(["offline", "hidden", "changing-organization"] as const)(
    "current known identity/access/source denial survives the %s display cut",
    (cut) => {
      const state = current({
        online: cut !== "offline",
        visible: cut !== "hidden",
        changingOrganization: cut === "changing-organization",
      });
      expect(contactEditReadGuard(ticket, state)).toEqual({ authorityCurrent: true, displayCurrent: false });
      expect(contactEditReadFailureDisposition(ticket, state, 401)).toBe("access-denied");
      expect(contactEditReadFailureDisposition(ticket, state, 403)).toBe("access-denied");
      expect(contactEditReadFailureDisposition(ticket, state, 404)).toBe("source-unavailable");
      expect(contactEditReadFailureDisposition(ticket, state, 503)).toBe("withhold");
    },
  );
  it.each([
    { binding: "different-context" },
    { binding: null },
    { contactId: key },
    { contactId: null },
    { contactId: "malformed" },
    { generation: 8 },
    { generation: 6 },
    { active: false },
    { kind: "lead" },
    { kind: null },
  ] satisfies Partial<ContactEditReadCurrent>[])(
    "old identity/source/generation cut case%# never revokes a newer context",
    (patch) => {
      const state = current(patch);
      expect(contactEditReadGuard(ticket, state)).toEqual({ authorityCurrent: false, displayCurrent: false });
      for (const status of [401, 403, 404, 503, undefined])
        expect(contactEditReadFailureDisposition(ticket, state, status)).toBe("ignore");
    },
  );
  it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "unsafe generation%s cannot become current merely by equality",
    (generation) => {
      expect(contactEditReadGuard({ ...ticket, generation }, current({ generation }))).toEqual({
        authorityCurrent: false,
        displayCurrent: false,
      });
      expect(contactEditReadFailureDisposition({ ...ticket, generation }, current({ generation }), 403)).toBe(
        "ignore",
      );
    },
  );
  it.each([undefined, 400, 408, 429, 500, 503])(
    "current non-authority failure%s is displayable only on the active visible page",
    (status) => {
      expect(contactEditReadFailureDisposition(ticket, current(), status)).toBe("display-error");
      expect(contactEditReadFailureDisposition(ticket, current({ visible: false }), status)).toBe("withhold");
    },
  );
  it("current read denial can clear an unknown private command while display remains hidden", async () => {
    const { protocol, command } = setup();
    protocol.reject(command, new TypeError("unknown original outcome"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("malformed private problem", { status: 403 })),
    );
    let denial: unknown;
    try {
      await readContactEditContact(org, id);
    } catch (error) {
      denial = error;
    }
    expect(denial).toBeInstanceOf(ApiError);
    expect(
      contactEditReadFailureDisposition(ticket, current({ visible: false }), (denial as ApiError).status),
    ).toBe("access-denied");
    // The protocol's actual access-loss path clears the same original snapshot without acknowledging it.
    expect(protocol.reject(command, denial)).toBe("cleared");
    expect(protocol.getSnapshot()).toEqual({ command: null, phase: "denied" });
  });
});

describe("contact command transport and interrupted read recovery without browser claims", () => {
  it("sends original immutable bytes/revision/key with private same-origin transport", async () => {
    const { command, body } = setup(),
      pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const result = contactEditRequest(org, command, "synthetic-csrf");
    body.displayName = "Edited after sending";
    body.emails[0] = "changed@example.test";
    pending.resolve(ok());
    expect(await result).toEqual({ data: contact(), etag: '"2"' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(`/api/v1/orgs/${org}/contacts/${id}`);
    expect(options).toMatchObject({
      method: "PATCH",
      body: command.serializedBody,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": "synthetic-csrf",
        "Idempotency-Key": key,
        "If-Match": '"1"',
      },
    });
    expect(JSON.parse(String(options!.body))).toEqual({
      displayName: " Original ",
      emails: ["original@example.test"],
    });
  });
  it("explicit reconciliation sends identical bytes after network uncertainty and does not auto-acknowledge", async () => {
    const { protocol, command } = setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetcher);
    await contactEditRequest(org, command, "csrf").catch((error) => protocol.reject(command, error));
    const retained = protocol.retry(),
      result = await contactEditRequest(org, retained, "csrf");
    expect(retained).toBe(command);
    const first = fetcher.mock.calls[0][1],
      second = fetcher.mock.calls[1][1];
    expect(second?.body).toBe(first?.body);
    expect(second?.headers).toEqual(first?.headers);
    expect(protocol.getSnapshot().command).toBe(command);
    expect(protocol.acknowledge(command, result.data, result.etag)).toBe(true);
  });
  it("historical receipt acknowledges only; the separate authoritative read can return a newer record", async () => {
    const { protocol, command } = setup(),
      newer = { ...contact(3), displayName: "Newer current record" };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok(newer, '"3"'));
    vi.stubGlobal("fetch", fetcher);
    const historical = await contactEditRequest(org, command, "csrf");
    expect(protocol.acknowledge(command, historical.data, historical.etag)).toBe(true);
    expect(await readContactEditContact(org, id)).toEqual({ data: newer, etag: '"3"' });
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(fetcher.mock.calls[1][1]?.body).toBeUndefined();
    expect(protocol.getSnapshot()).toEqual({ command: null, phase: "acknowledged" });
  });
  it("failed current read after acknowledgment cannot recreate or resend the acknowledged command", async () => {
    const { protocol, command } = setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(ok())
        .mockRejectedValueOnce(new TypeError("interrupted read")),
    );
    const saved = await contactEditRequest(org, command, "csrf");
    expect(protocol.acknowledge(command, saved.data, saved.etag)).toBe(true);
    await expect(readContactEditContact(org, id)).rejects.toThrow();
    expect(protocol.getSnapshot()).toEqual({ command: null, phase: "acknowledged" });
    expect(() => protocol.retry()).toThrow();
  });
  it.each([401, 403, 409, 412, 429, 503])(
    "preserves actual HTTP%d despite malformed problem content and exposes no provider text",
    async (status) => {
      const { command } = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response("PRIVATE_PROVIDER_PASSWORD", { status })),
      );
      await expect(contactEditRequest(org, command, "csrf")).rejects.toMatchObject({
        status,
        code: "contact_edit_failed",
        message: "The contact command or read could not be verified.",
      });
    },
  );
  it("retains a valid frozen safe Problem code while discarding detail/title", async () => {
    const { command } = setup();
    const problem = {
      type: "about:blank",
      title: "PRIVATE_TITLE",
      status: 409,
      detail: "PRIVATE_DETAIL",
      code: "receipt_expired",
      traceId: "synthetic-trace",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(JSON.stringify(problem), { status: 409 })),
    );
    await expect(contactEditRequest(org, command, "csrf")).rejects.toMatchObject({
      status: 409,
      code: "receipt_expired",
    });
  });
  it.each([201, 202])("does not accept a successful but wrong mutation status%d", async (status) => {
    const { protocol, command } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => ok(contact(), '"2"', status)),
    );
    await contactEditRequest(org, command, "csrf").catch((error) => protocol.reject(command, error));
    expect(protocol.getSnapshot()).toEqual({ command, phase: "unknown" });
  });
  it.each(["invalid-json", "invalid-utf8", "oversize"])(
    "bounded actual response bytes reject%s as uncertain",
    async (kind) => {
      const { protocol, command } = setup();
      const value =
        kind === "invalid-utf8"
          ? new Uint8Array([0xc3, 0x28])
          : kind === "oversize"
            ? "😀".repeat(contactEditBodyLimit / 4 + 1)
            : "{";
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () => new Response(value, { headers: { "content-length": "0", etag: '"2"' } }),
        ),
      );
      await contactEditRequest(org, command, "csrf").catch((error) => protocol.reject(command, error));
      expect(protocol.getSnapshot()).toEqual({ command, phase: "unknown" });
    },
  );
  it("cancels a streamed response when actual bytes exceed the private limit", async () => {
    const { command } = setup(),
      cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(contactEditBodyLimit + 1));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(stream)),
    );
    await expect(contactEditRequest(org, command, "csrf")).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("times out the owned fetch after20 seconds and leaves an exact retryable unknown command", async () => {
    vi.useFakeTimers();
    const { protocol, command } = setup();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            signal = options!.signal!;
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });
          }),
      ),
    );
    const result = contactEditRequest(org, command, "csrf").catch((error) => protocol.reject(command, error));
    await vi.advanceTimersByTimeAsync(19999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(protocol.getSnapshot()).toEqual({ command, phase: "unknown" });
  });
  it("external lifecycle cancellation cancels a blocked private stream", async () => {
    const { command } = setup(),
      cancel = vi.fn(),
      abort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(stream)),
    );
    const result = contactEditRequest(org, command, "csrf", abort.signal);
    await Promise.resolve();
    await Promise.resolve();
    abort.abort();
    await expect(result).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("a late successful response after a verified context cut cannot acknowledge a different workspace", async () => {
    const { protocol, command } = setup(),
      pending = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => pending.promise),
    );
    const result = contactEditRequest(org, command, "csrf");
    protocol.bind("different-user/org/member/csrf/access");
    pending.resolve(ok());
    const late = await result;
    expect(protocol.acknowledge(command, late.data, late.etag)).toBe(false);
    expect(protocol.getSnapshot()).toEqual({ phase: "idle", command: null });
  });
  it.each(["wrong-id", "weak-etag", "missing-etag", "different-version", "extra", "unsafe-version"])(
    "authoritative GET rejects%s",
    async (kind) => {
      let value: unknown = contact(),
        etag: string | null = '"2"';
      if (kind === "wrong-id") value = { ...contact(), id: key };
      if (kind === "weak-etag") etag = 'W/"2"';
      if (kind === "missing-etag") etag = null;
      if (kind === "different-version") etag = '"3"';
      if (kind === "extra") value = { ...contact(), private: "unapproved" };
      if (kind === "unsafe-version") value = { ...contact(), version: Number.MAX_SAFE_INTEGER + 1 };
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () => new Response(JSON.stringify(value), { headers: etag ? { etag } : {} }),
        ),
      );
      await expect(readContactEditContact(org, id)).rejects.toThrow();
    },
  );
  it("invalid original command/context never invokes fetch or rebuilds a modified body", () => {
    const { command } = setup(),
      fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    for (const invalid of [
      { ...command, serializedBody: "{}" },
      { ...command, key: "invalid" },
      { ...command, body: { displayName: "Later fields" } },
      { ...command, version: 0 },
    ])
      expect(() => contactEditRequest(org, invalid, "csrf")).toThrow();
    expect(() => contactEditRequest("invalid", command, "csrf")).toThrow();
    expect(() => contactEditRequest(org, command, "csrf\nunsafe")).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
