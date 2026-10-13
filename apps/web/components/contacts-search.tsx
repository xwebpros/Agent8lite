"use client";

import { ArrowRight, Filter, Mail, Phone, RefreshCw, Search, ShieldCheck, Users } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import type { Schema } from "../lib/api";
import {
  ContactsSearchController,
  contactSearchContextBinding,
  contactSearchExpired,
  contactSearchRequest,
  contactSearchRowLimit,
  requireLoadedContactResults,
  type ContactsSearchFilters,
  type ContactsSearchScope,
  type ContactsSearchState,
} from "./contacts-search-controller";
import styles from "./contacts-search.module.css";

export type ContactsSearchProps = {
  session: Schema<"Session">;
  memberId: string;
  accessRevision: number;
  scope: ContactsSearchScope;
  online: boolean;
  changingOrganization?: boolean;
  refreshMarker: string | null;
  actionsBlocked?: boolean;
  stages: { id: string; name: string }[];
  sources: { id: string; label: string }[];
  onOpenContact(id: string): void;
  onAccessRevoked?(): void;
};
export type ContactsSearchActions = {
  changeQuery(value: string): void;
  changeFilter(key: keyof ContactsSearchFilters, value: string): void;
  submit(): void;
  refresh(): void;
  more(): void;
  openContact(id: string): void;
};
export function ContactsSearchView({
  state,
  scope,
  nowInstant,
  actions,
  actionsBlocked = false,
  stages = [],
  sources = [],
}: {
  state: ContactsSearchState;
  scope: ContactsSearchScope;
  nowInstant: unknown;
  actions: ContactsSearchActions;
  actionsBlocked?: boolean;
  stages?: { id: string; name: string }[];
  sources?: { id: string; label: string }[];
}) {
  const heading = useId(),
    hint = useId(),
    field = useId();
  const readable = state.online && state.visible && state.canRead;
  let page: Schema<"PageContact"> | null = null,
    invalid = false;
  if (readable && !state.reading && state.page) {
    try {
      page = requireLoadedContactResults(state.page);
    } catch {
      invalid = true;
    }
  }
  const stale =
    state.phase === "stale" || Boolean(page && contactSearchExpired(state.refreshedAt, nowInstant));
  if (stale || state.appliedQuery !== state.query) page = null;
  const invalidQuery =
    state.error === "Enter a name query of at most 200 characters. The previous results are hidden.";
  const message = !state.online
    ? "Offline. Private name queries and contact results are hidden."
    : !state.visible
      ? "Private name queries and contact results are hidden while this view is inactive."
      : !state.canRead
        ? "Contact search access is unavailable. Use Refresh workspace to verify current access."
        : state.reading
          ? "Verifying the current contact search and its loaded pages…"
          : invalidQuery
            ? "Enter a name query of at most 200 characters. The previous results are hidden."
            : stale
              ? "The contact list is stale. Results are hidden until you refresh."
              : invalid
                ? "Contact search metadata is unavailable. Refresh to read verified results."
                : state.phase === "unavailable"
                  ? "Contact search is unavailable. Retry when connected; no empty list has been inferred."
                  : !page
                    ? "Enter a name and search, or leave it empty to load contacts in your current scope."
                    : null;
  return (
    <section className={styles.panel} aria-labelledby={heading}>
      <header className={styles.header}>
        <div>
          <h2 id={heading}>
            <Users size={21} aria-hidden="true" />
            Find contacts
          </h2>
          <p>
            {scope === "own"
              ? "My workspace · Your current member filter and contact-read permission apply."
              : "All permitted records · Your current contact-read permission still applies."}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={!readable || state.reading}
          onClick={actions.refresh}
        >
          <RefreshCw size={16} aria-hidden="true" />
          Refresh contacts
        </Button>
      </header>
      <form
        className={styles.search}
        role="search"
        aria-label="Contact name search"
        onSubmit={(event) => {
          event.preventDefault();
          if (readable && !state.reading) actions.submit();
        }}
      >
        <div className={styles.field}>
          <label htmlFor={field}>Contact name</label>
          <input
            id={field}
            type="text"
            inputMode="text"
            autoComplete="off"
            value={readable ? state.query : ""}
            aria-describedby={hint}
            aria-invalid={readable && invalidQuery}
            disabled={!readable}
            placeholder="Search contact names…"
            onChange={(event) => actions.changeQuery(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={!readable || state.reading}>
          <Search size={17} aria-hidden="true" />
          Search names
        </Button>
      </form>
      <div className={styles.filters}>
        <Filter size={16} aria-hidden="true" />
        <label>
          Intent
          <select
            value={state.filters.intent}
            disabled={!readable}
            onChange={(e) => actions.changeFilter("intent", e.target.value)}
          >
            <option value="">All</option>
            <option value="buyer">Buyer</option>
            <option value="seller">Seller</option>
            <option value="both">Both</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        {stages.length > 0 && (
          <label>
            Stage
            <select
              value={state.filters.stageId}
              disabled={!readable}
              onChange={(e) => actions.changeFilter("stageId", e.target.value)}
            >
              <option value="">All stages</option>
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {sources.length > 0 && (
          <label>
            Source
            <select
              value={state.filters.sourceId}
              disabled={!readable}
              onChange={(e) => actions.changeFilter("sourceId", e.target.value)}
            >
              <option value="">All sources</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p id={hint} className={styles.caption}>
        Name search matches literal text, ignoring case. It does not search email or phone. Spaces are
        preserved. Maximum 200 characters, including emoji.
      </p>
      {message && (
        <p className={styles.message} role="status">
          {message}
        </p>
      )}
      {page && (
        <>
          <div className={styles.summary}>
            <Badge>
              {page.items.length} loaded {state.appliedQuery ? "matches" : "contacts"}
            </Badge>
            <span>
              {page.hasMore ? "More records are available" : "The current result pages have been read"}
            </span>
          </div>
          {state.appliedQuery && (
            <p className={styles.query}>
              Name query: <span>{state.appliedQuery}</span>
            </p>
          )}
          {!page.items.length ? (
            <Empty
              icon={<Users size={27} />}
              title={state.appliedQuery ? "No matching contact names" : "No contacts returned"}
            >
              No contacts were returned for this name query and your current scope at this read.
            </Empty>
          ) : (
            <ul className={styles.list} aria-label="Loaded contact search results">
              {page.items.map((contact) => (
                <li key={contact.id} className={styles.card}>
                  <div className={styles.identity}>
                    <span className={styles.avatar} aria-hidden="true">
                      <Users size={21} />
                    </span>
                    <div>
                      <h3>{contact.displayName || "Name not provided"}</h3>
                      <span className={styles.version}>Record version {contact.version}</span>
                    </div>
                  </div>
                  <div className={styles.channel}>
                    <Mail size={16} aria-hidden="true" />
                    <span>{contact.emails[0] || "Email not provided"}</span>
                  </div>
                  <div className={styles.channel}>
                    <Phone size={16} aria-hidden="true" />
                    <span>{contact.phones[0] || "Phone not provided"}</span>
                  </div>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={!readable || state.reading || actionsBlocked}
                    aria-label={"Open contact: " + (contact.displayName || "Name not provided")}
                    onClick={() => actions.openContact(contact.id)}
                  >
                    Open contact
                    <ArrowRight size={16} aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {actionsBlocked && page.items.length > 0 && (
            <p className={styles.caption}>
              Contact navigation is paused while the workspace is loading or another draft or command needs
              attention.
            </p>
          )}
          {page.hasMore && page.items.length < contactSearchRowLimit && (
            <Button
              type="button"
              variant="secondary"
              disabled={!readable || state.reading}
              onClick={actions.more}
            >
              Load more matching contacts
            </Button>
          )}
          {page.hasMore && page.items.length >= contactSearchRowLimit && (
            <p className={styles.message}>
              Showing the limit of 200 loaded contacts. Refine your name query or refresh the current list.
            </p>
          )}
          <p className={styles.caption}>
            Source: Contacts · Read at{" "}
            <time dateTime={state.refreshedAt || undefined}>{state.refreshedAt}</time> (UTC). Loaded results
            can change between reads; the loaded count describes this search.
          </p>
        </>
      )}
      <p className={styles.caption}>
        <ShieldCheck size={15} aria-hidden="true" />
        Queries and results stay only in this tab’s memory. Refresh and load more check current access and
        results. Results expire from this view after five minutes; this is a presentation limit, not a
        provider guarantee. Saved filters are unavailable.
      </p>
    </section>
  );
}

export default function ContactsSearch(props: ContactsSearchProps) {
  const live = useRef(props);
  live.current = props;
  const binding = contactSearchContextBinding(props);
  const verifiedRefresh = useRef({ binding, marker: props.refreshMarker });
  if (
    verifiedRefresh.current.binding !== binding ||
    (props.refreshMarker !== null && props.refreshMarker !== verifiedRefresh.current.marker)
  )
    verifiedRefresh.current = { binding, marker: props.refreshMarker };
  const marker = verifiedRefresh.current.marker;
  const canRead =
    props.session.permissions.includes("crm.contacts.read") &&
    Boolean(props.session.activeOrgId && props.memberId);
  const [clock, setClock] = useState<string | null>(null);
  const controller = useMemo(() => {
    const current = () =>
      contactSearchContextBinding(live.current) === binding &&
      live.current.refreshMarker === marker &&
      live.current.online &&
      !live.current.changingOrganization &&
      live.current.session.permissions.includes("crm.contacts.read") &&
      document.visibilityState === "visible";
    return new ContactsSearchController({
      binding,
      memberId: props.memberId,
      scope: props.scope,
      online: props.online && !props.changingOrganization,
      canRead,
      isCurrent: current,
      client: {
        list: (filter, cursor, signal) => {
          if (!current()) return Promise.reject(new Error("Contact search context is unavailable."));
          return contactSearchRequest(live.current.session.activeOrgId || "", filter, cursor, signal);
        },
      },
      onAccessRevoked: () => live.current.onAccessRevoked?.(),
    });
  }, [binding, marker]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.attach();
    const flags = () => {
      controller.setOnline(live.current.online && !live.current.changingOrganization);
      controller.setPermissions(canRead);
      controller.setVisible(document.visibilityState === "visible");
    };
    const tick = () => {
      flags();
      setClock(
        live.current.online && !live.current.changingOrganization && document.visibilityState === "visible"
          ? new Date().toISOString()
          : null,
      );
      controller.tick();
    };
    const focus = () => {
      tick();
      if (document.visibilityState === "visible") void controller.refresh();
    };
    focus();
    const interval = window.setInterval(tick, 30000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      controller.detach();
    };
  }, [controller, props.online, props.changingOrganization, props.refreshMarker, canRead]);
  const visible =
    typeof document !== "undefined" && document.visibilityState === "visible" && !props.changingOrganization;
  const current = () =>
    contactSearchContextBinding(live.current) === binding &&
    live.current.refreshMarker === marker &&
    live.current.online &&
    !live.current.changingOrganization &&
    live.current.session.permissions.includes("crm.contacts.read") &&
    typeof document !== "undefined" &&
    document.visibilityState === "visible";
  const sourceCurrent = current();
  const safeState: ContactsSearchState = {
    ...state,
    online: props.online,
    visible,
    canRead: canRead && state.canRead,
    query: sourceCurrent ? state.query : "",
    appliedQuery: sourceCurrent ? state.appliedQuery : null,
    filters: sourceCurrent ? state.filters : { intent: "", stageId: "", sourceId: "" },
    page: sourceCurrent ? state.page : null,
    refreshedAt: sourceCurrent ? state.refreshedAt : null,
  };
  return (
    <ContactsSearchView
      state={safeState}
      scope={props.scope}
      nowInstant={clock ? new Date().toISOString() : null}
      actionsBlocked={props.actionsBlocked}
      stages={props.stages}
      sources={props.sources}
      actions={{
        changeQuery: (value) => {
          if (current()) controller.setQuery(value);
        },
        changeFilter: (key, value) => {
          if (current()) controller.setFilter(key, value);
        },
        submit: () => {
          if (current() && !controller.getSnapshot().reading) {
            setClock(new Date().toISOString());
            void controller.submit();
          }
        },
        refresh: () => {
          if (current() && !controller.getSnapshot().reading) {
            setClock(new Date().toISOString());
            void controller.refresh();
          }
        },
        more: () => {
          if (current()) void controller.more();
        },
        openContact: (id) => {
          if (current() && !live.current.actionsBlocked && controller.hasCurrentContact(id))
            live.current.onOpenContact(id);
        },
      }}
    />
  );
}
