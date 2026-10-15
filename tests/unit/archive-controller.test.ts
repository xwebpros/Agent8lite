import { describe, expect, it, vi } from "vitest";
import {
  RecordArchiveProtocol,
  recordArchiveContext,
  recordArchiveEligible,
  type RecordArchiveCommand,
  type RecordArchiveCurrent,
} from "../../apps/web/components/record-archive";
import { RecordArchiveController } from "../../apps/web/components/record-archive-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const org = "ad000000-0000-4000-8000-000000000001",
  user = "ad000000-0000-4000-8000-000000000002",
  member = "ad000000-0000-4000-8000-000000000003",
  contactId = "ad000000-0000-4000-8000-000000000004",
  leadId = "ad000000-0000-4000-8000-000000000005",
  key = "ad000000-0000-4000-8000-000000000006",
  otherKey = "ad000000-0000-4000-8000-000000000008",
  csrf = "synthetic-csrf",
  horizon = 23 * 60 * 60 * 1000;
const session = (permissions = ["crm.contacts.write", "crm.leads.write"]): Schema<"Session"> => ({
  userId: user,
  activeOrgId: org,
  organizations: [],
  permissions,
  profile: { displayName: "Synthetic", timezone: "UTC" },
});
const binding = (permissions?: string[]) =>
  recordArchiveContext({ session: session(permissions), memberId: member, csrf, accessRevision: 1 })!;
const job = (kind = "crm.contact.archived") => ({
  id: "ad000000-0000-4000-8000-000000000007",
  state: "succeeded",
  kind,
  createdAt: "2026-10-11T10:00:00.000Z",
  resultUrl: null,
  error: null,
});
type Request = (
  command: RecordArchiveCommand,
  token: string,
) => Promise<{ data: unknown; etag: string | null }>;
function setup(request: Request) {
  let wall = 1_000_000,
    mono = 1000;
  const protocol = new RecordArchiveProtocol({ wallNow: () => wall, monotonicNow: () => mono });
  protocol.bind(binding());
  const spy = vi.fn(request);
  const controller = new RecordArchiveController(protocol, spy);
  const command = controller.begin({ kind: "contact", resourceId: contactId, version: 4 }, key);
  return {
    protocol,
    controller,
    spy,
    command,
    clock: (w: number, m: number) => {
      wall = w;
      mono = m;
    },
  };
}
const allow = () => ({ allowed: () => true, dispatched: vi.fn() });
const unknownThenAck = () => {
  let calls = 0;
  return async () => {
    if (++calls === 1) throw new TypeError("network interrupted");
    return { data: job(), etag: '"5"' };
  };
};

