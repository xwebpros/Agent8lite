"use client";

import dynamic from "next/dynamic";
import {
  getListListingsQueryKey,
  useGetIdxStatus,
  useListListings,
  ListListingsParams,
  ListListingsSort,
  Listing,
} from "../api";
import { Suspense, useEffect, useState } from "react";
import { useLocation, templateSearch, replaceTemplateUrl } from "../navigation";
import { useTemplateSite } from "../context";
import { ListingCard, ListingCardSkeleton } from "../components/ListingCard";
import { Filters } from "../components/Filters";
import { Layout } from "../components/Layout";
import {
  AlertCircle,
  Home as HomeIcon,
  ChevronLeft,
  ChevronRight,
  Grid2X2,
  List,
  Map as MapIcon,
  Columns3,
  ArrowRight,
  Building2,
  MapPin,
  Waves,
} from "lucide-react";
import { setPageMetadata } from "../lib/seo";
import { useSiteContent } from "../lib/content";
import { emitBehaviorEvent } from "../lib/events";
import { SaveSearchButton } from "../components/OrganizerActions";
import { NaturalLanguageSearch } from "../components/NaturalLanguageSearch";
import { filtersFromSearch, searchFromFilters } from "../lib/search-state";
import { type MapBounds } from "../lib/map-state";

const ListingMap = dynamic(() => import("../components/ListingMap").then((module) => module.ListingMap), {
  ssr: false,
});

function isWineListing(listing: Listing) {
  return (
    listing.appliances?.some((appliance) => appliance.toLowerCase() === "winerefrigerator") &&
    Boolean(listing.photos?.[0])
  );
}

