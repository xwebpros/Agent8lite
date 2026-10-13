"use client";
import { Link } from "../navigation";
import { Layout } from "../components/Layout";
import { useState } from "react";
import { ListingCard } from "../components/ListingCard";
import type { Listing, ListListingsParams as SavedSearchCriteria } from "../api";
import type { components } from "../../../../../packages/contracts/generated/api";
// Local render models for preserved source panels; no transport, inference or simulated API exists.
type SearchRow = Omit<components["schemas"]["SavedSearch"], "criteria"> & {
  criteria: SavedSearchCriteria;
  enabled: boolean;
  alertFrequency: string;
  alertChannel: string;
};
type Comparison = { items: Array<{ id: string; listingKey: string }> };
type Profile = {
  version: number;
  inferenceEnabled: boolean;
  preferences: Array<{
    dimension: string;
    value: string | number | boolean;
    source: string;
    confidence: number;
    evidence: Array<{ source: string }>;
  }>;
};
type Preference = { category: string; channel: string; enabled: boolean };
type Alert = {
  id: string;
  alertType: string;
  listingKey: string;
  deliveryStatus: string;
  detectedAt: string;
};
function summary(criteria: SavedSearchCriteria) {
  const labels = [
    criteria.city,
    criteria.zip,
    criteria.beds !== undefined ? `${criteria.beds}+ beds` : undefined,
    criteria.baths !== undefined ? `${criteria.baths}+ baths` : undefined,
    criteria.minPrice !== undefined ? `$${criteria.minPrice.toLocaleString()}+` : undefined,
    criteria.pool ? "pool" : undefined,
  ].filter(Boolean);
  return labels.length ? labels.join(" · ") : "All active listings";
}

function searchUrl(criteria: SavedSearchCriteria) {
  const params = new URLSearchParams();
  Object.entries(criteria).forEach(([key, value]) => {
    if (value !== undefined) params.set(key, String(value));
  });
  params.set("reset", "1");
  return `/?${params.toString()}`;
}

