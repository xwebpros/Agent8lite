"use client";
import type { ListListingsParams } from "../api";
export function SaveSearchButton({ filters: _filters }: { filters: ListListingsParams }) {
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" disabled className="rounded border px-3 py-2 text-sm hover:border-primary">
        Save this search
      </button>
      <span role="status" className="text-xs text-muted-foreground">
        Native visitor saved searches are unavailable in this release.
      </span>
    </span>
  );
}
export function CompareButton({ listingKey }: { listingKey: string }) {
  return (
    <button
      type="button"
      disabled
      title="Property comparison is unavailable."
      className="rounded border bg-background px-2 py-1 text-xs hover:border-primary"
      aria-label={`Compare property ${listingKey}: unavailable`}
    >
      Compare
    </button>
  );
}
