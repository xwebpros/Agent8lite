"use client";
import type { ListListingsParams } from "../api";
export function NaturalLanguageSearch({
  onApply: _onApply,
}: {
  onApply: (filters: ListListingsParams) => void;
}) {
  return (
    <section
      aria-labelledby="natural-language-search-heading"
      className="mb-6 rounded-lg border border-primary/20 bg-primary/5 p-4"
    >
      <h2 id="natural-language-search-heading" className="font-serif text-xl">
        Search in your own words
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Interpret a request, review the filters, then apply them.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          disabled
          aria-label="Natural-language property search"
          placeholder="Homes in Henderson with a pool under $700,000"
          className="flex-1 rounded-md border bg-background px-3 py-2"
        />
        <button disabled type="button" className="rounded bg-primary px-4 py-2 text-primary-foreground">
          Interpret search
        </button>
      </div>
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        The native AI search capability is unavailable. Use the property filters below.
      </p>
    </section>
  );
}
