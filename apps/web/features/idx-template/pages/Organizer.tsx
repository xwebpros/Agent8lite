"use client";
import { Link } from "../navigation";
import { Layout } from "../components/Layout";
const panels = [
  [
    "Saved searches",
    "Save the active filters from the search page, then reopen them here.",
    "Native visitor saved searches are unavailable in this release.",
  ],
  [
    "Compare properties",
    "Review up to four properties side by side.",
    "Property comparisons are unavailable in this release.",
  ],
  [
    "Recommended for you",
    "Properties matched to permitted saved property activity.",
    "Recommendations are unavailable. No preferences have been inferred.",
  ],
  [
    "Property preferences",
    "Control whether permitted activity can inform recommendations.",
    "Preference inference and reset are unavailable in this release.",
  ],
  [
    "Notification preferences",
    "Choose eligible channels and frequency for workspace updates.",
    "Native visitor notifications are unavailable. No messages are scheduled.",
  ],
  [
    "Listing alerts",
    "Review eligible saved-search alert history.",
    "Licensed listing alerts are unavailable. No email or SMS has been sent.",
  ],
];
export default function Organizer() {
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
        {panels.map(([title, description, unavailable], index) => (
          <section
            key={title}
            className={`${index ? "mt-8" : "mt-10"} rounded-lg border bg-card p-5`}
            aria-labelledby={`organizer-${index}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id={`organizer-${index}`} className="font-serif text-2xl">
                  {title}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{description}</p>
              </div>
              {index === 0 && (
                <Link href="/" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">
                  Browse and save
                </Link>
              )}
            </div>
            <p role="status" className="mt-4 rounded border border-dashed p-5 text-sm text-muted-foreground">
              {unavailable}
            </p>
          </section>
        ))}
      </main>
    </Layout>
  );
}