describe("ADR-047 controller: unknown outcome and exact reconciliation", () => {
  it("unknown outcome retains the command and reconciles with the same object, route and key", async () => {
    const v = setup(unknownThenAck());
    const first = await v.controller.send(v.command, csrf, allow());
    expect(first).toEqual({ type: "unknown", command: v.command, sent: true });
    expect(v.protocol.getSnapshot()).toMatchObject({ phase: "unknown", command: v.command });
    expect(() => v.controller.begin({ kind: "lead", resourceId: leadId, version: 1 }, otherKey)).toThrow();
    const second = await v.controller.reconcile(v.command, csrf, allow());
    expect(second).toEqual({ type: "acknowledged", command: v.command });
    expect(v.spy).toHaveBeenCalledTimes(2);
    expect(v.spy.mock.calls[1]![0]).toBe(v.spy.mock.calls[0]![0]);
    expect(v.spy.mock.calls[1]![0]).toMatchObject({
      key,
      route: `/v1/orgs/${org}/contacts/${contactId}/archive`,
    });
    expect(v.protocol.getSnapshot()).toMatchObject({ phase: "acknowledged", command: null });
  });
  it("an unverifiable receipt stays unknown with the command retained", async () => {
    const v = setup(async () => ({ data: job("crm.lead.archived"), etag: '"5"' }));
    expect(await v.controller.send(v.command, csrf, allow())).toEqual({
      type: "unknown",
      command: v.command,
      sent: true,
    });
    expect(v.protocol.getSnapshot().command).toBe(v.command);
  });
  it("404 or receipt_expired during reconciliation does not release the command", async () => {
    let calls = 0;
    const v = setup(async () => {
      if (++calls === 1) throw new TypeError("network");
      throw new ApiError(
        calls === 2 ? 404 : 409,
        "x",
        calls === 2 ? "resource_unavailable" : "receipt_expired",
      );
    });
    await v.controller.send(v.command, csrf, allow());
    expect(await v.controller.reconcile(v.command, csrf, allow())).toMatchObject({ type: "unknown" });
    expect(await v.controller.reconcile(v.command, csrf, allow())).toMatchObject({ type: "unknown" });
    expect(v.protocol.getSnapshot().command).toBe(v.command);
  });
  it("expired retry window throws without sending and then permits forgetting", async () => {
    const v = setup(async () => {
      throw new TypeError("network");
    });
    await v.controller.send(v.command, csrf, allow());
    v.clock(1_000_000 + horizon, 1000 + horizon);
    await expect(v.controller.reconcile(v.command, csrf, allow())).rejects.toThrow();
    expect(v.spy).toHaveBeenCalledTimes(1);
    expect(v.controller.forget(v.command)).toBe(true);
    expect(v.protocol.getSnapshot().phase).toBe("forgotten");
  });
  it("reconcile of a stale or mismatched expected command is ignored", async () => {
    const v = setup(async () => {
      throw new TypeError("network");
    });
    await v.controller.send(v.command, csrf, allow());
    expect(await v.controller.reconcile({ ...v.command }, csrf, allow())).toEqual({ type: "ignored" });
    expect(await v.controller.reconcile(null, csrf, allow())).toEqual({ type: "ignored" });
    expect(v.spy).toHaveBeenCalledTimes(1);
  });
});

describe("definitive rejection releases", () => {
  it.each([
    [new ApiError(409, "x", "contact_has_active_leads"), "blocked"],
    [new ApiError(404, "x", "resource_unavailable"), "unavailable"],
    [new ApiError(422, "x", "body_not_allowed"), "rejected"],
    [new ApiError(409, "x", "idempotency_conflict"), "rejected"],
  ])("initial %s releases as %s and permits a fresh command", async (error, phase) => {
    const v = setup(async () => {
      throw error;
    });
    expect(await v.controller.send(v.command, csrf, allow())).toEqual({
      type: "released",
      command: v.command,
      phase,
    });
    expect(v.protocol.getSnapshot().command).toBeNull();
    expect(
      v.controller.begin({ kind: "contact", resourceId: contactId, version: 4 }, otherKey),
    ).toMatchObject({
      key: otherKey,
    });
  });
  it.each([401, 403])("%s denies and unbinds", async (status) => {
    const v = setup(async () => {
      throw new ApiError(status, "x");
    });
    expect(await v.controller.send(v.command, csrf, allow())).toEqual({ type: "denied", command: v.command });
    expect(v.protocol.getSnapshot().phase).toBe("denied");
    expect(() =>
      v.controller.begin({ kind: "contact", resourceId: contactId, version: 4 }, otherKey),
    ).toThrow();
  });
});

