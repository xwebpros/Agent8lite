type ReadKind = "list" | "detail";
type PropertyRead = { kind: ReadKind; scope: string; controller: AbortController };

/** A cleared surface cannot be restored by a transport that finishes after abort. */
export class PropertyReads {
  private pending = new Map<ReadKind, PropertyRead>();

  begin(kind: ReadKind, scope: string): PropertyRead {
    this.cancel(kind);
    const read = { kind, scope, controller: new AbortController() };
    this.pending.set(kind, read);
    return read;
  }

  current(read: PropertyRead, scope: string, enabled: boolean) {
    return (
      enabled &&
      read.scope === scope &&
      this.pending.get(read.kind) === read &&
      !read.controller.signal.aborted
    );
  }

  cancel(kind: ReadKind) {
    this.pending.get(kind)?.controller.abort();
    this.pending.delete(kind);
  }

  clear() {
    this.cancel("list");
    this.cancel("detail");
  }
}

type ExpiringProperty = { expiresAt: string };

export function propertiesAreCurrent(items: readonly ExpiringProperty[], now = Date.now()) {
  return Number.isFinite(now) && items.every((item) => Date.parse(item.expiresAt) > now);
}

/** Browser timers overflow beyond a signed 32-bit delay; recheck before clearing. */
export function propertyExpiryDelay(items: readonly ExpiringProperty[], now = Date.now()) {
  if (!items.length) return null;
  if (!propertiesAreCurrent(items, now)) return 0;
  return Math.min(2_147_483_647, Math.min(...items.map((item) => Date.parse(item.expiresAt))) - now);
}
