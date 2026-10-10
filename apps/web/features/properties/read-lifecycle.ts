type ReadKind = "list" | "detail";
type PropertyRead = { kind: ReadKind; scope: string; controller: AbortController };

/** A cleared surface cannot be restored by a transport that finishes after abort. */
export class PropertyReads {
  private pending = new Map<ReadKind, PropertyRead>();
  private ongoing = new Set<PropertyRead>();
  private clearing = 0;

  begin(kind: ReadKind, scope: string): PropertyRead {
    const read = { kind, scope, controller: new AbortController() };
    if (this.clearing) {
      read.controller.abort();
      return read;
    }
    const previous = this.pending.get(kind);
    // Publish the replacement first: a synchronous abort callback may supersede it again.
    this.pending.set(kind, read);
    this.ongoing.add(read);
    if (previous) {
      this.ongoing.delete(previous);
      previous.controller.abort();
    }
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
    const read = this.pending.get(kind);
    this.pending.delete(kind);
    if (read) {
      this.ongoing.delete(read);
      read.controller.abort();
    }
  }

  busy(kind: ReadKind) {
    const read = this.pending.get(kind);
    return read !== undefined && this.ongoing.has(read);
  }

  finish(read: PropertyRead) {
    this.ongoing.delete(read);
  }

  clear() {
    ++this.clearing;
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.ongoing.clear();
    try {
      // Both surfaces are retired before any abort handler can run or attempt another read.
      for (const read of pending) read.controller.abort();
    } finally {
      --this.clearing;
    }
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
