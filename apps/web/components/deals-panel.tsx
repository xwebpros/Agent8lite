"use client";
import { BriefcaseBusiness, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";
type Props = {
  session: Schema<"Session">;
  memberId: string;
  scope: "own" | "authorized";
  online: boolean;
  working: boolean;
  leads: Schema<"Lead">[];
  sources: { id: string; label: string }[];
  leadLabel(lead: Schema<"Lead">): string;
  runCommand: <T>(path: string, body: unknown, method?: string, version?: number) => Promise<T>;
  onDirty(value: boolean): void;
  setWorking(value: boolean): void;
};
export default function DealsPanel({
  session,
  memberId,
  scope,
  online,
  working,
  leads,
  sources,
  leadLabel,
  runCommand,
  onDirty,
  setWorking,
}: Props) {
  const [deals, setDeals] = useState<Schema<"Deal">[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [options, setOptions] = useState(leads);
  const [leadCursor, setLeadCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [intentFilter, setIntentFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [selected, setSelected] = useState<Schema<"Deal"> | null>(null);
  const [name, setName] = useState("");
  const [leadId, setLeadId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [state, setState] = useState<Schema<"Deal">["state"]>("open");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const lifetime = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const base = `/v1/orgs/${session.activeOrgId}`;
  const canWrite = ["crm.deals.write", "crm.leads.read", "crm.leads.write"].every((permission) =>
    session.permissions.includes(permission),
  );
  const filterObj: Schema<"LeadFilter"> = {
    ...(scope === "own" && memberId ? { ownerMemberId: memberId } : {}),
    ...(intentFilter ? { intent: intentFilter as Schema<"LeadFilter">["intent"] } : {}),
    ...(sourceFilter ? { sourceId: sourceFilter } : {}),
  };
  const filter = Object.keys(filterObj).length
    ? `&filter=${encodeURIComponent(JSON.stringify(filterObj))}`
    : "";
  const clearPrivate = useCallback(() => {
    setDeals([]);
    setOptions([]);
    setCursor(null);
    setLeadCursor(null);
    setLoaded(false);
    setSelected(null);
    setEditing(false);
    setName("");
    setLeadId("");
    setAmount("");
    setDirty(false);
  }, []);
  const load = useCallback(
    async (next?: string) => {
      if (!online || !session.activeOrgId || (scope === "own" && !memberId)) return;
      const generation = ++epoch.current;
      setLoading(true);
      setError("");
      try {
        const result = await api<Schema<"PageDeal">>(
          `${base}/deals?limit=25${filter}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (generation !== epoch.current) return;
        setDeals((current) => (next ? [...current, ...result.data.items] : result.data.items));
        setCursor(result.data.nextCursor);
        setLoaded(true);
      } catch (err) {
        if (generation === epoch.current) {
          setDeals([]);
          setLoaded(false);
          setCursor(null);
          setError(err instanceof Error ? err.message : "Deals unavailable.");
          if (err instanceof ApiError && [401, 403].includes(err.status)) {
            clearPrivate();
          }
        }
      } finally {
        if (generation === epoch.current) setLoading(false);
      }
    },
    [online, session.activeOrgId, scope, memberId, base, filter, clearPrivate],
  );
  useEffect(() => {
    void load();
    return () => {
      ++epoch.current;
    };
  }, [load]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(
    () => () => {
      ++lifetime.current;
      onDirty(false);
    },
    [onDirty],
  );
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing, selected]);
  useEffect(() => {
    setOptions(leads);
    setLeadCursor(null);
  }, [leads]);
  async function moreLeads() {
    if (!online || working) return;
    setWorking(true);
    setError("");
    const generation = lifetime.current;
    try {
      const result = await api<Schema<"PageLead">>(
        `${base}/leads?limit=25${filter}${leadCursor ? `&cursor=${encodeURIComponent(leadCursor)}` : ""}`,
      );
      if (generation !== lifetime.current) return;
      setOptions((current) => [
        ...new Map([...current, ...result.data.items].map((lead) => [lead.id, lead])).values(),
      ]);
      setLeadCursor(result.data.nextCursor);
    } catch (err) {
      if (generation === lifetime.current) {
        setError(err instanceof Error ? err.message : "Lead choices unavailable.");
        if (err instanceof ApiError && [401, 403].includes(err.status)) clearPrivate();
      }
    } finally {
      setWorking(false);
    }
  }
  function applyEditor(record: Schema<"Deal"> | null) {
    setSelected(record);
    setEditing(true);
    setName(record?.name || "");
    setLeadId(record?.leadId || "");
    setAmount(record?.amount == null ? "" : String(record.amount));
    setCurrency(record?.currency || "USD");
    setState(record?.state || "open");
    setDirty(false);
    setError("");
    setNotice("");
  }
  function openEditor(record: Schema<"Deal"> | null) {
    if (working || (dirty && !window.confirm("Discard this unsaved deal?"))) return;
    applyEditor(record);
  }
  async function reload() {
    if (
      !selected ||
      working ||
      !online ||
      (dirty && !window.confirm("Discard this draft and reload the latest deal version?"))
    )
      return;
    setWorking(true);
    const generation = lifetime.current;
    try {
      const result = await api<Schema<"Deal">>(`${base}/deals/${selected.id}`);
      if (generation === lifetime.current) applyEditor(result.data);
    } catch (err) {
      if (generation === lifetime.current) failure(err);
    } finally {
      setWorking(false);
    }
  }
  function failure(err: unknown) {
    setError(
      err instanceof ApiError && err.status === 412
        ? "This deal changed. Your draft is preserved; discard and reload the server version before saving again."
        : err instanceof Error
          ? err.message
          : "Deal command could not be reconciled. Retry with the same input.",
    );
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
      setEditing(false);
      setDirty(false);
      if (err.status !== 404) clearPrivate();
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online || working || !canWrite) return;
    setWorking(true);
    setError("");
    const generation = lifetime.current;
    try {
      const body: Schema<"DealWrite"> = {
        leadId,
        name: name.trim(),
        amount: amount.trim() ? Number(amount) : null,
        currency: currency.trim().toUpperCase(),
        state,
      };
      await runCommand<Schema<"Deal">>(
        `${base}/deals${selected ? `/${selected.id}` : ""}`,
        body,
        selected ? "PATCH" : "POST",
        selected?.version,
      );
      if (generation !== lifetime.current) return;
      setEditing(false);
      setDirty(false);
      setNotice("Deal saved. Deal state and lead pipeline stage remain separate records.");
      await load();
    } catch (err) {
      if (generation === lifetime.current) failure(err);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="deals-section" aria-label="Scoped deals">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">DEALS</span>
          <h2>Follow each opportunity through.</h2>
          <p className="section-description">
            Deal amounts and outcomes are explicit records linked to an authorized lead. Unknown amounts
            remain unknown.
          </p>
        </div>
        <div className="heading-actions">
          <Button
            variant="secondary"
            disabled={working || loading || dirty || !online}
            onClick={() => void load()}
          >
            <RefreshCw size={16} />
            Refresh deals
          </Button>
          {canWrite && (
            <Button disabled={working || !online} onClick={() => openEditor(null)}>
              <Plus size={17} />
              Add deal
            </Button>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "8px 0 12px" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600 }}>
          Lead intent
          <select value={intentFilter} onChange={(e) => { setIntentFilter(e.target.value); }}>
            <option value="">All</option>
            <option value="buyer">Buyer</option>
            <option value="seller">Seller</option>
            <option value="both">Both</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        {sources.length > 0 && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600 }}>
            Lead source
            <select value={sourceFilter} onChange={(e) => { setSourceFilter(e.target.value); }}>
              <option value="">All sources</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>{source.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      {editing && (
        <section className="panel settings-card workspace-record-editor">
          <h3>{selected ? "Edit deal" : "Create deal"}</h3>
          <form className="settings-form" onSubmit={save} onChange={() => setDirty(true)}>
            <fieldset disabled={working || !online}>
              <label>
                Deal name
                <input
                  ref={input}
                  required
                  maxLength={160}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Linked lead
                <select
                  value={leadId}
                  required
                  disabled={Boolean(selected)}
                  onChange={(event) => setLeadId(event.target.value)}
                >
                  <option value="" disabled>
                    Select an authorized lead
                  </option>
                  {leadId && !options.some((lead) => lead.id === leadId) && (
                    <option value={leadId}>
                      Selected lead · {leadId.slice(0, 8)} · Availability unverified
                    </option>
                  )}
                  {options.map((lead) => (
                    <option key={lead.id} value={lead.id}>
                      {leadLabel(lead)} · {lead.intent}
                    </option>
                  ))}
                </select>
              </label>
              {!selected && (
                <Button type="button" variant="secondary" onClick={() => void moreLeads()}>
                  {leadCursor ? "Load more deal leads" : "Refresh deal lead choices"}
                </Button>
              )}
              <div className="form-columns">
                <label>
                  Deal amount (optional)
                  <input
                    type="number"
                    min="0"
                    max="999999999999.99"
                    step="0.01"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="Unknown"
                  />
                </label>
                <label>
                  Deal currency
                  <input
                    required
                    pattern="[A-Za-z]{3}"
                    maxLength={3}
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value)}
                    title="Three-letter currency code, such as USD"
                  />
                </label>
              </div>
              <label>
                Deal outcome
                <select
                  value={state}
                  onChange={(event) => setState(event.target.value as Schema<"Deal">["state"])}
                >
                  <option value="open">Open</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                </select>
              </label>
              <p className="muted">
                {selected
                  ? `Version ${selected.version} · The linked lead cannot change.`
                  : "The server checks both deal and linked-lead permissions."}{" "}
                Setting won or lost does not change a lead’s stage or record revenue automatically. Close-date
                editing is unavailable in the current write contract.
              </p>
              <div className="form-actions">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    if (!dirty || window.confirm("Discard this unsaved deal?")) {
                      setEditing(false);
                      setDirty(false);
                    }
                  }}
                >
                  Cancel deal edit
                </Button>
                {selected && (
                  <Button variant="secondary" type="button" onClick={() => void reload()}>
                    Discard and reload deal
                  </Button>
                )}
                <Button type="submit" disabled={!dirty || working || !online || !leadId}>
                  Save deal
                </Button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
      <section className="panel deal-list">
        <div className="panel-heading">
          <h2>
            <BriefcaseBusiness size={20} />
            Deals in the current workspace scope
          </h2>
          <Badge>{loading ? "Loading…" : loaded ? `${deals.length} loaded` : "Unavailable"}</Badge>
        </div>
        {deals.length ? (
          <div className="workspace-record-rows">
            {deals.map((deal) => (
              <article key={deal.id}>
                <div>
                  <h3>{deal.name}</h3>
                  <p>
                    {deal.amount == null
                      ? "Amount unknown"
                      : new Intl.NumberFormat("en-US", { style: "currency", currency: deal.currency }).format(
                          deal.amount,
                        )}{" "}
                    · {deal.currency}
                  </p>
                  <span>
                    Linked lead {deal.leadId.slice(0, 8)} · Version {deal.version}
                    {deal.expectedCloseDate
                      ? ` · Expected close ${deal.expectedCloseDate}`
                      : " · Close date unknown"}
                  </span>
                </div>
                <Badge tone={deal.state === "won" ? "positive" : "neutral"}>{deal.state}</Badge>
                {canWrite && (
                  <Button variant="secondary" disabled={working || !online} onClick={() => openEditor(deal)}>
                    Edit deal
                  </Button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <Empty
            icon={<BriefcaseBusiness size={30} />}
            title={loading ? "Loading deals" : loaded ? "No deals in this scope yet" : "Deals unavailable"}
          >
            A deal is separate from its lead and is never inferred from a pipeline stage.
          </Empty>
        )}
        {cursor && (
          <div className="panel-footer">
            <Button
              variant="secondary"
              disabled={working || loading || dirty || !online}
              onClick={() => void load(cursor)}
            >
              Load more deals
            </Button>
          </div>
        )}
      </section>
    </section>
  );
}