export default function Organizer() {
  const [notice, setNotice] = useState(
    "Native visitor organizer capabilities are unavailable in this release.",
  );
  const [searches] = useState<SearchRow[]>([]);
  const [comparison] = useState<Comparison | null>(null);
  const [resolved] = useState(new Map<string, Listing>());
  const [profile] = useState<Profile | null>(null);
  const [preferences] = useState<Preference[]>([]);
  const [alerts] = useState<Alert[]>([]);
  const [recommendations] = useState<{ items: Listing[]; reasons: string[] } | null>(null);
  const unavailable = (..._input: unknown[]) =>
    setNotice("This native visitor capability is unavailable. No customer state or messages changed.");
  const updateAlertSettings = unavailable,
    editCriteria = unavailable,
    renameSearch = unavailable,
    toggleSearch = unavailable,
    removeSearch = unavailable,
    removeComparison = unavailable,
    toggleInference = unavailable,
    resetPreferences = unavailable,
    togglePreference = unavailable;
  return (
    <Layout>
      <main className="mx-auto w-full max-w-5xl px-4 py-14 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-primary">Property organizer</p>
            <h1 className="mt-3 font-serif text-4xl">Your property workspace</h1>
            <p className="mt-3 text-muted-foreground">
              Keep searches, comparisons, and alerts organized in one private account.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/account/favorites" className="rounded border px-4 py-2">
              Saved homes
            </Link>
            <Link href="/" className="rounded bg-primary px-4 py-2 text-primary-foreground">
              Browse listings
            </Link>
          </div>
        </div>
        {notice && (
          <p role="status" className="mt-5 rounded border border-primary/30 bg-primary/5 p-3 text-sm">
            {notice}
          </p>
        )}
        <section className="mt-10 rounded-lg border bg-card p-5" aria-labelledby="saved-searches-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="saved-searches-heading" className="font-serif text-2xl">
                Saved searches
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Save the active filters from the search page, then reopen them here.
              </p>
            </div>
            <Link href="/" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">
              Browse and save
            </Link>
          </div>
          <div className="mt-4 space-y-2">
            {searches.length ? (
              searches.map((search) => (
                <div
                  key={search.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"
                >
                  <div>
                    <strong>{search.name}</strong>
                    <p className="text-sm text-muted-foreground">{summary(search.criteria)}</p>
                    <span className="text-xs text-muted-foreground">
                      {search.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <label>
                        Frequency{" "}
                        <select
                          disabled
                          value={search.alertFrequency}
                          onChange={(event) =>
                            void updateAlertSettings(search, "alertFrequency", event.target.value)
                          }
                        >
                          <option value="immediate">Immediate</option>
                          <option value="hourly">Hourly</option>
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                        </select>
                      </label>
                      <label>
                        Channel{" "}
                        <select
                          disabled
                          value={search.alertChannel}
                          onChange={(event) =>
                            void updateAlertSettings(search, "alertChannel", event.target.value)
                          }
                        >
                          <option value="email">Email</option>
                          <option value="sms">SMS</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-3 text-sm">
                    <Link href={searchUrl(search.criteria)} className="text-primary underline">
                      Open
                    </Link>
                    <button
                      type="button"
                      disabled
                      onClick={() => void editCriteria(search)}
                      className="underline"
                    >
                      Edit criteria
                    </button>
                    <button
                      type="button"
                      disabled
                      onClick={() => void renameSearch(search)}
                      className="underline"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      disabled
                      onClick={() => void toggleSearch(search)}
                      className="underline"
                    >
                      {search.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      disabled
                      onClick={() => void removeSearch(search.id)}
                      className="text-destructive underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="rounded border border-dashed p-5 text-sm text-muted-foreground">
                Native visitor saved searches are unavailable in this release.
              </p>
            )}
          </div>
        </section>
        <section className="mt-8 rounded-lg border bg-card p-5" aria-labelledby="comparison-heading">
          <div className="flex items-center justify-between">
            <h2 id="comparison-heading" className="font-serif text-2xl">
              Compare properties
            </h2>
            <span className="text-sm text-muted-foreground">Unavailable · 4 maximum</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {comparison?.items.length ? (
              comparison.items.map((item) => {
                const listing = resolved.get(item.listingKey);
                return (
                  <div key={item.id} className="rounded border p-4">
                    <strong>{listing?.streetAddress || "Property listing"}</strong>
                    <p className="text-sm text-muted-foreground">
                      {listing
                        ? `${listing.city || ""} · ${listing.price ? `$${listing.price.toLocaleString()}` : "Price upon request"}`
                        : "Property unavailable in the live feed"}
                    </p>
                    <button
                      type="button"
                      disabled
                      onClick={() => void removeComparison(item.listingKey)}
                      className="mt-3 text-sm text-destructive underline"
                    >
                      Remove
                    </button>
                  </div>
                );
              })
            ) : (
              <p className="rounded border border-dashed p-5 text-sm text-muted-foreground">
                Native property comparisons are unavailable in this release.
              </p>
            )}
          </div>
        </section>
        <section className="mt-8 rounded-lg border bg-card p-5" aria-labelledby="recommendations-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="recommendations-heading" className="font-serif text-2xl">
                Recommended for you
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Permitted listings matched to your saved property activity when this capability is enabled.
              </p>
            </div>
            {profile && <span className="text-xs text-muted-foreground">Profile {profile.version}</span>}
          </div>
          {recommendations ? (
            <>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                {recommendations.reasons.map((reason) => (
                  <span key={reason} className="rounded-full bg-primary/10 px-3 py-1 text-primary">
                    {reason}
                  </span>
                ))}
              </div>
              <div className="mt-5 grid gap-5 md:grid-cols-2">
                {recommendations.items.slice(0, 4).map((listing) => (
                  <ListingCard key={listing.listingKey} listing={listing} />
                ))}
              </div>
              {!recommendations.items.length && (
                <p className="mt-4 rounded border border-dashed p-5 text-sm text-muted-foreground">
                  Save a search or favorite a property to get recommendations.
                </p>
              )}
            </>
          ) : (
            <p className="mt-4 rounded border border-dashed p-5 text-sm text-muted-foreground">
              Recommendations are unavailable. No property preferences have been inferred.
            </p>
          )}
        </section>
        <section
          className="mt-8 rounded-lg border bg-card p-5"
          aria-labelledby="inferred-preferences-heading"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="inferred-preferences-heading" className="font-serif text-2xl">
                Your property preferences
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Inferred values are based on saved searches and resolved favorites. They never create
                communication consent.
              </p>
            </div>
            <div className="flex gap-3 text-sm">
              <button type="button" disabled onClick={() => void toggleInference()} className="underline">
                {profile
                  ? profile.inferenceEnabled === false
                    ? "Enable inference"
                    : "Disable inference"
                  : "Inference unavailable"}
              </button>
              <button
                type="button"
                disabled
                onClick={() => void resetPreferences()}
                className="text-destructive underline"
              >
                Reset
              </button>
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {profile?.preferences.length ? (
              profile.preferences.map((item) => (
                <div key={item.dimension} className="rounded border p-3">
                  <strong className="capitalize">{item.dimension.replace(/([A-Z])/g, " $1")}</strong>
                  <p className="text-sm">{String(item.value)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.source} · {Math.round(item.confidence * 100)}% confidence · From{" "}
                    {item.evidence[0]?.source.replaceAll("_", " ")}
                  </p>
                </div>
              ))
            ) : (
              <p className="rounded border border-dashed p-5 text-sm text-muted-foreground">
                Property preference inference is unavailable in this release.
              </p>
            )}
          </div>
        </section>
        <section className="mt-8 rounded-lg border bg-card p-5" aria-labelledby="notification-heading">
          <h2 id="notification-heading" className="font-serif text-2xl">
            Notification preferences
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            These preferences do not create communication consent. Future messages must still satisfy consent
            and suppression rules.
          </p>
          <div className="mt-4 space-y-2">
            {preferences.length ? (
              preferences.map((preference, index) => (
                <label
                  key={`${preference.category}-${preference.channel}`}
                  className="flex items-center justify-between rounded border p-3 text-sm"
                >
                  <span>
                    {preference.category.replaceAll("_", " ")} via {preference.channel}
                  </span>
                  <input
                    type="checkbox"
                    disabled
                    checked={preference.enabled}
                    onChange={() => void togglePreference(index)}
                    aria-label={`${preference.category} ${preference.channel}`}
                  />
                </label>
              ))
            ) : (
              <p className="rounded border border-dashed p-5 text-sm text-muted-foreground">
                Native visitor notification preferences are unavailable. No message has been scheduled.
              </p>
            )}
          </div>
        </section>
        <section className="mt-8 rounded-lg border bg-card p-5" aria-labelledby="alerts-heading">
          <h2 id="alerts-heading" className="font-serif text-2xl">
            Alert history
          </h2>
          <div className="mt-4 space-y-2">
            {alerts.length ? (
              alerts.map((alert) => (
                <div key={alert.id} className="rounded border p-3 text-sm">
                  <strong>{alert.alertType.replaceAll("_", " ")}</strong>
                  <span className="ml-2 text-muted-foreground">{alert.listingKey}</span>
                  <p className="text-muted-foreground">
                    {alert.deliveryStatus} · {new Date(alert.detectedAt).toLocaleString()}
                  </p>
                </div>
              ))
            ) : (
              <p className="rounded border border-dashed p-5 text-sm text-muted-foreground">
                Licensed listing alerts are unavailable. No email or SMS has been sent.
              </p>
            )}
          </div>
        </section>
      </main>
    </Layout>
  );
}
