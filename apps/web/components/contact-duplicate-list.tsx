"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";

type Contact = Schema<"Contact">;
type ContactDuplicate = Schema<"ContactDuplicate">;

export type ContactDuplicateListProps = {
  organizationId: string;
  survivorContact: Contact;
  /** Whether the user has permission and state allows initiating a merge. */
  canMerge: boolean;
  online: boolean;
  /** Called when user clicks "Merge into this contact" on a candidate. */
  onSelectSource(source: Contact, phoneOnly: boolean): void;
};

type CandidateState = { kind: "loading" } | { kind: "error" } | { kind: "loaded"; contact: Contact };

export function ContactDuplicateList({
  organizationId,
  survivorContact,
  canMerge,
  online,
  onSelectSource,
}: ContactDuplicateListProps) {
  const [duplicates, setDuplicates] = useState<ContactDuplicate[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [candidates, setCandidates] = useState<Map<string, CandidateState>>(new Map());
  const epochRef = useRef(0);

  const load = useCallback(async () => {
    if (!online) return;
    const epoch = ++epochRef.current;
    setListLoading(true);
    setListError("");
    setDuplicates(null);
    setCandidates(new Map());
    try {
      const result = await api<Schema<"PageContactDuplicate">>(
        `/v1/orgs/${encodeURIComponent(organizationId)}/contact-duplicates`,
      );
      if (epochRef.current !== epoch) return;
      const myId = survivorContact.id.toLowerCase();
      const mine = result.data.items.filter((d) => d.contactIds.some((id) => id.toLowerCase() === myId));
      setDuplicates(mine);
      for (const dup of mine) {
        const sourceId = dup.contactIds.find((id) => id.toLowerCase() !== myId) ?? dup.contactIds[0];
        if (!sourceId) continue;
        const loadEpoch = epoch;
        setCandidates((prev) => new Map(prev).set(sourceId, { kind: "loading" }));
        api<Contact>(
          `/v1/orgs/${encodeURIComponent(organizationId)}/contacts/${encodeURIComponent(sourceId)}`,
        )
          .then((resp) => {
            if (epochRef.current !== loadEpoch) return;
            setCandidates((prev) => new Map(prev).set(sourceId, { kind: "loaded", contact: resp.data }));
          })
          .catch(() => {
            if (epochRef.current !== loadEpoch) return;
            setCandidates((prev) => new Map(prev).set(sourceId, { kind: "error" }));
          });
      }
    } catch (err) {
      if (epochRef.current !== epoch) return;
      setListError(err instanceof ApiError ? err.message : "Could not load duplicate candidates.");
    } finally {
      if (epochRef.current === epoch) setListLoading(false);
    }
  }, [organizationId, survivorContact.id, online]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!online) return null;
  if (listLoading && !duplicates)
    return (
      <p role="status" style={{ fontSize: "0.875rem" }}>
        Loading possible duplicates…
      </p>
    );
  if (listError)
    return (
      <p role="status" style={{ fontSize: "0.875rem" }}>
        {listError}
      </p>
    );
  if (!duplicates || duplicates.length === 0) return null;

  const myId = survivorContact.id.toLowerCase();

  return (
    <section aria-labelledby="duplicate-list-heading" style={{ marginTop: "1rem" }}>
      <h4 id="duplicate-list-heading" style={{ marginBottom: "0.5rem" }}>
        Possible duplicates ({duplicates.length})
      </h4>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        {duplicates.map((dup) => {
          const sourceId = dup.contactIds.find((id) => id.toLowerCase() !== myId) ?? dup.contactIds[0];
          if (!sourceId) return null;
          const cand = candidates.get(sourceId);
          return (
            <li
              key={dup.id}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}
            >
              {(!cand || cand.kind === "loading") && <span style={{ fontSize: "0.875rem" }}>Loading…</span>}
              {cand?.kind === "error" && <span style={{ fontSize: "0.875rem" }}>Contact unavailable</span>}
              {cand?.kind === "loaded" && (
                <>
                  <span style={{ fontSize: "0.875rem" }}>
                    {cand.contact.displayName}
                    {dup.phoneOnly && (
                      <span style={{ marginLeft: "0.25rem", opacity: 0.75 }}>(phone only)</span>
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={!canMerge}
                    onClick={() => onSelectSource(cand.contact, dup.phoneOnly)}
                    style={{ fontSize: "0.8125rem" }}
                  >
                    Merge into {survivorContact.displayName}
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