export default function Home() {
  const [location] = useLocation();
  const site = useTemplateSite();
  useEffect(() => {
    setPageMetadata({
      title: "Las Vegas Live IDX | Search Las Vegas Homes",
      description:
        "Search live Las Vegas Valley real estate listings with current property details, photos, and brokerage attribution.",
      path: "/",
    });
  }, []);

  const { data: status, isLoading: isStatusLoading, isError: isStatusError } = useGetIdxStatus();
  const { data: content } = useSiteContent();

  const [filters, setFilters] = useState<ListListingsParams>({
    ...(filtersFromSearch("") ?? { sort: ListListingsSort.newest, page: 1 }),
  });
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [displayMode, setDisplayMode] = useState<"results" | "split" | "map">("results");
  const [selectedListingKey, setSelectedListingKey] = useState<string>();

  useEffect(() => {
    const nextFilters = filtersFromSearch(templateSearch());
    if (!nextFilters) return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setFilters(nextFilters);
    setDisplayMode("results");
    setViewMode("grid");
    setSelectedListingKey(undefined);
  }, [location]);

  const {
    data: pageData,
    isLoading: isListingsLoading,
    isError: isListingsError,
  } = useListListings(filters, {
    query: {
      enabled: status?.authenticated && status?.configured,
      queryKey: getListListingsQueryKey(filters),
    },
  });

  const listings = pageData?.items || [];
  const wineListings = listings.filter(isWineListing);
  const needsWineFallback = Boolean(
    status?.authenticated &&
      status?.configured &&
      pageData &&
      !isListingsLoading &&
      !isListingsError &&
      wineListings.length < 5,
  );
  const { data: fallbackPageData } = useListListings(
    { sort: ListListingsSort["price-desc"], page: 1 },
    {
      query: {
        enabled: needsWineFallback,
        queryKey: getListListingsQueryKey({ sort: ListListingsSort["price-desc"], page: 1 }),
      },
    },
  );
  const firstFallbackWineListings = (fallbackPageData?.items ?? []).filter(isWineListing);
  const wineListingCountAfterFirstFallback = new Set(
    [...wineListings, ...firstFallbackWineListings].map((listing) => listing.listingKey),
  ).size;
  const { data: fallbackPageTwoData } = useListListings(
    { sort: ListListingsSort["price-desc"], page: 2 },
    {
      query: {
        // Request a second live page only when the first fallback cannot fill the feature rail.
        enabled: needsWineFallback && Boolean(fallbackPageData) && wineListingCountAfterFirstFallback < 5,
        queryKey: getListListingsQueryKey({ sort: ListListingsSort["price-desc"], page: 2 }),
      },
    },
  );
  const fallbackWineListings = [
    ...firstFallbackWineListings,
    ...(fallbackPageTwoData?.items ?? []).filter(isWineListing),
  ].filter(
    (listing, index, all) => all.findIndex((item) => item.listingKey === listing.listingKey) === index,
  );
  const candidateWineListings = [...wineListings, ...fallbackWineListings]
    .filter(
      (listing, index, all) => all.findIndex((item) => item.listingKey === listing.listingKey) === index,
    )
    .slice(0, 5);
  const wineListingSignature = candidateWineListings.map((listing) => listing.listingKey).join("|");
  const featuredWineListings = candidateWineListings;
  const [wineIndex, setWineIndex] = useState(0);

  const featuredWineSignature = featuredWineListings.map((listing) => listing.listingKey).join("|");

  useEffect(() => {
    setWineIndex(0);
    if (featuredWineListings.length < 2) return;

    const interval = window.setInterval(() => {
      setWineIndex((current) => (current + 1) % featuredWineListings.length);
    }, 15000);
    return () => window.clearInterval(interval);
  }, [featuredWineSignature]);

  const handleFilterChange = (newFilters: ListListingsParams) => {
    emitBehaviorEvent("FILTER_CHANGED", { metadata: { filterCount: Object.keys(newFilters).length } });
    emitBehaviorEvent("SEARCH_PERFORMED", { metadata: { filterCount: Object.keys(newFilters).length } });
    setFilters(newFilters);
    replaceTemplateUrl(`/${searchFromFilters(newFilters)}`);
    setSelectedListingKey(undefined);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handlePageChange = (newPage: number) => {
    emitBehaviorEvent("SEARCH_PERFORMED", { metadata: { page: newPage } });
    const nextFilters = { ...filters, page: newPage };
    setFilters(nextFilters);
    replaceTemplateUrl(`/${searchFromFilters(nextFilters)}`);
    setSelectedListingKey(undefined);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleMapSearch = (bounds: MapBounds | undefined) => {
    if (!bounds) return;
    handleFilterChange({ ...filters, ...bounds, page: 1 });
  };

  const applyQuickSearch = (quickFilters: ListListingsParams) => {
    handleFilterChange({ ...quickFilters, sort: ListListingsSort.newest, page: 1 });
  };

  if (isStatusLoading && !content) {
    return (
      <Layout>
        <div className="flex-1 flex items-center justify-center min-h-[50vh]">
          <div className="flex flex-col items-center gap-4 text-muted-foreground">
            <div className="w-12 h-12 border-4 border-primary/30 border-t-primary rounded-full animate-spin"></div>
            <p className="font-medium animate-pulse">Connecting to MLS...</p>
          </div>
        </div>
      </Layout>
    );
  }

  if (status && (!status.configured || !status.authenticated)) {
    return (
      <Layout>
        <div className="flex-1 flex flex-col items-center justify-center p-6 min-h-[60vh] text-center">
          <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-6">
            <AlertCircle className="w-8 h-8 text-muted-foreground" />
          </div>
          <h2 className="text-3xl font-serif font-medium mb-4 text-foreground">Configuration Required</h2>
          <p className="text-muted-foreground max-w-md mx-auto mb-8 leading-relaxed">
            {status.message ||
              "The real estate IDX connection has not been fully configured or authenticated."}
          </p>
          <p className="max-w-lg text-sm text-muted-foreground">
            Property availability is controlled by the site's current licensed feed. Please try again later.
          </p>
        </div>
      </Layout>
    );
  }

  const showResults = displayMode !== "map";
  const showMap = displayMode !== "results";
  const isLoading = isStatusLoading || isListingsLoading;
  const activeSearch = [
    filters.address,
    filters.city,
    filters.zip,
    filters.status && filters.status !== "Active" ? filters.status : undefined,
    filters.propertyType,
    filters.propertySubType,
    filters.minPrice !== undefined ? `from $${filters.minPrice.toLocaleString()}` : undefined,
    filters.maxPrice !== undefined ? `up to $${filters.maxPrice.toLocaleString()}` : undefined,
    filters.beds !== undefined ? `${filters.beds}+ beds` : undefined,
    filters.baths !== undefined ? `${filters.baths}+ baths` : undefined,
    filters.minSqft !== undefined ? `${filters.minSqft.toLocaleString()}+ sq ft` : undefined,
    filters.maxSqft !== undefined ? `up to ${filters.maxSqft.toLocaleString()} sq ft` : undefined,
    filters.minYearBuilt !== undefined ? `built from ${filters.minYearBuilt}` : undefined,
    filters.maxYearBuilt !== undefined ? `built through ${filters.maxYearBuilt}` : undefined,
    filters.pool ? "pool" : undefined,
    filters.singleStory ? "single story" : undefined,
    filters.hoa ? "HOA" : undefined,
    filters.gated ? "gated" : undefined,
    filters.minGarageSpaces !== undefined ? `${filters.minGarageSpaces}+ garage spaces` : undefined,
    filters.minLotSizeSqft !== undefined
      ? `${filters.minLotSizeSqft.toLocaleString()}+ lot sq ft`
      : undefined,
  ].filter(Boolean);
  const feedWarning = isStatusLoading
    ? undefined
    : isStatusError || !status
      ? "The live IDX feed is temporarily unavailable. Search controls remain available and will retry."
      : undefined;

  return (
    <Layout>
      <div className="relative overflow-hidden border-b bg-[linear-gradient(120deg,hsl(var(--muted))_0%,hsl(var(--background))_55%,hsl(var(--accent))_100%)]">
        {featuredWineListings.length > 0 &&
          featuredWineListings.map((listing, index) => (
            <img
              key={listing.listingKey}
              src={listing.photos![0]}
              alt=""
              aria-hidden="true"
              className={`hero-background-image absolute inset-0 h-full w-full object-cover ${
                index === wineIndex % featuredWineListings.length ? "hero-background-image--visible" : ""
              }`}
            />
          ))}
        <div className="absolute inset-0 bg-slate-950/45" />
        <div className="relative container mx-auto px-4 py-14 md:px-6 md:py-20">
          <div className="max-w-3xl rounded-2xl border border-white/20 bg-slate-950/55 p-6 text-white shadow-2xl backdrop-blur-md md:p-10">
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.24em] text-white/80">
              {content.heroEyebrow}
            </p>
            <h1 className="text-5xl font-serif font-medium leading-[1.05] text-white md:text-7xl">
              {content.heroTitle}
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-white/85 md:text-xl">
              {content.heroDescription}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium text-white/90">
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-300" />
                {site.dataMode === "mock" ? "SYNTHETIC DEMO DATA" : "Live IDX feed"}
              </span>
              <span className="text-white/70">Map and list views</span>
              <span className="text-white/70">No account required</span>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 md:px-6 py-8">
        {feedWarning && (
          <div
            role="status"
            aria-live="polite"
            className="mb-6 flex items-start gap-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-950"
          >
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <p>{feedWarning}</p>
          </div>
        )}
        <section
          className="mb-10 rounded-xl border border-border bg-card p-5 md:p-6"
          aria-labelledby="quick-searches-heading"
        >
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
                {content.quickSearchEyebrow}
              </p>
              <h2 id="quick-searches-heading" className="mt-2 text-2xl font-serif font-medium">
                {content.quickSearchTitle}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{content.quickSearchDescription}</p>
            </div>
            <span className="text-xs text-muted-foreground">Results reflect the current permitted feed</span>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
            <button
              type="button"
              onClick={() => applyQuickSearch({ city: "Las Vegas" })}
              className="group flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3 text-left text-sm font-medium transition hover:border-primary hover:text-primary"
            >
              Las Vegas <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </button>
            <button
              type="button"
              onClick={() => applyQuickSearch({ city: "Henderson" })}
              className="group flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3 text-left text-sm font-medium transition hover:border-primary hover:text-primary"
            >
              Henderson <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </button>
            <button
              type="button"
              onClick={() => applyQuickSearch({ city: "North Las Vegas" })}
              className="group flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3 text-left text-sm font-medium transition hover:border-primary hover:text-primary"
            >
              North Las Vegas{" "}
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </button>
            <button
              type="button"
              onClick={() => applyQuickSearch({ pool: true })}
              className="group flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3 text-left text-sm font-medium transition hover:border-primary hover:text-primary"
            >
              <span className="inline-flex items-center gap-2">
                <Waves className="h-4 w-4 text-primary" />
                Pools
              </span>
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </button>
            <button
              type="button"
              onClick={() => applyQuickSearch({ propertySubType: "Condominium" })}
              className="group flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3 text-left text-sm font-medium transition hover:border-primary hover:text-primary"
            >
              <span className="inline-flex items-center gap-2">
                <Building2 className="h-4 w-4 text-primary" />
                Condos
              </span>
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Summerlin is not offered as a shortcut until the feed provides a verified subdivision field; the
            city filter is not used as a substitute.
          </p>
        </section>

        <NaturalLanguageSearch onApply={handleFilterChange} />
        <Filters initialFilters={filters} onFilterChange={handleFilterChange} isLoading={isLoading} />
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed bg-card px-4 py-3">
          <span className="text-sm text-muted-foreground">Keep these filters ready for your next visit.</span>
          <SaveSearchButton filters={filters} />
        </div>

        {isListingsError ? (
          <div
            role="alert"
            className="bg-destructive/10 border border-destructive/20 text-destructive p-6 rounded-lg text-center my-8"
          >
            <p>Failed to load listings. Please try adjusting your filters or refreshing the page.</p>
          </div>
        ) : isLoading && listings.length === 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <ListingCardSkeleton key={i} />
            ))}
          </div>
        ) : listings.length === 0 ? (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col items-center justify-center py-20 text-center border border-dashed rounded-lg bg-card"
          >
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
              <HomeIcon className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-xl font-serif font-medium mb-2 text-foreground">No properties found</h3>
            <p className="text-muted-foreground max-w-md mx-auto">
              We couldn't find any properties matching your criteria. Try adjusting your filters or broadening
              your search.
            </p>
            <button
              onClick={() => handleFilterChange({ sort: ListListingsSort.newest, page: 1 })}
              className="mt-6 px-6 py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Clear Filters
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground font-medium">
                  <span>{listings.length} properties on this page</span>
                  {status?.live && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 px-2 py-0.5 rounded-full">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Live IDX
                      Data
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {activeSearch.length > 0
                    ? `Searching ${activeSearch.join(" · ")}`
                    : "Showing active listings across the Las Vegas Valley"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 self-start sm:self-auto">
                <div
                  className="inline-flex rounded-md border border-border bg-card p-1"
                  role="group"
                  aria-label="Results display"
                >
                  <button
                    type="button"
                    aria-label="Results only"
                    aria-pressed={displayMode === "results"}
                    onClick={() => setDisplayMode("results")}
                    className={`inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium ${displayMode === "results" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    <List className="w-4 h-4" /> <span className="hidden sm:inline">Results</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Split results and map"
                    aria-pressed={displayMode === "split"}
                    onClick={() => setDisplayMode("split")}
                    className={`inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium ${displayMode === "split" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    <Columns3 className="w-4 h-4" /> <span className="hidden sm:inline">Split</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Map only"
                    aria-pressed={displayMode === "map"}
                    onClick={() => setDisplayMode("map")}
                    className={`inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium ${displayMode === "map" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    <MapIcon className="w-4 h-4" /> <span className="hidden sm:inline">Map</span>
                  </button>
                </div>
                {showResults && (
                  <div
                    className="inline-flex rounded-md border border-border bg-card p-1"
                    role="group"
                    aria-label="Results view"
                  >
                    <button
                      type="button"
                      aria-label="Grid view"
                      aria-pressed={viewMode === "grid"}
                      onClick={() => setViewMode("grid")}
                      className={`p-2 rounded ${viewMode === "grid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                    >
                      <Grid2X2 className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="List view"
                      aria-pressed={viewMode === "list"}
                      onClick={() => setViewMode("list")}
                      className={`p-2 rounded ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                    >
                      <List className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div
              className={
                displayMode === "map"
                  ? "block"
                  : showMap
                    ? "grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.85fr)] gap-6 items-start"
                    : "block"
              }
            >
              {showResults && (
                <div
                  className={
                    viewMode === "grid"
                      ? "grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8"
                      : "flex flex-col gap-4 max-w-5xl"
                  }
                >
                  {listings.map((listing) => (
                    <ListingCard
                      key={listing.listingKey}
                      listing={listing}
                      viewMode={viewMode}
                      isHighlighted={selectedListingKey === listing.listingKey}
                      onSelect={setSelectedListingKey}
                    />
                  ))}
                </div>
              )}
              {showMap && (
                <div
                  className={
                    displayMode === "map"
                      ? "h-[calc(100vh-8rem)] min-h-[520px]"
                      : "lg:sticky lg:top-24 h-[520px] lg:h-[calc(100vh-7rem)]"
                  }
                >
                  <Suspense
                    fallback={
                      <div className="h-full animate-pulse rounded-lg bg-muted" role="status">
                        Loading map...
                      </div>
                    }
                  >
                    <ListingMap
                      listings={listings}
                      selectedListingKey={selectedListingKey}
                      onSelect={setSelectedListingKey}
                      onSearchArea={handleMapSearch}
                    />
                  </Suspense>
                </div>
              )}
            </div>

            {displayMode !== "map" && pageData && (pageData.hasMore || filters.page! > 1) && (
              <div className="mt-12 flex items-center justify-center gap-4">
                <button
                  onClick={() => handlePageChange(filters.page! - 1)}
                  disabled={filters.page === 1 || isLoading}
                  className="flex items-center gap-2 px-4 py-2 border border-border rounded-md text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  <ChevronLeft className="w-4 h-4" /> Previous
                </button>
                <span className="text-sm font-medium text-muted-foreground">Page {filters.page}</span>
                <button
                  onClick={() => handlePageChange(filters.page! + 1)}
                  disabled={!pageData.hasMore || isLoading}
                  className="flex items-center gap-2 px-4 py-2 border border-border rounded-md text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <section className="border-t bg-card" aria-labelledby="explore-heading">
        <div className="container mx-auto grid gap-10 px-4 py-14 md:grid-cols-3 md:px-6 md:py-16">
          <div className="md:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
              {content.exploreEyebrow}
            </p>
            <h2 id="explore-heading" className="mt-2 text-3xl font-serif font-medium">
              {content.exploreTitle}
            </h2>
            <p className="mt-4 max-w-2xl text-muted-foreground leading-relaxed">
              {content.exploreDescription}
            </p>
          </div>
          <div className="space-y-4 text-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Why search here?</p>
            <div className="flex gap-3">
              <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <h3 className="font-medium">Search by place</h3>
                <p className="mt-1 text-muted-foreground">
                  Use exact city and ZIP filters rather than assumed neighborhood boundaries.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <HomeIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <h3 className="font-medium">Review the details</h3>
                <p className="mt-1 text-muted-foreground">
                  Open a listing for photos, public remarks, property facts, and brokerage attribution.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </Layout>
  );
}
