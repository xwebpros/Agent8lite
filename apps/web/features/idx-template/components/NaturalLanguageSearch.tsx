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
      <p className="mt-1 text-sm text-muted-foreground">
        Try “4-bedroom homes in Henderson under $750k with a pool.” Property filters only.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="natural-language-search" className="sr-only">
          Describe the home you want
        </label>
        <input
          disabled
          id="natural-language-search"
          aria-describedby="natural-language-search-unavailable"
          maxLength={500}
          placeholder="Describe the home you want"
          className="min-h-10 flex-1 rounded border bg-background px-3"
        />
        <button
          disabled
          type="button"
          aria-describedby="natural-language-search-unavailable"
          className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
        >
          Interpret search
        </button>
      </div>
      <p
        id="natural-language-search-unavailable"
        role="status"
        className="mt-2 text-sm text-muted-foreground"
      >
        The native AI search capability is unavailable. Use the property filters below.
      </p>
    </section>
  );
}
