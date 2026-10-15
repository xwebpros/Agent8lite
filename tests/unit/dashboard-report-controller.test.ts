import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DashboardReportController,
  type DashboardReportClient,
} from "../../apps/web/components/verified-metrics-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const instant = "2026-10-10T12:00:00.000Z";
function report(value = 314159): Schema<"Dashboard"> {
  return {
    period: { from: "2026-10-01T00:00:00.000Z", to: instant, timezone: "UTC" },
    metrics: [
      {
        key: "leads.created",
        definitionVersion: 2,
        value,
        unit: "leads",
        source: "crm-own-utc-month-query-v2",
        state: "available",
        refreshedAt: instant,
      },
    ],
    tasks: [],
    notifications: [],
    integrationHealth: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(options: { online?: boolean; canRead?: boolean } = {}) {
  let now = instant,
    current = true;
  const client = { read: vi.fn<DashboardReportClient["read"]>(async () => report()) };
  const revoked = vi.fn();
  const controller = new DashboardReportController({
    binding: "PRIVATE_CURRENT_MEMBER_REPORT",
    client,
    online: options.online ?? true,
    canRead: options.canRead ?? true,
    now: () => now,
    isCurrent: () => current,
    onAccessRevoked: revoked,
  });
  return {
    controller,
    client,
    revoked,
    setNow: (value: string) => {
      now = value;
    },
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("current-context ephemeral dashboard report controller", () => {
  it("distinguishes untouched/loading/ready and measured zero without inventing engagement", async () => {
    const { controller, client } = setup();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      snapshot: null,
      reading: false,
      receivedAt: null,
    });
    const response = deferred<unknown>();
    client.read.mockReturnValueOnce(response.promise);
    const read = controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ reading: true, snapshot: null, phase: "idle" });
    response.resolve(report(0));
    await read;
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      reading: false,
      stale: false,
      receivedAt: instant,
    });
    expect(controller.getSnapshot().snapshot!.metrics[0].value).toBe(0);
  });
  it("replaces a failed read with a new verified explicit retry and uses fixed safe failure text", async () => {
    const { controller, client } = setup();
    client.read.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_ERROR"));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ phase: "unavailable", reading: false, snapshot: null });
    expect(controller.getSnapshot().error).not.toContain("PRIVATE_PROVIDER_ERROR");
    await controller.refresh();
    expect(controller.getSnapshot().phase).toBe("ready");
    expect(client.read).toHaveBeenCalledTimes(2);
  });
  it("detaches and freezes received rows before exposing a successful report", async () => {
    const { controller, client } = setup(),
      source = report();
    client.read.mockResolvedValueOnce(source);
    await controller.refresh();
    source.metrics[0].value = 900;
    expect(controller.getSnapshot().snapshot!.metrics[0].value).toBe(314159);
    expect(Object.isFrozen(controller.getSnapshot())).toBe(true);
    expect(Object.isFrozen(controller.getSnapshot().snapshot!.metrics)).toBe(true);
  });
  it("clears an old projection synchronously before a refresh and withholds it if the read fails", async () => {
    const { controller, client } = setup();
    await controller.refresh();
    const response = deferred<unknown>();
    client.read.mockReturnValueOnce(response.promise);
    const read = controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ snapshot: null, receivedAt: null, reading: true });
    response.reject(new Error());
    await read;
    expect(controller.getSnapshot()).toMatchObject({ snapshot: null, phase: "unavailable" });
  });
  it.each(["offline", "hidden", "permissions", "detach", "revoke", "invalidate"] as const)(
    "drops private rows synchronously at a%s cut and aborts a pending read",
    async (cut) => {
      const { controller, client } = setup();
      await controller.refresh();
      const response = deferred<unknown>();
      client.read.mockReturnValueOnce(response.promise);
      const read = controller.refresh();
      const signal = client.read.mock.calls.at(-1)![0]!;
      if (cut === "offline") controller.setOnline(false);
      if (cut === "hidden") controller.setVisible(false);
      if (cut === "permissions") controller.setPermissions(false);
      if (cut === "detach") controller.detach();
      if (cut === "revoke") controller.revoke();
      if (cut === "invalidate") controller.invalidate();
      expect(controller.getSnapshot()).toMatchObject({ snapshot: null, receivedAt: null, reading: false });
      expect(signal.aborted).toBe(true);
      response.resolve(report());
      await read;
      expect(controller.getSnapshot().snapshot).toBeNull();
    },
  );
  it("rejects a late same-org member/access response even when no explicit lifecycle method ran", async () => {
    const { controller, client, setCurrent } = setup();
    const response = deferred<unknown>();
    client.read.mockReturnValueOnce(response.promise);
    const read = controller.refresh();
    setCurrent(false);
    response.resolve(report());
    await read;
    controller.tick();
    expect(controller.getSnapshot()).toMatchObject({ snapshot: null, receivedAt: null, reading: false });
  });
  it("an older out-of-order response cannot overwrite a later successful current read", async () => {
    const { controller, client } = setup();
    const first = deferred<unknown>();
    client.read.mockReturnValueOnce(first.promise);
    const old = controller.refresh();
    await controller.refresh();
    first.resolve(report(9));
    await old;
    expect(controller.getSnapshot().snapshot!.metrics[0].value).toBe(314159);
  });
  it("supports StrictMode detach/attach without accepting the old request or restoring retained private memory", async () => {
    const { controller, client } = setup();
    const first = deferred<unknown>();
    client.read.mockReturnValueOnce(first.promise);
    const old = controller.refresh();
    controller.detach();
    controller.attach();
    await controller.refresh();
    first.resolve(report(9));
    await old;
    expect(controller.getSnapshot().snapshot!.metrics[0].value).toBe(314159);
  });
  it.each([401, 403])(
    "revokes the report on current HTTP%s instead of keeping a private measurement or retrying silently",
    async (status) => {
      const { controller, client, revoked } = setup();
      await controller.refresh();
      client.read.mockRejectedValueOnce(new ApiError(status, "PRIVATE_DENIAL", "permission_denied"));
      await controller.refresh();
      expect(controller.getSnapshot()).toMatchObject({ phase: "denied", canRead: false, snapshot: null });
      expect(revoked).toHaveBeenCalledOnce();
      controller.setPermissions(true);
      await controller.refresh();
      expect(client.read).toHaveBeenCalledTimes(2);
      expect(controller.getSnapshot().error).not.toContain("PRIVATE_DENIAL");
    },
  );
  it.each([404, 408, 429, 503])("treats HTTP%s as unavailable with a safe explicit retry", async (status) => {
    const { controller, client, revoked } = setup();
    client.read.mockRejectedValueOnce(new ApiError(status, "PRIVATE_FAILURE"));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ phase: "unavailable", snapshot: null, canRead: true });
    expect(revoked).not.toHaveBeenCalled();
    await controller.refresh();
    expect(controller.getSnapshot().phase).toBe("ready");
  });
  it("does not let a late denied old generation revoke a newer successful binding", async () => {
    const { controller, client, revoked } = setup(),
      response = deferred<unknown>();
    client.read.mockReturnValueOnce(response.promise);
    const old = controller.refresh();
    await controller.refresh();
    response.reject(new ApiError(403, "old access"));
    await old;
    expect(controller.getSnapshot().phase).toBe("ready");
    expect(revoked).not.toHaveBeenCalled();
  });
  it("expires exactly at five minutes, removes current numeric projections, and permits a fresh measurement", async () => {
    const { controller, client, setNow } = setup();
    await controller.refresh();
    setNow("2026-10-10T12:04:59.999Z");
    controller.tick();
    expect(controller.getSnapshot().phase).toBe("ready");
    setNow("2026-10-10T12:05:00.000Z");
    controller.tick();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "stale",
      snapshot: null,
      stale: true,
      receivedAt: null,
    });
    const fresh = report(0);
    fresh.period.to = "2026-10-10T12:05:00.000Z";
    fresh.metrics[0].refreshedAt = fresh.period.to;
    client.read.mockResolvedValueOnce(fresh);
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ phase: "ready", stale: false });
  });
  it.each(["PRIVATE_BAD_CLOCK", "2026-10-10T11:59:59.999Z"])(
    "fails closed for invalid or backwards visible client clock%s",
    async (now) => {
      const { controller, setNow } = setup();
      setNow(now);
      await controller.refresh();
      expect(controller.getSnapshot()).toMatchObject({ phase: "stale", stale: true, snapshot: null });
    },
  );
  it("does not accept malformed closed response metadata but does permit explicitly unsupported definitions", async () => {
    const { controller, client } = setup();
    client.read.mockResolvedValueOnce({ ...report(), privateData: "PRIVATE" });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ phase: "unavailable", snapshot: null });
    const source = report();
    source.metrics[0].definitionVersion = 999;
    client.read.mockResolvedValueOnce(source);
    await controller.refresh();
    expect(controller.getSnapshot().phase).toBe("ready");
  });
  it("does not request or retain a report while offline, hidden, detached or lacking permission", async () => {
    for (const cut of ["offline", "hidden", "detached", "permission"]) {
      const { controller, client } = setup();
      if (cut === "offline") controller.setOnline(false);
      if (cut === "hidden") controller.setVisible(false);
      if (cut === "detached") controller.detach();
      if (cut === "permission") controller.setPermissions(false);
      await controller.refresh();
      expect(client.read).not.toHaveBeenCalled();
      expect(controller.getSnapshot().snapshot).toBeNull();
    }
  });
  it("notifies subscribers about observable changes and stops after unsubscription", async () => {
    const { controller } = setup(),
      observer = vi.fn();
    const unsubscribe = controller.subscribe(observer);
    await controller.refresh();
    expect(observer).toHaveBeenCalled();
    unsubscribe();
    observer.mockClear();
    controller.setOnline(false);
    expect(observer).not.toHaveBeenCalled();
  });
});
