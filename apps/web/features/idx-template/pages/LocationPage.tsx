"use client";
import { ArrowRight, ChevronRight } from "lucide-react";
import { Layout } from "../components/Layout";
import { Link, useRoute } from "../navigation";
import { publicLocations } from "../lib/location-seo";
export default function LocationPage() {
  const [, params] = useRoute<{ slug: string }>("/communities/:slug");
  const location = publicLocations.find((item) => item.slug === params?.slug);
  const label = location?.displayName ?? "Location";
  return (
    <Layout>
      <article className="container mx-auto w-full max-w-6xl px-4 py-10 md:px-6 md:py-16">
        <nav aria-label="Breadcrumb" className="mb-8 flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-primary">
            Home
          </Link>
          <ChevronRight className="size-4" />
          <span aria-current="page">{label}</span>
        </nav>
        <header className="max-w-3xl">
          <p className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-primary">
            Explore the Las Vegas Valley
          </p>
          <h1 className="text-4xl md:text-6xl">{label} real estate</h1>
          <p className="mt-5 text-lg leading-8 text-muted-foreground">
            Published native community content is unavailable for this page. Search uses explicit city
            filters, without inferred neighborhood boundaries.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href={`/?city=${encodeURIComponent(label)}`}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground"
            >
              Browse current listings <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/terms"
              className="inline-flex items-center rounded-md border px-4 py-2.5 text-sm font-medium"
            >
              Data and use terms
            </Link>
          </div>
        </header>
        <section className="mt-14 rounded-xl border bg-card p-6 md:p-8">
          <p className="text-sm font-medium uppercase tracking-[0.15em] text-primary">IDX snapshot</p>
          <h2 className="mt-2 text-2xl">Current {label} results</h2>
          <p role="status" className="mt-6 rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            Market statistics are unavailable. No unverified totals, prices or market trends are shown.
          </p>
        </section>
        <section className="mt-14 max-w-3xl">
          <h2 className="text-2xl">Questions about this search</h2>
          <div className="mt-5 divide-y rounded-lg border">
            <details className="p-5">
              <summary className="cursor-pointer font-medium">Which listing data is displayed?</summary>
              <p className="mt-3 leading-7 text-muted-foreground">
                Only current fields permitted by the site's feed policy. Synthetic records are clearly marked.
              </p>
            </details>
          </div>
        </section>
        <section className="mt-14">
          <h2 className="text-2xl">Explore another location</h2>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {publicLocations
              .filter((item) => item.slug !== location?.slug)
              .map((item) => (
                <Link
                  key={item.slug}
                  href={`/communities/${item.slug}`}
                  className="flex items-center justify-between rounded-lg border p-5"
                >
                  <span>{item.displayName} real estate</span>
                  <ArrowRight className="size-4 text-primary" />
                </Link>
              ))}
          </div>
        </section>
      </article>
    </Layout>
  );
}
