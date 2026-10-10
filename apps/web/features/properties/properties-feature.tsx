"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { components } from "../../../../packages/contracts/generated/api";
import { api, ApiError } from "../../lib/api";
import { PropertyDetailFocus } from "./detail-focus";
import { PropertyCard, PropertyDetail, type PropertyListing } from "./property-view";
import { propertiesAreCurrent, propertyExpiryDelay, PropertyReads } from "./read-lifecycle";
import { loadMorePropertyPage, refreshPropertyPages } from "./refresh-pages";
import {
  emptyPropertyFilters,
  propertySearchParams,
  type PropertyFilters,
  type PropertySort,
} from "./search-input";
import styles from "./properties.module.css";

type Page = components["schemas"]["PageListing"];
export interface PropertiesFeatureProps {
  session: components["schemas"]["Session"];
  online: boolean;
  syntheticFeaturesEnabled: boolean;
  accessRevision: number;
  onAccessRevoked?: () => void;
}
type ScopedPage = { scope: string; page: Page };
type ScopedDetail = { scope: string; item: PropertyListing };
const emptyPage: Page = { items: [], hasMore: false, nextCursor: null };

/** Memory-only authenticated synthetic feature; the coordinator registers its shell view. */
export default function PropertiesFeature({
  session,
  online,
  syntheticFeaturesEnabled,
  accessRevision,
  onAccessRevoked,
}: PropertiesFeatureProps) {
  const [filters, setFilters] = useState<PropertyFilters>({ ...emptyPropertyFilters });
  const [sort, setSort] = useState<PropertySort>("updated_desc");
  const [result, setResult] = useState<ScopedPage | null>(null);
  const [detail, setDetail] = useState<ScopedDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState("");
  const [deniedContext, setDeniedContext] = useState<string | null>(null);
  const context = `${session.userId}:${session.activeOrgId}:${accessRevision}:${session.permissions.join(",")}:${syntheticFeaturesEnabled}`;
  const denied = deniedContext === context;
  const revoked = useRef(onAccessRevoked);
  revoked.current = onAccessRevoked;
  const [reads] = useState(() => new PropertyReads());
  const [detailFocus] = useState(() => new PropertyDetailFocus());
  const currentSelection = useRef<string | null>(null);
  const applied = useRef(propertySearchParams(emptyPropertyFilters, "updated_desc"));
  const paging = useRef(new URLSearchParams(applied.current));
  const consumedCursors = useRef<readonly string[]>([]);
  const visibleCount = useRef(20);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const propertiesHeading = useRef<HTMLHeadingElement>(null);
  const permitted =
    syntheticFeaturesEnabled && Boolean(session.activeOrgId) && session.permissions.includes("mls.read");
  const enabled = permitted && online && !denied;
  const live = useRef({ scope: context, enabled, result });
  live.current = { scope: context, enabled, result };
  const base = `/dev/orgs/${session.activeOrgId}/mls/listings`;
  // Render guards apply before effects, so a changed scope/offline state cannot flash previous private data.
  const scopedPage = enabled && result?.scope === context ? result.page : emptyPage;
  const scopedDetail = enabled && detail?.scope === context ? detail.item : null;
  const expired = !propertiesAreCurrent([...scopedPage.items, ...(scopedDetail ? [scopedDetail] : [])]);
  const page = expired ? emptyPage : scopedPage;
  const currentDetail = expired ? null : scopedDetail;
  if (enabled && result?.scope === context && !expired) visibleCount.current = page.items.length;

  const clearPrivate = useCallback(() => {
    reads.clear();
    visibleCount.current = 20;
    paging.current = new URLSearchParams(applied.current);
    consumedCursors.current = [];
    setResult(null);
    setDetail(null);
    setLoaded(false);
    setLoading(false);
    setDetailLoading(false);
  }, [reads]);
  const failed = useCallback(
    (failure: unknown) => {
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) {
        clearPrivate();
        live.current.enabled = false;
        setDeniedContext(context);
        revoked.current?.();
      }
      return failure instanceof Error
        ? failure.message
        : "Synthetic properties are unavailable. Try refreshing.";
    },
    [clearPrivate, context],
  );

  const loadDetail = useCallback(
    async (id: string) => {
      if (!live.current.enabled || live.current.scope !== context) return;
      const request = reads.begin("detail", context);
      setDetail(null);
      setDetailLoading(true);
      setDetailError("");
      try {
        const response = await api<PropertyListing>(`${base}/${encodeURIComponent(id)}`, {
          signal: request.controller.signal,
        });
        if (!reads.current(request, live.current.scope, live.current.enabled)) return;
        if (!propertiesAreCurrent([response.data]))
          throw new Error("This synthetic property has expired. Refresh the search.");
        setDetail({ scope: context, item: response.data });
      } catch (failure) {
        if (!reads.current(request, live.current.scope, live.current.enabled)) return;
        // Invalidate both pending reads as well as the displayed records.
        clearPrivate();
        setDetailError(failed(failure));
      } finally {
        if (reads.current(request, live.current.scope, live.current.enabled)) setDetailLoading(false);
        reads.finish(request);
      }
    },
    [base, context, clearPrivate, failed, reads],
  );

  const loadPage = useCallback(
    async (params: URLSearchParams, append = false, cursor?: string | null, count = 20) => {
      if (!live.current.enabled || live.current.scope !== context) return;
      const request = reads.begin("list", context);
      const parentResult = live.current.result;
      const history = consumedCursors.current;
      const query = new URLSearchParams(append ? paging.current : params);
      if (append && cursor) query.set("cursor", cursor);
      if (!append) {
        consumedCursors.current = [];
        setResult(null);
        setLoaded(false);
      }
      setLoading(true);
      setError("");
      setNotice("");
      try {
        const read = async (query: URLSearchParams) =>
          (await api<Page>(`${base}?${query}`, { signal: request.controller.signal })).data;
        const response = append
          ? await loadMorePropertyPage(
              parentResult?.scope === context ? parentResult.page : emptyPage,
              query,
              history,
              read,
              () => reads.current(request, live.current.scope, live.current.enabled),
            )
          : await refreshPropertyPages(params, count, read, () =>
              reads.current(request, live.current.scope, live.current.enabled),
            );
        if (!reads.current(request, live.current.scope, live.current.enabled)) return;
        if (!response) return;
        if (!propertiesAreCurrent(response.page.items))
          throw new Error("These synthetic results expired while loading. Refresh the search.");
        paging.current = response.params;
        consumedCursors.current = response.consumedCursors;
        setResult((previous) => {
          if (!reads.current(request, live.current.scope, live.current.enabled)) return previous;
          if (append && previous !== parentResult) return previous;
          return {
            scope: context,
            page: response.page,
          };
        });
        setLoaded(true);
      } catch (failure) {
        if (!reads.current(request, live.current.scope, live.current.enabled)) return;
        // Stale cursors and source errors invalidate already displayed pages/details too.
        clearPrivate();
        setError(failed(failure));
      } finally {
        if (reads.current(request, live.current.scope, live.current.enabled)) setLoading(false);
        reads.finish(request);
      }
    },
    [base, context, clearPrivate, failed, reads],
  );

  useEffect(() => {
    clearPrivate();
    detailFocus.reset();
    setError("");
    setDetailError("");
    setNotice("");
    currentSelection.current = null;
    setSelectedId(null);
    setFilters({ ...emptyPropertyFilters });
    setSort("updated_desc");
    applied.current = propertySearchParams(emptyPropertyFilters, "updated_desc");
    paging.current = new URLSearchParams(applied.current);
    if (permitted && online) void loadPage(applied.current);
    return () => {
      reads.clear();
      detailFocus.reset();
    };
  }, [context, online, permitted, clearPrivate, loadPage, reads, detailFocus]);

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (reads.busy("list") || reads.busy("detail")) return;
      void loadPage(applied.current, false, null, visibleCount.current);
      if (currentSelection.current) void loadDetail(currentSelection.current);
    };
    const timer = setInterval(refresh, 30_000);
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, loadPage, loadDetail, reads]);

  useEffect(() => {
    const items = [...scopedPage.items, ...(scopedDetail ? [scopedDetail] : [])];
    if (!items.length) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      if (!propertiesAreCurrent(items)) {
        clearPrivate();
        setNotice("Current synthetic results expired. Refresh to recheck access and availability.");
      } else timer = setTimeout(check, propertyExpiryDelay(items)!);
    };
    timer = setTimeout(check, propertyExpiryDelay(items)!);
    return () => clearTimeout(timer);
  }, [scopedPage, scopedDetail, clearPrivate]);

  useEffect(() => {
    detailFocus.show(context, enabled, detailHeading.current);
  }, [context, enabled, selectedId, detailFocus]);

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const params = propertySearchParams(filters, sort);
      applied.current = params;
      currentSelection.current = null;
      detailFocus.dismiss();
      setSelectedId(null);
      setDetail(null);
      reads.cancel("detail");
      setDetailError("");
      setDetailLoading(false);
      void loadPage(params);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Check the search filters.");
    }
  }
  const field = (key: keyof PropertyFilters, value: string) =>
    setFilters((previous) => ({ ...previous, [key]: value }));
  function closeDetail(restoreFocus = true) {
    reads.cancel("detail");
    currentSelection.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailError("");
    setDetailLoading(false);
    if (restoreFocus)
      detailFocus.close(
        context,
        live.current.enabled && live.current.scope === context,
        propertiesHeading.current,
      );
    else detailFocus.dismiss();
  }

  return (
    <section className={styles.feature} aria-labelledby="properties-title">
      <header className={styles.header}>
        <div>
          <p className={styles.synthetic}>SYNTHETIC DEMO DATA</p>
          <h2 ref={propertiesHeading} tabIndex={-1} id="properties-title">
            Properties
          </h2>
          <p>
            Fictional sample records. Current field permissions and availability are checked on every read.
          </p>
        </div>
        <button
          className={styles.secondary}
          type="button"
          disabled={!enabled || loading}
          onClick={() => {
            void loadPage(applied.current, false, null, visibleCount.current);
            if (currentSelection.current) void loadDetail(currentSelection.current);
          }}
        >
          Refresh results
        </button>
      </header>
      {!permitted && <p role="status">Synthetic properties require organization MLS read access.</p>}
      {!online && (
        <p role="status">
          Connect to read current synthetic properties. Private results are hidden while offline.
        </p>
      )}
      {denied && (
        <p role="alert">Property access is unavailable. Refresh your workspace access to continue.</p>
      )}
      {permitted && (
        <form onSubmit={submit} className={styles.filters}>
          <fieldset disabled={!enabled || loading}>
            <legend>Search synthetic properties</legend>
            <div className={styles.fields}>
              <label>
                Keywords
                <input
                  value={filters.q}
                  maxLength={120}
                  onChange={(event) => field("q", event.target.value)}
                  type="search"
                  autoComplete="off"
                />
              </label>
              <label>
                Minimum price
                <input
                  type="number"
                  min="0"
                  step="1"
                  inputMode="decimal"
                  value={filters.priceMin}
                  onChange={(event) => field("priceMin", event.target.value)}
                />
              </label>
              <label>
                Maximum price
                <input
                  type="number"
                  min="0"
                  step="1"
                  inputMode="decimal"
                  value={filters.priceMax}
                  onChange={(event) => field("priceMax", event.target.value)}
                />
              </label>
              <label>
                Minimum bedrooms
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  inputMode="numeric"
                  value={filters.bedroomsMin}
                  onChange={(event) => field("bedroomsMin", event.target.value)}
                />
              </label>
              <label>
                Minimum bathrooms
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  inputMode="decimal"
                  value={filters.bathroomsMin}
                  onChange={(event) => field("bathroomsMin", event.target.value)}
                />
              </label>
              <label>
                Property type
                <input
                  value={filters.propertyType}
                  maxLength={80}
                  placeholder="sample residential"
                  onChange={(event) => field("propertyType", event.target.value)}
                />
              </label>
              <label>
                Status
                <select value={filters.status} onChange={(event) => field("status", event.target.value)}>
                  <option value="">Active and pending</option>
                  <option value="active">Active</option>
                  <option value="pending">Pending</option>
                </select>
              </label>
              <label>
                Sort
                <select value={sort} onChange={(event) => setSort(event.target.value as PropertySort)}>
                  <option value="updated_desc">Latest permitted source update</option>
                  <option value="price_asc">Price: low to high</option>
                  <option value="price_desc">Price: high to low</option>
                </select>
              </label>
            </div>
            <details className={styles.bounds}>
              <summary>Optional synthetic location bounds</summary>
              <p>
                Hidden locations cannot match these bounds. Longitude/latitude; at most five degrees across.
              </p>
              <div className={styles.fields}>
                {(
                  [
                    ["west", "West longitude"],
                    ["south", "South latitude"],
                    ["east", "East longitude"],
                    ["north", "North latitude"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={filters[key]}
                      onChange={(event) => field(key, event.target.value)}
                    />
                  </label>
                ))}
              </div>
            </details>
            <div className={styles.actions}>
              <button className={styles.primary} type="submit">
                Apply filters
              </button>
              <button
                className={styles.secondary}
                type="button"
                onClick={() => {
                  setFilters({ ...emptyPropertyFilters });
                  setSort("updated_desc");
                  applied.current = propertySearchParams(emptyPropertyFilters, "updated_desc");
                  closeDetail(false);
                  void loadPage(applied.current);
                }}
              >
                Clear filters
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <p role="status" aria-live="polite" className={styles.notice}>
        {loading
          ? "Checking current synthetic properties…"
          : (expired
              ? "Current synthetic results expired. Refresh to recheck access and availability."
              : notice) ||
            (enabled && loaded
              ? `${page.items.length} synthetic ${page.items.length === 1 ? "property" : "properties"} loaded${page.hasMore ? " — more available" : ""}.`
              : "")}
      </p>
      {enabled && selectedId && (
        <section
          id="property-detail-panel"
          className={styles.detail}
          aria-labelledby="property-detail-title"
          aria-busy={detailLoading}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            closeDetail();
          }}
        >
          <div className={styles.header}>
            <h2 ref={detailHeading} tabIndex={-1} id="property-detail-title">
              Synthetic property details
            </h2>
            <button className={styles.secondary} type="button" onClick={() => closeDetail()}>
              Close details
            </button>
          </div>
          {detailLoading && <p role="status">Rechecking current property access…</p>}
          {detailError && <p role="alert">{detailError}</p>}
          {!detailLoading && !detailError && !currentDetail && (
            <p role="status">Refresh to recheck current property details.</p>
          )}
          {currentDetail && <PropertyDetail item={currentDetail} timezone={session.profile.timezone} />}
        </section>
      )}
      {enabled && loaded && !loading && !page.items.length && (
        <p className={styles.empty}>No currently permitted synthetic properties match these filters.</p>
      )}
      <ul className={styles.results} aria-label="Synthetic property results" aria-busy={loading}>
        {page.items.map((item) => (
          <li key={item.id}>
            <PropertyCard
              item={item}
              timezone={session.profile.timezone}
              registerControl={(id, button) => detailFocus.register(context, id, button)}
              expanded={selectedId === item.id}
              controlsId={selectedId === item.id ? "property-detail-panel" : undefined}
              onOpen={(id) => {
                detailFocus.open(context, id);
                currentSelection.current = id;
                setSelectedId(id);
                void loadDetail(id);
                // An already open panel has a mounted heading even when selectedId stays the same.
                detailFocus.show(
                  context,
                  live.current.enabled && live.current.scope === context,
                  detailHeading.current,
                );
              }}
            />
          </li>
        ))}
      </ul>
      {enabled && page.hasMore && (
        <button
          className={styles.secondary}
          type="button"
          disabled={loading}
          onClick={() => void loadPage(applied.current, true, page.nextCursor)}
        >
          Load more synthetic properties
        </button>
      )}
    </section>
  );
}
