"use client";
import { Link } from "../navigation";
import { Layout } from "../components/Layout";
export default function SavedHomes() {
  return (
    <Layout>
      <main className="mx-auto w-full max-w-5xl px-4 py-16 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-widest text-muted-foreground">Your property activity</p>
            <h1 className="mt-3 font-serif text-4xl">Saved and viewed homes</h1>
            <p className="mt-4 max-w-2xl text-muted-foreground">
              Saved homes require a verified native visitor account. This template does not store property
              activity on this device.
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
        {["Favorites", "Recently viewed"].map((title) => (
          <section key={title} className="mt-10">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-serif text-2xl">{title}</h2>
              <span className="text-sm text-muted-foreground">Unavailable</span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <p role="status" className="rounded-lg border border-dashed p-6 text-muted-foreground">
                Native visitor {title.toLowerCase()} is unavailable in this release.
              </p>
            </div>
          </section>
        ))}
      </main>
    </Layout>
  );
}
