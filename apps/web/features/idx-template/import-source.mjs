import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const target = path.dirname(fileURLToPath(import.meta.url));
const source = "C:/Users/Monar/Las-Vegas-Live-IDX-reference-920d148/artifacts/las-vegas-idx/src";
const files = [
  "App.tsx",
  "pages/Home.tsx",
  "pages/ListingDetail.tsx",
  "pages/LocationPage.tsx",
  "pages/SavedHomes.tsx",
  "pages/Organizer.tsx",
  "pages/Account.tsx",
  "pages/Terms.tsx",
  "components/Layout.tsx",
  "components/ListingCard.tsx",
  "components/Filters.tsx",
  "components/ListingMap.tsx",
  "components/MapListingPreview.tsx",
  "components/IdxAttribution.tsx",
  "components/PropertyInquiryForm.tsx",
  "components/NaturalLanguageSearch.tsx",
  "components/FavoriteButton.tsx",
  "components/OrganizerActions.tsx",
  "lib/search-state.ts",
  "lib/map-state.ts",
  "lib/location-seo.ts",
  "lib/content.ts",
  "lib/favorites.ts",
  "lib/events.ts",
  "lib/seo.ts",
  "components/ui/button.tsx",
  "components/ui/input.tsx",
  "components/ui/textarea.tsx",
  "index.css",
];
const active = new Set([
  "pages/Home.tsx",
  "pages/ListingDetail.tsx",
  "components/Layout.tsx",
  "components/ListingMap.tsx",
  "components/ListingCard.tsx",
  "components/Filters.tsx",
  "components/MapListingPreview.tsx",
  "components/IdxAttribution.tsx",
  "lib/search-state.ts",
  "lib/map-state.ts",
  "lib/location-seo.ts",
]);
const gated = new Set([
  "pages/Account.tsx",
  "pages/Organizer.tsx",
  "pages/SavedHomes.tsx",
  "pages/LocationPage.tsx",
  "pages/Terms.tsx",
]);
const manifest = {
  repository: "djmichaelmartin-cmd/Las-Vegas-Live-IDX",
  branch: "Full_Web_App_phase_1",
  commit: "920d148ee0ec6465381bf245381afcbdb5540bce",
  transformations: [
    "Original public source retained byte-for-byte in provenance/original for reproducibility.",
    "Active source JSX utility classes retained; imports adapted to native generated API, Next navigation and published CMS context.",
    "Provider calls, private browser persistence, original CRM/admin, source analytics and direct email removed.",
    "Unsupported optional capabilities keep source panel geometry with explicit unavailable states.",
    "build-gated-pages.mjs retains actual source JSX/section identifiers for all account, organizer, saved-home, community and legal pages; original effects/policies are never activated.",
    "CSS compiled and scoped to data-idx-template; Leaflet loaded only in client and external tiles remain disabled.",
    "Leaflet's unchanged licensed images are self-hosted with byte hashes; generated CSS URLs are absolute public paths.",
    "Inquiry controls preserve source panels while adding stable tab-memory command recovery, labeled errors and 44px mobile targets; filter panel gains mobile name, Escape and focus return.",
  ],
  files: [],
};
for (const relative of files) {
  const input = await readFile(path.join(source, relative)).catch(() =>
    readFile(path.join(target, "provenance/original", `${relative}.txt`)),
  );
  const retained = path.join(target, "provenance/original", relative + ".txt");
  await mkdir(path.dirname(retained), { recursive: true });
  await writeFile(retained, input);
  manifest.files.push({
    path: relative,
    sha256: createHash("sha256").update(input).digest("hex"),
    bytes: input.length,
    active: active.has(relative) || gated.has(relative),
  });
  if (!active.has(relative)) continue;
  let code = input
    .toString("utf8")
    .replaceAll("\r\n", "\n")
    .replaceAll('"@workspace/api-client-react"', '"../api"')
    .replaceAll('"wouter"', '"../navigation"')
    .replaceAll('"@/components/', '"../components/')
    .replaceAll('"@/lib/', '"../lib/');
  if (relative === "pages/Home.tsx") {
    code = code.replace("lazy, Suspense,", "Suspense,");
    code = 'import dynamic from "next/dynamic";\n' + code;
    code = code.replace(
      "const [location] = useLocation();",
      "const [location] = useLocation();\n  const site = useTemplateSite();",
    );
    code = code.replace(
      'import { useLocation } from "../navigation";',
      'import { useLocation, templateSearch, replaceTemplateUrl } from "../navigation";\nimport { useTemplateSite } from "../context";',
    );
    code = code
      .replaceAll("window.location.search", "templateSearch()")
      .replace(
        'window.history.replaceState(null, "", `/${searchFromFilters(newFilters)}`);',
        "replaceTemplateUrl(`/${searchFromFilters(newFilters)}`);",
      )
      .replace(
        'window.history.replaceState(null, "", `/${searchFromFilters(nextFilters)}`);',
        "replaceTemplateUrl(`/${searchFromFilters(nextFilters)}`);",
      );
    code = code.replace(
      'const ListingMap = lazy(() => import("../components/ListingMap").then((module) => ({ default: module.ListingMap })));',
      'const ListingMap = dynamic(() => import("../components/ListingMap").then((module) => module.ListingMap), { ssr: false });',
    );
    code = code.replace("...(filtersFromSearch(templateSearch()) ??", '...(filtersFromSearch("") ??');
    code = code.replace("if (isStatusLoading) {", "if (isStatusLoading && !content) {");
    code = code.replace(
      "const isLoading = isListingsLoading;",
      "const isLoading = isStatusLoading || isListingsLoading;",
    );
    code = code.replace(
      "const feedWarning = isStatusError || !status",
      "const feedWarning = isStatusLoading ? undefined : isStatusError || !status",
    );
    const start = code.indexOf('          <div className="max-w-lg rounded-xl');
    const end = code.indexOf("\n          </div>", start);
    if (start >= 0)
      code =
        code.slice(0, start) +
        '          <p className="max-w-lg text-sm text-muted-foreground">Property availability is controlled by the site\'s current licensed feed. Please try again later.</p>' +
        code.slice(end + 17);
    code = code
      .replaceAll("Live IDX feed", '{site.dataMode === "mock" ? "SYNTHETIC DEMO DATA" : "Live IDX feed"}')
      .replaceAll("Results update from the live IDX feed", "Results reflect the current permitted feed");
    code = code.replace("const listings = pageData?.items || [];", "const listings = pageData?.items || [];");
    code = code.replace(
      "const [featuredWineListings, setFeaturedWineListings] = useState<Listing[]>([]);",
      "const featuredWineListings = candidateWineListings;",
    );
    const railEffectStart = code.indexOf("  useEffect(() => {\n    if (wineListings.length > 0");
    const railEffectEnd = code.indexOf("  const featuredWineSignature", railEffectStart);
    if (railEffectStart >= 0 && railEffectEnd > railEffectStart)
      code = code.slice(0, railEffectStart) + code.slice(railEffectEnd);
    // A changed filter/expired rights must retire the feature rail, never preserve old results.
    code = code
      .replace(
        "setFeaturedWineListings((current) => current.length > 0 ? current : candidateWineListings);",
        "setFeaturedWineListings(candidateWineListings);",
      )
      .replace(
        "    }\n  }, [wineListingSignature]);",
        "    } else { setFeaturedWineListings([]); }\n  }, [wineListingSignature]);",
      );
    code = code.replace("<SaveSearchButton filters={filters} />", "<SaveSearchButton filters={filters} />");
  }
  if (relative === "components/Filters.tsx") {
    code = code.replace("useState, useEffect", "useState, useEffect, useRef");
    code = code
      .replaceAll("setIsOpen(false);", "closeFilters();")
      .replace("onClick={() => setIsOpen(false)}", "onClick={closeFilters}");
    code = code.replace(
      "const [isOpen, setIsOpen] = useState(false);",
      'const [isOpen, setIsOpen] = useState(false);\n  const triggerRef = useRef<HTMLButtonElement>(null);\n  const panelRef = useRef<HTMLDivElement>(null);\n  const closeFilters = () => { setIsOpen(false); triggerRef.current?.focus(); };\n  useEffect(() => { if (isOpen) panelRef.current?.querySelector<HTMLElement>("button, input, select")?.focus(); }, [isOpen]);',
    );
    code = code.replace(
      "const updateFilter = (key: keyof ListListingsParams, value: any)",
      "const updateFilter = <K extends keyof ListListingsParams>(key: K, value: ListListingsParams[K])",
    );
    for (const field of ["status", "propertyType", "propertySubType"])
      code = code.replace(
        `updateFilter("${field}", e.target.value || undefined)`,
        `updateFilter("${field}", (e.target.value || undefined) as ListListingsParams["${field}"])`,
      );
    code = code
      .replace(
        "aria-expanded={isOpen}",
        'ref={triggerRef}\n            aria-label="Filters"\n            aria-expanded={isOpen}',
      )
      .replace('aria-controls="property-filters"', 'aria-controls={isOpen ? "property-filters" : undefined}')
      .replace(
        '<div id="property-filters" className=',
        '<div id="property-filters" ref={panelRef} role="region" aria-labelledby="property-filters-heading" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeFilters(); } }} className=',
      )
      .replace(
        '<h3 className="font-serif font-medium text-lg">Filter Properties',
        '<h3 id="property-filters-heading" className="font-serif font-medium text-lg">Filter Properties',
      );
  }
  if (relative === "pages/ListingDetail.tsx") {
    code = code.replace("recordMyListingView, ", "");
    const start = code.indexOf("      recordMyListingView(");
    const end = code.indexOf("\n    }", start);
    if (start >= 0)
      code =
        code.slice(0, start) + '      emitBehaviorEvent("LISTING_VIEWED", { listingKey });' + code.slice(end);
  }
  if (relative === "components/Layout.tsx") {
    code = code
      .replace(
        'className="flex items-center gap-2 transition-opacity hover:opacity-80"',
        'className="flex min-w-0 max-w-[45vw] items-center gap-2 transition-opacity hover:opacity-80 md:max-w-none"',
      )
      .replace(
        'className="font-serif font-semibold text-lg tracking-wide"',
        'className="truncate font-serif font-semibold text-lg tracking-wide"',
      );
    code = code.replace(
      'import { subscribeToAuthChanges } from "../lib/favorites";',
      'import { useTemplateSite } from "../context";',
    );
    code = code.replace(
      "  const [roles, setRoles] = useState<string[]>(roleOverride ?? []);",
      "  const site = useTemplateSite();\n  const roles = roleOverride ?? [];",
    );
    code = code
      .replace(
        "const [location] = useLocation();",
        'const [routeLocation] = useLocation();\n  const location = routeLocation.split("?")[0];',
      )
      .replace('window.location.pathname === "/"', 'location === "/"');
    const start = code.indexOf("  useEffect(() => {");
    const end = code.indexOf("\n  const isActive", start);
    code = code.slice(0, start) + code.slice(end);
    code = code
      .replaceAll("LAS VEGAS LIVE IDX", "{site.brand.displayName}")
      .replaceAll(">L</span>", ">{site.brand.initial}</span>")
      .replace("Las Vegas Live IDX. All rights reserved.", "{site.brand.displayName}. All rights reserved.");
    code = code.replace(
      '<div className="min-h-[100dvh] flex flex-col w-full">',
      '<div className="min-h-[100dvh] flex flex-col w-full">\n      {site.dataMode === "mock" && <div role="status" className="border-b bg-primary/10 px-4 py-2 text-center text-sm font-medium text-primary">SYNTHETIC DEMO DATA — fictional properties; no live MLS or outbound messages.</div>}',
    );
    code = code.replace(
      "Listing-specific details come from the live feed.",
      "Listing-specific details follow the currently permitted feed.",
    );
  }
  if (relative === "components/ListingMap.tsx") {
    code = code
      .replace("Popup, TileLayer, useMap", "Popup, useMap")
      .replace(
        'import { normalizeMapBounds } from "../lib/map-state";',
        'import { normalizeMapBounds } from "../lib/map-state";\nimport { useTemplateSite } from "../context";',
      );
    const start = code.indexOf("      <TileLayer");
    const end = code.indexOf("\n      <MapResizeHandler", start);
    code = code.slice(0, start) + code.slice(end);
    code = code.replace(
      "  const mappableCount = listings.filter(",
      "  const site = useTemplateSite();\n  const mappableCount = listings.filter(",
    );
    code = code.replace(
      "<MapContent listings={listings} selectedListingKey={selectedListingKey} onSelect={onSelect} onSearchArea={onSearchArea} />",
      '{site.capabilities.map && site.dataMode === "mock" ? <MapContent listings={listings} selectedListingKey={selectedListingKey} onSelect={onSelect} onSearchArea={onSearchArea} /> : fallback}',
    );
    code = code.replace(
      '{mappableCount} mapped {mappableCount === 1 ? "property" : "properties"}',
      '{site.capabilities.map && site.dataMode === "mock" ? `${mappableCount} mapped synthetic properties · no external tiles` : "Map capability unavailable · list remains usable"}',
    );
  }
  if (relative === "lib/location-seo.ts") {
    code = code
      .replace("origin: string)", 'origin: string, basePath = "")')
      .replace(
        "new URL(locationPagePath(location.slug), origin)",
        "new URL(basePath + locationPagePath(location.slug), origin)",
      )
      .replace('new URL("/", origin)', 'new URL(basePath || "/", origin)');
  }
  const output = path.join(target, relative);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, '"use client";\n\n' + code);
}
await writeFile(path.join(target, "source-parity.json"), JSON.stringify(manifest, null, 2) + "\n");
await import("./build-gated-pages.mjs");
