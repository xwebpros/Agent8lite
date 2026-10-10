"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LifeBuoy, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api } from "../lib/api";
import type { Schema } from "../lib/api";

type Props = {
  session: Schema<"Session">;
  online: boolean;
  working: boolean;
  ticketId: string | null;
  runCommand: <T>(path: string, body: unknown, method?: string, version?: number) => Promise<T>;
  onDirty(value: boolean): void;
  setWorking(value: boolean): void;
};
export default function SupportPanel({
  session,
  online,
  working,
  ticketId,
  runCommand,
  onDirty,
  setWorking,
}: Props) {
  const router = useRouter();
  const [tickets, setTickets] = useState<Schema<"Ticket">[]>([]);
  const [selected, setSelected] = useState<Schema<"Ticket"> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshed, setRefreshed] = useState<string | null>(null);
  const epoch = useRef(0);
  const detailEpoch = useRef(0);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const canRead = session.permissions.includes("support.read");
  const canWrite = session.permissions.includes("support.write");
  const base = `/v1/orgs/${session.activeOrgId}/tickets`;
  const load = useCallback(
    async (next?: string) => {
      if (!canRead || !session.activeOrgId) return;
      const generation = ++epoch.current;
      setLoading(true);
      setError("");
      try {
        const result = await api<Schema<"PageTicket">>(
          `/v1/orgs/${session.activeOrgId}/tickets?limit=25${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (generation !== epoch.current) return;
        setTickets((current) => (next ? [...current, ...result.data.items] : result.data.items));
        setCursor(result.data.nextCursor);
        setRefreshed(new Date().toISOString());
      } catch (err) {
        if (generation !== epoch.current) return;
        setTickets([]);
        setCursor(null);
        setRefreshed(null);
        setError(err instanceof Error ? err.message : "Support tickets unavailable.");
      } finally {
        if (generation === epoch.current) setLoading(false);
      }
    },
    [session.activeOrgId, canRead],
  );
  useEffect(() => {
    if (online) void load();
    return () => {
      ++epoch.current;
    };
  }, [load, online]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (!ticketId || !session.activeOrgId || !canRead) return;
    if (detailDialog.current && !detailDialog.current.open) detailDialog.current.showModal();
    const generation = ++detailEpoch.current;
    setSelected(null);
    setDetailLoading(true);
    setDetailError("");
    void api<Schema<"Ticket">>(`/v1/orgs/${session.activeOrgId}/tickets/${encodeURIComponent(ticketId)}`)
      .then((result) => {
        if (generation === detailEpoch.current) setSelected(result.data);
      })
      .catch((err) => {
        if (generation === detailEpoch.current)
          setDetailError(err instanceof Error ? err.message : "Ticket unavailable.");
      })
      .finally(() => {
        if (generation === detailEpoch.current) setDetailLoading(false);
      });
    return () => {
      ++detailEpoch.current;
    };
  }, [ticketId, session.activeOrgId, canRead]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const input: Schema<"TicketWrite"> = {
        subject: String(fields.get("subject")).trim(),
        category: String(fields.get("category")) as Schema<"Ticket">["category"],
        description: String(fields.get("description")).trim(),
      };
      const result = await runCommand<Schema<"Ticket">>(base, input);
      form.current?.reset();
      setCreating(false);
      setDirty(false);
      setNotice("Ticket saved to your organization. No external helpdesk message was sent.");
      await load();
      if (canRead) router.push(`/settings?panel=support&ticket=${result.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Ticket could not be saved. Your draft remains in this tab.",
      );
    } finally {
      setWorking(false);
    }
  }
  function cancel() {
    if (working || (dirty && !window.confirm("Discard the unsaved support request?"))) return;
    setCreating(false);
    setDirty(false);
    form.current?.reset();
  }
  return (
    <section className="support-section" aria-label="Support requests">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">SUPPORT</span>
          <h2>Let’s work through it.</h2>
          <p className="section-description">
            Your requests stay scoped to your membership and active organization.
          </p>
        </div>
        <div className="heading-actions">
          <Button
            variant="secondary"
            disabled={loading || working || !online || !canRead}
            onClick={() => void load()}
          >
            <RefreshCw size={16} />
            Refresh tickets
          </Button>
          {canWrite && (
            <Button
              disabled={working || !online || creating}
              onClick={() => {
                setCreating(true);
                setError("");
                setNotice("");
              }}
            >
              <Plus size={16} />
              New support request
            </Button>
          )}
        </div>
      </div>
      <div className="synthetic-note">
        <ShieldCheck size={20} />
        <div>
          <strong>Synthetic local support</strong>
          <span>
            Requests are stored in the local application. No email, helpdesk delivery or staff response is
            simulated. Attachments are deferred.
          </span>
        </div>
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
      {creating && (
        <section className="panel settings-card support-create">
          <h3>New support request</h3>
          <form ref={form} className="settings-form" onSubmit={save} onChange={() => setDirty(true)}>
            <label>
              Subject
              <input
                name="subject"
                disabled={working}
                required
                maxLength={200}
                placeholder="A short description of what you need"
              />
            </label>
            <label>
              Category
              <select name="category" defaultValue="general" disabled={working}>
                <option value="general">General</option>
                <option value="technical">Technical</option>
                <option value="billing">Billing</option>
                <option value="feature">Feature request</option>
                <option value="access">Account access</option>
              </select>
            </label>
            <label>
              Description
              <textarea
                name="description"
                disabled={working}
                required
                maxLength={10000}
                rows={7}
                placeholder="Describe what happened, what you expected and any steps that help reproduce it. Don’t include passwords or secrets."
              />
            </label>
            <div className="form-actions">
              <Button variant="secondary" type="button" disabled={working} onClick={cancel}>
                Cancel request
              </Button>
              <Button type="submit" disabled={working || !online}>
                {working ? "Saving…" : "Save support request"}
              </Button>
            </div>
          </form>
        </section>
      )}
      <section className="panel ticket-panel">
        <div className="panel-heading">
          <h2>
            <LifeBuoy size={19} />
            Your support requests
          </h2>
          <Badge>{loading ? "Loading…" : `${tickets.length} loaded`}</Badge>
        </div>
        {tickets.length ? (
          <div className="ticket-list">
            {tickets.map((ticket) => (
              <Link
                className="ticket-row"
                key={ticket.id}
                href={`/settings?panel=support&ticket=${ticket.id}`}
                onClick={(event) => {
                  if (dirty || working) {
                    event.preventDefault();
                    setError("Save or discard your support draft before opening another ticket.");
                  }
                }}
              >
                <div>
                  <strong>{ticket.subject}</strong>
                  <span>
                    {ticket.category} · Version {ticket.version}
                  </span>
                </div>
                <Badge tone={ticket.state === "resolved" ? "positive" : "neutral"}>{ticket.state}</Badge>
              </Link>
            ))}
          </div>
        ) : (
          <Empty
            icon={<LifeBuoy size={30} />}
            title={
              loading
                ? "Loading your requests"
                : refreshed
                  ? "No support requests yet"
                  : "Requests unavailable"
            }
          >
            {refreshed
              ? "Create a request when you need help with this workspace."
              : "Connect and refresh to read requests permitted for your membership."}
          </Empty>
        )}
        {cursor && (
          <div className="pagination">
            <Button
              variant="secondary"
              disabled={loading || working || !online}
              onClick={() => void load(cursor)}
            >
              Load more requests
            </Button>
          </div>
        )}
        <p className="panel-footer muted">
          {refreshed
            ? "List read from the support API. Ticket event timelines are not available in this contract slice."
            : "No measured list refresh available."}
        </p>
      </section>
      {ticketId && canRead && (
        <dialog
          ref={detailDialog}
          className="editor-dialog ticket-dialog"
          aria-labelledby="ticket-title"
          onCancel={(event) => {
            event.preventDefault();
            router.push("/settings?panel=support");
          }}
        >
          <div className="editor-header">
            <div>
              <span className="eyebrow">SUPPORT REQUEST</span>
              <h2 id="ticket-title">{selected?.subject || "Request details"}</h2>
            </div>
            <button
              className="icon-button"
              aria-label="Close support request"
              onClick={() => router.push("/settings?panel=support")}
            >
              <X size={20} />
            </button>
          </div>
          <div className="editor-body">
            {detailLoading && <p>Loading authorized request…</p>}
            {detailError && (
              <div className="error" role="alert">
                {detailError}
              </div>
            )}
            {selected && (
              <>
                <div className="ticket-detail-badges">
                  <Badge>{selected.category}</Badge>
                  <Badge tone={selected.state === "resolved" ? "positive" : "neutral"}>
                    {selected.state}
                  </Badge>
                  <span className="muted">Version {selected.version}</span>
                </div>
                <p className="ticket-description">{selected.description}</p>
                <p className="muted">
                  No external helpdesk delivery is enabled. A saved ticket does not indicate a staff reply or
                  resolution.
                </p>
              </>
            )}
          </div>
          <div className="editor-footer">
            <Button variant="secondary" onClick={() => router.push("/settings?panel=support")}>
              Close request
            </Button>
          </div>
        </dialog>
      )}
    </section>
  );
}
