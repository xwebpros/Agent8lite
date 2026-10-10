"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { components } from "../../../../packages/contracts/generated/api";
import { api, ApiError } from "../../lib/api";
import { PropertyCard, PropertyDetail, type PropertyListing } from "./property-view";
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
const interrupted = (error: unknown) => error instanceof Error && error.name === "AbortError";

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
  const [denied, setDenied] = useState(false);
  const context = `${session.userId}:${session.activeOrgId}:${accessRevision}:${session.permissions.join(",")}:${syntheticFeaturesEnabled}`;
  const scope = useRef(context);
  scope.current = context;
  const revoked = useRef(onAccessRevoked);
  revoked.current = onAccessRevoked;
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const listRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const currentSelection = useRef<string | null>(null);
  const applied = useRef(propertySearchParams(emptyPropertyFilters, "updated_desc"));
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const focusDetailOnce = useRef(false);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const permitted =
    syntheticFeaturesEnabled && Boolean(session.activeOrgId) && session.permissions.includes("mls.read");
  const enabled = permitted && online && !denied;
  const base = `/dev/orgs/${session.activeOrgId}/mls/listings`;
  // Render guards apply before effects, so a changed scope/offline state cannot flash previous private data.
  const page = enabled && result?.scope === context ? result.page : emptyPage;
  const currentDetail = enabled && detail?.scope === context ? detail.item : null;

  const clearPrivate = useCallback(() => {
    ++listEpoch.current;
    ++detailEpoch.current;
    listRequest.current?.abort();
    detailRequest.current?.abort();
    setResult(null);
    setDetail(null);
    setLoaded(false);
    setLoading(false);
    setDetailLoading(false);
  }, []);
  const failed = useCallback(
    (failure: unknown) => {
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) {
        clearPrivate();
        setDenied(true);
        revoked.current?.();
      }
      return failure instanceof Error
        ? failure.message
        : "Synthetic properties are unavailable. Try refreshing.";
    },
    [clearPrivate],
  );

  const loadDetail = useCallback(
    async (id: string) => {
      if (!permitted || !online) return;
      const generation = ++detailEpoch.current;
      detailRequest.current?.abort();
      const controller = new AbortController();
      detailRequest.current = controller;
      setDetail(null);
      setDetailLoading(true);
      setDetailError("");
      try {
        const response = await api<PropertyListing>(`${base}/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (scope.current !== context || generation !== detailEpoch.current) return;
        if (Date.parse(response.data.expiresAt) <= Date.now())
          throw new Error("This synthetic property has expired. Refresh the search.");
        setDetail({ scope: context, item: response.data });
      } catch (failure) {
        if (scope.current !== context || generation !== detailEpoch.current || interrupted(failure)) return;
        setDetailError(failed(failure));
        if (failure instanceof ApiError && [404, 422, 503].includes(failure.status)) {
          setResult(null);
          setLoaded(false);
        }
      } finally {
        if (scope.current === context && generation === detailEpoch.current) setDetailLoading(false);
      }
    },
    [base, context, failed, online, permitted],
  );

  const loadPage = useCallback(
    async (params: URLSearchParams, append = false, cursor?: string | null) => {
      if (!permitted || !online) return;
      const generation = ++listEpoch.current;
      listRequest.current?.abort();
      const controller = new AbortController();
      listRequest.current = controller;
      const query = new URLSearchParams(params);
      if (append && cursor) query.set("cursor", cursor);
      if (!append) {
        setResult(null);
        setLoaded(false);
      }
      setLoading(true);
      setError("");
      setNotice("");
      try {
        const response = await api<Page>(`${base}?${query}`, { signal: controller.signal });
        if (scope.current !== context || generation !== listEpoch.current) return;
        if (response.data.items.some((item) => Date.parse(item.expiresAt) <= Date.now()))
          throw new Error("These synthetic results expired while loading. Refresh the search.");
        setResult((previous) => {
          const items =
            append && previous?.scope === context
              ? [...previous.page.items, ...response.data.items]
              : response.data.items;
          return {
            scope: context,
            page: { ...response.data, items: [...new Map(items.map((item) => [item.id, item])).values()] },
          };
        });
        setLoaded(true);
      } catch (failure) {
        if (scope.current !== context || generation !== listEpoch.current || interrupted(failure)) return;
        // Stale cursors and source errors invalidate already displayed pages/details too.
        clearPrivate();
        setError(failed(failure));
      } finally {
        if (scope.current === context && generation === listEpoch.current) setLoading(false);
      }
    },
    [base, context, clearPrivate, failed, online, permitted],
  );

  useEffect(() => {
    clearPrivate();
    setDenied(false);
    setError("");
    setDetailError("");
    setNotice("");
    currentSelection.current = null;
    setSelectedId(null);
    setFilters({ ...emptyPropertyFilters });
    setSort("updated_desc");
    applied.current = propertySearchParams(emptyPropertyFilters, "updated_desc");
    if (permitted && online) void loadPage(applied.current);
    return () => {
      ++listEpoch.current;
      ++detailEpoch.current;
      listRequest.current?.abort();
      detailRequest.current?.abort();
    };
  }, [context, online, permitted, clearPrivate, loadPage]);

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      void loadPage(applied.current);
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
  }, [enabled, loadPage, loadDetail]);

  useEffect(() => {
    const expires = [
      ...page.items.map((item) => Date.parse(item.expiresAt)),
      ...(currentDetail ? [Date.parse(currentDetail.expiresAt)] : []),
    ];
    if (!expires.length) return;
    const timer = setTimeout(
      () => {
        clearPrivate();
        setNotice("Current synthetic results expired. Refresh to recheck access and availability.");
      },
      Math.max(0, Math.min(...expires) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [page, currentDetail, clearPrivate]);

  useEffect(() => {
    if (currentDetail && focusDetailOnce.current) {
      focusDetailOnce.current = false;
      detailHeading.current?.focus();
    }
  }, [currentDetail?.id]);

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const params = propertySearchParams(filters, sort);
      applied.current = params;
      currentSelection.current = null;
      setSelectedId(null);
      setDetail(null);
      ++detailEpoch.current;
      detailRequest.current?.abort();
      void loadPage(params);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Check the search filters.");
    }
  }
  const field = (key: keyof PropertyFilters, value: string) =>
    setFilters((previous) => ({ ...previous, [key]: value }));
  function closeDetail() {
    ++detailEpoch.current;
    detailRequest.current?.abort();
    currentSelection.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailError("");
    setDetailLoading(false);
    returnFocus.current?.focus();
  }

  return (
    <section className={styles.feature} aria-labelledby="properties-title">
      <header className={styles.header}>
        <div>
          <p className={styles.synthetic}>SYNTHETIC DEMO DATA</p>
          <h2 id="properties-title">Properties</h2>
          <p>
            Fictional sample records. Current field permissions and availability are checked on every read.
          </p>
        </div>
        <button
          className={styles.secondary}
          type="button"
          disabled={!enabled || loading}
          onClick={() => {
            void loadPage(applied.current);
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
                  closeDetail();
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
          : notice ||
            (enabled && loaded
              ? `${page.items.length} synthetic ${page.items.length === 1 ? "property" : "properties"} loaded${page.hasMore ? " — more available" : ""}.`
              : "")}
      </p>
      {enabled && selectedId && (
        <section className={styles.detail} aria-labelledby="property-detail-title" aria-busy={detailLoading}>
          <div className={styles.header}>
            <h2 ref={detailHeading} tabIndex={-1} id="property-detail-title">
              Synthetic property details
            </h2>
            <button className={styles.secondary} type="button" onClick={closeDetail}>
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
              onOpen={(id, button) => {
                returnFocus.current = button;
                focusDetailOnce.current = true;
                currentSelection.current = id;
                setSelectedId(id);
                void loadDetail(id);
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
