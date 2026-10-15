"use client";
import { Link } from "../navigation";
import { Layout } from "../components/Layout";
import { useState } from "react";
import { FavoriteButton } from "../components/FavoriteButton";
import type { Listing } from "../api";
type FavoriteEntry = { listingKey: string; createdAt: string; updatedAt: string };
type ViewEntry = { listingKey: string; firstViewedAt: string; lastViewedAt: string };
export default function SavedHomes() {
  const [favorites] = useState<FavoriteEntry[]>([]);
  const [views] = useState<ViewEntry[]>([]);
  const [listings] = useState(new Map<string, Listing>());
  const [unavailable] = useState(new Set<string>());
  const section = (title: string, entries: Array<FavoriteEntry | ViewEntry>, favoriteSection: boolean) => {
    const items = entries.map((entry) => ({ entry, listing: listings.get(entry.listingKey) }));
    return (
      <section className="mt-10" aria-labelledby={`${title.toLowerCase().replaceAll(" ", "-")}-heading`}>
        <div className="flex items-baseline justify-between gap-4">
          <h2 id={`${title.toLowerCase().replaceAll(" ", "-")}-heading`} className="font-serif text-2xl">
            {title}
          </h2>
          <span className="text-sm text-muted-foreground">Unavailable</span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {items.length ? (
            items.map(({ entry, listing }) =>
              listing ? (
                <div
                  key={entry.listingKey}
                  className="relative rounded-lg border bg-card p-4 pr-16 transition hover:border-primary"
                >
                  <Link href={`/listing/${encodeURIComponent(listing.listingKey)}`} className="block">
                    <strong className="block truncate">{listing.streetAddress || "Property listing"}</strong>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      {[listing.city, listing.state].filter(Boolean).join(", ")}{" "}
                      {listing.price ? ` · $${listing.price.toLocaleString()}` : ""}
                    </span>
                  </Link>
                  {favoriteSection && (
                    <span className="absolute right-3 top-3">
                      <FavoriteButton listingKey={entry.listingKey} />
                    </span>
                  )}
                </div>
              ) : (
                <div
                  key={entry.listingKey}
                  className="flex items-center justify-between gap-4 rounded-lg border border-dashed p-4"
                >
                  <div>
                    <strong className="block">Property unavailable</strong>
                    <span className="text-sm text-muted-foreground">
                      This listing is no longer in the live feed.
                    </span>
                  </div>
                  {favoriteSection && <FavoriteButton listingKey={entry.listingKey} />}
                </div>
              ),
            )
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-muted-foreground">
              Native visitor saved-home and view-history capabilities are unavailable in this release.
            </p>
          )}
        </div>
      </section>
    );
  };

  const favoriteEntries = favorites.filter(
    (entry) => listings.has(entry.listingKey) || unavailable.has(entry.listingKey),
  );
  const viewEntries = views.filter(
    (entry) => listings.has(entry.listingKey) || unavailable.has(entry.listingKey),
  );
  return (
    <Layout>
      <main className="mx-auto w-full max-w-5xl px-4 py-16 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-widest text-muted-foreground">Your property activity</p>
            <h1 className="mt-3 font-serif text-4xl">Saved and viewed homes</h1>
            <p className="mt-4 max-w-2xl text-muted-foreground">
              Saved homes require a verified native visitor account. Private property activity is not stored
              on this device.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/" className="rounded border px-4 py-2">
              Browse listings
            </Link>
            <Link href="/account/organizer" className="rounded bg-primary px-4 py-2 text-primary-foreground">
              Open organizer
            </Link>
          </div>
        </div>
        {section("Favorites", favoriteEntries, true)}
        {section("Recently viewed", viewEntries, false)}
      </main>
    </Layout>
  );
}