describe("stale callbacks and binding loss", () => {
  function deferred() {
    let resolve!: (value: { data: unknown; etag: string | null }) => void, reject!: (error: unknown) => void;
    const promise = new Promise<{ data: unknown; etag: string | null }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  it("a late success after the binding changes is ignored and never acknowledges", async () => {
    const d = deferred();
    const v = setup(() => d.promise);
    const pending = v.controller.send(v.command, csrf, allow());
    expect(v.controller.isActive(v.command)).toBe(true);
    v.protocol.bind(binding(["crm.contacts.write"]));
    expect(v.protocol.getSnapshot()).toEqual({ command: null, phase: "idle", subject: null });
    expect(v.controller.isActive()).toBe(false);
    d.resolve({ data: job(), etag: '"5"' });
    expect(await pending).toEqual({ type: "ignored" });
    expect(v.protocol.getSnapshot().phase).toBe("idle");
  });
  it.each([
    ["denial", new ApiError(403, "late")],
    ["definitive rejection", new ApiError(409, "x", "contact_has_active_leads")],
    ["network", new TypeError("late")],
  ])("a late %s after binding loss is ignored", async (_, error) => {
    const d = deferred();
    const v = setup(() => d.promise);
    const pending = v.controller.send(v.command, csrf, allow());
    v.protocol.bind(null);
    d.reject(error);
    expect(await pending).toEqual({ type: "ignored" });
    expect(v.protocol.getSnapshot()).toEqual({ command: null, phase: "idle", subject: null });
  });
  it("a second send while the first is on the wire never dispatches", async () => {
    const d = deferred();
    const v = setup(() => d.promise);
    const first = v.controller.send(v.command, csrf, allow());
    expect(await v.controller.send(v.command, csrf, allow())).toEqual({ type: "ignored" });
    expect(() => v.controller.begin({ kind: "lead", resourceId: leadId, version: 1 }, otherKey)).toThrow();
    expect(v.controller.forget(v.command)).toBe(false);
    d.resolve({ data: job(), etag: '"5"' });
    expect(await first).toMatchObject({ type: "acknowledged" });
    expect(v.spy).toHaveBeenCalledTimes(1);
  });
  it("a failed live recheck sends nothing and conservatively retains the command", async () => {
    const v = setup(async () => ({ data: job(), etag: '"5"' }));
    const hooks = { allowed: () => false, dispatched: vi.fn() };
    expect(await v.controller.send(v.command, csrf, hooks)).toEqual({
      type: "unknown",
      command: v.command,
      sent: false,
    });
    expect(v.spy).not.toHaveBeenCalled();
    expect(hooks.dispatched).not.toHaveBeenCalled();
  });
  it("a throwing recheck is treated as not allowed", async () => {
    const v = setup(async () => ({ data: job(), etag: '"5"' }));
    const outcome = await v.controller.send(v.command, csrf, {
      allowed: () => {
        throw new Error("hostile");
      },
    });
    expect(outcome).toMatchObject({ type: "unknown", sent: false });
    expect(v.spy).not.toHaveBeenCalled();
  });
  it("dispatch protection runs synchronously before the request", async () => {
    const order: string[] = [];
    const v = setup(async () => {
      order.push("request");
      return { data: job(), etag: '"5"' };
    });
    await v.controller.send(v.command, csrf, {
      allowed: () => true,
      dispatched: () => order.push("dispatched"),
    });
    expect(order).toEqual(["dispatched", "request"]);
  });
  it("a command from a replaced protocol state is ignored without a request", async () => {
    const v = setup(async () => ({ data: job(), etag: '"5"' }));
    v.protocol.bind(binding(["crm.leads.write"]));
    expect(await v.controller.send(v.command, csrf, allow())).toEqual({ type: "ignored" });
    expect(v.spy).not.toHaveBeenCalled();
  });
});

describe("drawer eligibility", () => {
  const live = (patch: Partial<RecordArchiveCurrent> = {}): RecordArchiveCurrent => ({
    binding: binding(),
    active: true,
    online: true,
    visible: true,
    changingOrganization: false,
    busy: false,
    loading: false,
    detailLoading: false,
    dirty: false,
    otherProtected: false,
    kind: "contact",
    resourceId: contactId,
    ...patch,
  });
  it("exact current drawer accepts case-normalized identity", () => {
    expect(
      recordArchiveEligible(binding(), live({ resourceId: contactId.toUpperCase() }), "contact", contactId),
    ).toBe(true);
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
    { kind: "lead" },
    { resourceId: leadId },
    { resourceId: null },
  ])("context cut %j cannot begin or send", (patch) => {
    expect(recordArchiveEligible(binding(), live(patch), "contact", contactId)).toBe(false);
  });
  it("a binding without the kind's write grant is not eligible", () => {
    const contactOnly = binding(["crm.contacts.write"]);
    expect(
      recordArchiveEligible(
        contactOnly,
        live({ binding: contactOnly, kind: "lead", resourceId: leadId }),
        "lead",
        leadId,
      ),
    ).toBe(false);
  });
});
