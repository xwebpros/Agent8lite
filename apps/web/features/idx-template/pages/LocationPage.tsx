"use client";
import { Link } from "../navigation";
import { Layout } from "../components/Layout";
import { ArrowRight, ChevronRight, ExternalLink } from "lucide-react";
import { useRoute } from "../navigation";
import { useTemplateSite, useTemplateOrigin } from "../context";
import { locationPagePath, locationStructuredData, publicLocations } from "../lib/location-seo";
type LocationPageData = {
  location: {
    slug: string;
    displayName: string;
    cityFilter: string;
    title: string;
    description: string;
    intro: string;
    faqs: Array<{ question: string; answer: string }>;
  };
  marketSummary: {
    listingCount: number;
    activeCount: number;
    medianPrice: number | null;
    averagePricePerSqft: number | null;
    metricDate: string;
  } | null;
  marketDataStatus: "live" | "unavailable";
};

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
export default function LocationPage() {
  const [, params] = useRoute<{ slug: string }>("/communities/:slug");
  const site = useTemplateSite();
  const origin = useTemplateOrigin();
  const selected = publicLocations.find((item) => item.slug === params?.slug);
  const data: LocationPageData = {
    location: {
      slug: selected?.slug ?? "unavailable",
      displayName: selected?.displayName ?? "Location",
      cityFilter: selected?.displayName ?? "",
      title: site.seo.title,
      description: site.seo.description,
      intro: site.content.exploreDescription,
      faqs: [
        {
          question: "Is a current market snapshot available?",
          answer:
            "The native market-statistics capability is unavailable. Use explicit property filters to review permitted listings.",
        },
      ],
    },
    marketSummary: null,
    marketDataStatus: "unavailable",
  };
  const { location, marketSummary } = data;
  const otherLocations = publicLocations.filter((item) => item.slug !== location.slug);
  return (
    <Layout>
      <article className="container mx-auto w-full max-w-6xl px-4 py-10 md:px-6 md:py-16">
        <nav aria-label="Breadcrumb" className="mb-8 flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-primary">
            Home
          </Link>
          <ChevronRight className="size-4" aria-hidden="true" />
          <span aria-current="page" className="text-foreground">
            {location.displayName}
          </span>
        </nav>
        <header className="max-w-3xl">
          <p className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-primary">
            Explore the Las Vegas Valley
          </p>
          <h1 className="text-4xl md:text-6xl">{location.displayName} real estate</h1>
          <p className="mt-5 text-lg leading-8 text-muted-foreground">{location.intro}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href={`/?city=${encodeURIComponent(location.cityFilter)}`}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Browse current listings <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link
              href="/terms"
              className="inline-flex items-center rounded-md border px-4 py-2.5 text-sm font-medium hover:bg-muted"
            >
              Data and use terms
            </Link>
          </div>
        </header>

        <section aria-labelledby="snapshot-heading" className="mt-14 rounded-xl border bg-card p-6 md:p-8">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.15em] text-primary">IDX snapshot</p>
              <h2 id="snapshot-heading" className="mt-2 text-2xl">
                Current {location.displayName} results
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {marketSummary ? `Measured ${marketSummary.metricDate}` : "No current snapshot available"}
            </p>
          </div>
          {marketSummary && marketSummary.listingCount > 0 ? (
            <div className="mt-7 grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg bg-muted/50 p-4">
                <p className="text-sm text-muted-foreground">Listings returned</p>
                <p className="mt-1 text-2xl font-semibold">{marketSummary.listingCount}</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-4">
                <p className="text-sm text-muted-foreground">Active listings</p>
                <p className="mt-1 text-2xl font-semibold">{marketSummary.activeCount}</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-4">
                <p className="text-sm text-muted-foreground">Median list price</p>
                <p className="mt-1 text-2xl font-semibold">
                  {marketSummary.medianPrice === null
                    ? "Not reported"
                    : money.format(marketSummary.medianPrice)}
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-6 rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
              {marketSummary
                ? "The live feed returned no current listings for this bounded city search."
                : "Native market statistics are unavailable. No unverified totals or prices are shown."}
            </div>
          )}
          <Link
            href={`/?city=${encodeURIComponent(location.cityFilter)}`}
            className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-primary underline underline-offset-4"
          >
            Open the filtered search <ExternalLink className="size-4" aria-hidden="true" />
          </Link>
        </section>

        <section aria-labelledby="faq-heading" className="mt-14 max-w-3xl">
          <h2 id="faq-heading" className="text-2xl">
            Questions about this search
          </h2>
          <div className="mt-5 divide-y rounded-lg border">
            {location.faqs.map((faq) => (
              <details key={faq.question} className="group p-5">
                <summary className="cursor-pointer font-medium">{faq.question}</summary>
                <p className="mt-3 leading-7 text-muted-foreground">{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section aria-labelledby="more-locations-heading" className="mt-14">
          <h2 id="more-locations-heading" className="text-2xl">
            Explore another location
          </h2>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {otherLocations.map((item) => (
              <Link
                key={item.slug}
                href={locationPagePath(item.slug)}
                className="flex items-center justify-between rounded-lg border p-5 transition-colors hover:border-primary hover:bg-muted/30"
              >
                <span className="font-medium">{item.displayName} real estate</span>
                <ArrowRight className="size-4 text-primary" aria-hidden="true" />
              </Link>
            ))}
          </div>
        </section>
        <p className="mt-14 max-w-3xl border-t pt-6 text-sm leading-6 text-muted-foreground">
          Listing information is supplied through the applicable MLS/IDX feed and is not guaranteed. This page
          describes search availability and listing fields, not people or neighborhoods. Housing information
          is presented without preference based on protected characteristics.
        </p>
      </article>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            locationStructuredData(location, origin, `/templates/las-vegas-idx/${site.siteId}`),
          ).replaceAll("<", "\\u003c"),
        }}
      />
    </Layout>
  );
}
