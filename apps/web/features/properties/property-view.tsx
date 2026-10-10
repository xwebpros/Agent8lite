import type { components } from "../../../../packages/contracts/generated/api";
import styles from "./properties.module.css";

export type PropertyListing = components["schemas"]["Listing"];
type PropertyPage = components["schemas"]["PageListing"];

/** A null page means no successful current read; only a current empty page means no matches. */
export function PropertyResultFeedback({
  page,
  loading,
  expired,
  notice,
}: {
  page: PropertyPage | null;
  loading: boolean;
  expired: boolean;
  notice: string;
}) {
  return (
    <>
      <p role="status" aria-live="polite" className={styles.notice}>
        {loading
          ? "Checking current synthetic properties…"
          : expired
            ? "Current synthetic results expired. Refresh to recheck access and availability."
            : notice ||
              (page
                ? `${page.items.length} synthetic ${page.items.length === 1 ? "property" : "properties"} loaded${page.hasMore ? " — more available" : ""}.`
                : "")}
      </p>
      {!loading && !expired && page?.items.length === 0 && (
        <p className={styles.empty}>No currently permitted synthetic properties match these filters.</p>
      )}
    </>
  );
}

export function propertyPrice(item: PropertyListing) {
  if (item.listPrice == null) return "Price withheld";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: item.currency,
      maximumFractionDigits: 0,
    }).format(item.listPrice);
  } catch {
    return `${item.listPrice.toLocaleString("en-US")} ${item.currency}`;
  }
}
function date(value: string | null | undefined, timezone: string) {
  if (!value) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}
export function PropertyAttribution({ item, timezone }: { item: PropertyListing; timezone: string }) {
  return (
    <footer className={styles.attribution}>
      {item.attribution.agentName && <p>Agent: {item.attribution.agentName}</p>}
      <p>{item.attribution.disclaimer}</p>
      <p>
        Source update: {date(item.sourceUpdatedAt, timezone)} · Valid until{" "}
        <time dateTime={item.expiresAt}>{date(item.expiresAt, timezone)}</time>
      </p>
    </footer>
  );
}
export function PropertyParticipantAttribution({ item }: { item: PropertyListing }) {
  const { brokerageName, contact } = item.attribution;
  if (!brokerageName && !contact) return null;
  return (
    <section className={styles.participantAttribution} aria-label="Listing attribution">
      {brokerageName && <p>Listing firm: {brokerageName}</p>}
      {contact && (
        <p>
          {contact.kind === "email" ? "Email" : "Phone"}: {contact.value}
        </p>
      )}
    </section>
  );
}
export function PropertyFacts({ item }: { item: PropertyListing }) {
  return (
    <dl className={styles.facts}>
      <div>
        <dt>Bedrooms</dt>
        <dd>{item.bedrooms ?? "Withheld"}</dd>
      </div>
      <div>
        <dt>Bathrooms</dt>
        <dd>{item.bathrooms ?? "Withheld"}</dd>
      </div>
      <div>
        <dt>Living area</dt>
        <dd>
          {item.livingAreaSqft == null ? "Withheld" : `${item.livingAreaSqft.toLocaleString("en-US")} sq ft`}
        </dd>
      </div>
      <div>
        <dt>Property type</dt>
        <dd>{item.propertyType ?? "Withheld"}</dd>
      </div>
    </dl>
  );
}
export function PropertyCard({
  item,
  timezone,
  onOpen,
  registerControl,
  expanded = false,
  controlsId,
}: {
  item: PropertyListing;
  timezone: string;
  onOpen: (id: string, button: HTMLButtonElement) => void;
  registerControl?: (id: string, button: HTMLButtonElement) => () => void;
  expanded?: boolean;
  controlsId?: string;
}) {
  return (
    <article className={styles.card}>
      <p className={styles.synthetic}>SYNTHETIC DEMO DATA</p>
      <h3>{item.displayAddress ?? "Address withheld by current policy"}</h3>
      <p className={styles.price}>
        {propertyPrice(item)} <span className={styles.status}>{item.status}</span>
      </p>
      <PropertyParticipantAttribution item={item} />
      <PropertyFacts item={item} />
      <button
        ref={(button) => (button ? registerControl?.(item.id, button) : undefined)}
        className={styles.open}
        type="button"
        onClick={(event) => onOpen(item.id, event.currentTarget)}
        aria-label={`View synthetic property details: ${item.displayAddress ?? `record ${item.id.slice(0, 8)}`}`}
        aria-expanded={expanded}
        aria-controls={controlsId}
      >
        View details
      </button>
      <PropertyAttribution item={item} timezone={timezone} />
    </article>
  );
}
export function PropertyDetail({ item, timezone }: { item: PropertyListing; timezone: string }) {
  return (
    <>
      <p className={styles.synthetic}>SYNTHETIC DEMO DATA — fictional property, no real offer</p>
      <h3>{item.displayAddress ?? "Address withheld by current policy"}</h3>
      <p className={styles.price}>
        {propertyPrice(item)} <span className={styles.status}>{item.status}</span>
      </p>
      <PropertyParticipantAttribution item={item} />
      <PropertyFacts item={item} />
      <p className={styles.remarks}>{item.remarks ?? "Remarks withheld by current policy."}</p>
      {item.latitude != null && item.longitude != null && (
        <p>
          Permitted synthetic location: {item.latitude.toFixed(4)}, {item.longitude.toFixed(4)}
        </p>
      )}
      <PropertyAttribution item={item} timezone={timezone} />
    </>
  );
}
