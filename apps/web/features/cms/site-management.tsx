"use client";

import { Globe, ImageIcon, LayoutList, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button } from "../../../../packages/ui/components";
import { api, ApiError } from "../../lib/api";
import type { Schema } from "../../lib/api";
import styles from "../../components/cms-workspace.module.css";

type Tab = "domains" | "media" | "forms";

function uncertain(error: unknown) {
  return !(error instanceof ApiError) || error.status >= 500 || error.status === 408;
}
function fail(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred.";
}

export function CmsSiteManagement({
  siteId,
  base,
  csrf,
  online,
  canManageDomains,
  canWriteMedia,
  canWriteForms,
}: {
  siteId: string;
  base: string;
  csrf: string;
  online: boolean;
  canManageDomains: boolean;
  canWriteMedia: boolean;
  canWriteForms: boolean;
}) {
  const allTabs: { id: Tab; label: string; icon: React.ReactNode; enabled: boolean }[] = [
    { id: "domains" as Tab, label: "Domains", icon: <Globe size={16} />, enabled: canManageDomains },
    { id: "media" as Tab, label: "Media", icon: <ImageIcon size={16} />, enabled: canWriteMedia },
    { id: "forms" as Tab, label: "Forms", icon: <LayoutList size={16} />, enabled: canWriteForms },
  ];
  const tabs = allTabs.filter((t) => t.enabled);

  const [activeTab, setActiveTab] = useState<Tab>(() => tabs[0]?.id ?? "domains");

  if (!tabs.length) return null;

  const tab = tabs.find((t) => t.id === activeTab) ?? tabs[0];

  return (
    <section className={styles.card} aria-labelledby="site-management-title">
      <div className={styles.heading}>
        <h3 id="site-management-title">Site management</h3>
        <div role="tablist" aria-label="Management sections" style={{ display: "flex", gap: 8 }}>
          {tabs.map((t) => (
            <Button
              key={t.id}
              variant={tab.id === t.id ? "primary" : "secondary"}
              role="tab"
              aria-selected={tab.id === t.id}
              aria-controls={`tabpanel-${t.id}`}
              id={`tab-${t.id}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.icon} {t.label}
            </Button>
          ))}
        </div>
      </div>
      <div
        id={`tabpanel-${tab.id}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab.id}`}
        style={{ minWidth: 0 }}
      >
        {tab.id === "domains" && (
          <DomainsPanel siteId={siteId} base={base} csrf={csrf} online={online} />
        )}
        {tab.id === "media" && <MediaPanel base={base} csrf={csrf} online={online} />}
        {tab.id === "forms" && (
          <FormsPanel siteId={siteId} base={base} csrf={csrf} online={online} />
        )}
      </div>
    </section>
  );
}

function DomainsPanel({
  siteId,
  base,
  csrf,
  online,
}: {
  siteId: string;
  base: string;
  csrf: string;
  online: boolean;
}) {
  const [domains, setDomains] = useState<Schema<"Domain">[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [addHostname, setAddHostname] = useState("");
  const [addEnv, setAddEnv] = useState<"preview" | "production">("preview");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [addUnknown, setAddUnknown] = useState(false);
  const keyRef = useRef<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<Schema<"PageDomain">>(`${base}/sites/${siteId}/domains`);
      setDomains(result.data.items);
    } catch (e) {
      setError(fail(e));
    } finally {
      setLoading(false);
    }
  }, [base, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addDomain(e: React.FormEvent) {
    e.preventDefault();
    const hostname = addHostname.trim().toLowerCase();
    if (!hostname) {
      setAddError("Enter a hostname.");
      return;
    }
    if (!keyRef.current || addUnknown) keyRef.current = crypto.randomUUID();
    setAdding(true);
    setAddError("");
    setAddUnknown(false);
    setNotice("");
    try {
      const result = await api<Schema<"Domain">>(`${base}/sites/${siteId}/domains`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "Idempotency-Key": keyRef.current,
        },
        body: JSON.stringify({ hostname, environment: addEnv } satisfies Schema<"DomainWrite">),
      });
      setNotice(
        `Domain ${result.data.id} (${result.data.hostname}) added. Verification state: ${result.data.verificationState}.`,
      );
      setAddHostname("");
      keyRef.current = "";
      await load();
    } catch (e) {
      setAddUnknown(uncertain(e));
      setAddError(fail(e));
    } finally {
      setAdding(false);
    }
  }

  async function verifyDomain(id: string) {
    const key = crypto.randomUUID();
    setNotice("");
    setError("");
    try {
      await api<Schema<"Domain">>(`${base}/domains/${id}/verify`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key },
      });
      setNotice(`Verification requested for domain ${id}.`);
      await load();
    } catch (e) {
      setError(fail(e));
    }
  }

  async function archiveDomain(id: string) {
    const key = crypto.randomUUID();
    setNotice("");
    setError("");
    try {
      await api<Schema<"Domain">>(`${base}/domains/${id}/archive`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrf, "Idempotency-Key": key },
      });
      setNotice(`Domain ${id} archived.`);
      await load();
    } catch (e) {
      setError(fail(e));
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.success} role="status">
          {notice}
        </p>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <p style={{ margin: 0 }}>
          {loading ? "Reading domains…" : `${domains.length} active domain${domains.length === 1 ? "" : "s"}`}
        </p>
        <Button variant="secondary" disabled={!online || loading} onClick={() => void load()}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
      {domains.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Hostname</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Env</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Verify</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>TLS</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {domains.map((d) => (
              <tr key={d.id}>
                <td style={{ padding: "4px 8px", fontFamily: "monospace", fontSize: 13 }}>{d.hostname}</td>
                <td style={{ padding: "4px 8px" }}>
                  <Badge tone={d.environment === "production" ? "positive" : "neutral"}>{d.environment}</Badge>
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <Badge tone={d.verificationState === "verified" ? "positive" : d.verificationState === "failed" ? "warning" : "neutral"}>
                    {d.verificationState}
                  </Badge>
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <Badge tone={d.tlsState === "active" ? "positive" : d.tlsState === "failed" ? "warning" : "neutral"}>
                    {d.tlsState}
                  </Badge>
                </td>
                <td style={{ padding: "4px 8px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {d.verificationState === "pending" && (
                    <Button variant="quiet" disabled={!online} onClick={() => void verifyDomain(d.id)}>
                      Verify
                    </Button>
                  )}
                  <Button variant="quiet" disabled={!online} onClick={() => void archiveDomain(d.id)}>
                    Archive
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {domains.some((d) => d.requiredDns.length > 0) && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 14 }}>Required DNS records</summary>
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {domains
              .filter((d) => d.requiredDns.length > 0)
              .flatMap((d) =>
                d.requiredDns.map((rec, i) => (
                  <div key={`${d.id}-${i}`} style={{ fontFamily: "monospace", fontSize: 13, background: "var(--color-surface-raised, #f5f5f5)", padding: "8px 12px", borderRadius: 6 }}>
                    <strong>{rec.type}</strong> {rec.name} → {rec.value}
                  </div>
                )),
              )}
          </div>
        </details>
      )}
      <form onSubmit={(e) => void addDomain(e)} style={{ display: "grid", gap: 12 }}>
        <fieldset disabled={!online || adding}>
          <legend style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Add domain</legend>
          <div className={styles.fields}>
            <label>
              Hostname
              <input
                type="text"
                value={addHostname}
                onChange={(e) => setAddHostname(e.target.value)}
                placeholder="example.com"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label>
              Environment
              <select value={addEnv} onChange={(e) => setAddEnv(e.target.value as "preview" | "production")}>
                <option value="preview">Preview</option>
                <option value="production">Production</option>
              </select>
            </label>
          </div>
          {addError && (
            <p className={styles.error} role="alert">
              {addError}
              {addUnknown && " Retry with the same key is safe."}
            </p>
          )}
          <Button type="submit" disabled={!online || adding || !addHostname.trim()}>
            {adding ? "Adding…" : "Add domain"}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}

function MediaPanel({
  base,
  csrf,
  online,
}: {
  base: string;
  csrf: string;
  online: boolean;
}) {
  const [assets, setAssets] = useState<Schema<"Media">[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [finalizeId, setFinalizeId] = useState("");
  const [finalizeChecksum, setFinalizeChecksum] = useState("");
  const [finalizeAlt, setFinalizeAlt] = useState("");
  const [finalizeRights, setFinalizeRights] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState("");
  const [finalizeUnknown, setFinalizeUnknown] = useState(false);
  const keyRef = useRef<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<Schema<"PageMedia">>(`${base}/media?limit=20`);
      setAssets(result.data.items);
    } catch (e) {
      setError(fail(e));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function finalizeAsset(e: React.FormEvent) {
    e.preventDefault();
    const id = finalizeId.trim();
    const checksum = finalizeChecksum.trim();
    if (!id || !checksum) {
      setFinalizeError("Asset ID and checksum are required.");
      return;
    }
    if (!finalizeRights) {
      setFinalizeError("Rights attestation is required.");
      return;
    }
    if (!keyRef.current || finalizeUnknown) keyRef.current = crypto.randomUUID();
    setFinalizing(true);
    setFinalizeError("");
    setFinalizeUnknown(false);
    setNotice("");
    try {
      const body: Schema<"MediaFinalize"> = {
        assetId: id,
        checksum,
        rightsAttestation: true,
      };
      if (finalizeAlt.trim()) body.altText = finalizeAlt.trim();
      await api<Schema<"Media">>(`${base}/media/finalize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "Idempotency-Key": keyRef.current,
        },
        body: JSON.stringify(body),
      });
      setNotice(`Asset ${id} finalized.`);
      setFinalizeId("");
      setFinalizeChecksum("");
      setFinalizeAlt("");
      setFinalizeRights(false);
      keyRef.current = "";
      await load();
    } catch (e) {
      setFinalizeUnknown(uncertain(e));
      setFinalizeError(fail(e));
    } finally {
      setFinalizing(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.success} role="status">
          {notice}
        </p>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <p style={{ margin: 0 }}>
          {loading ? "Reading media…" : `${assets.length} asset${assets.length === 1 ? "" : "s"} (first 20)`}
        </p>
        <Button variant="secondary" disabled={!online || loading} onClick={() => void load()}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
      {assets.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>ID</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Type</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Size</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Scan</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Alt text</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id}>
                <td style={{ padding: "4px 8px", fontFamily: "monospace", fontSize: 11 }}>{a.id}</td>
                <td style={{ padding: "4px 8px", fontSize: 13 }}>{a.mimeType}</td>
                <td style={{ padding: "4px 8px", fontSize: 13 }}>{(a.bytes / 1024).toFixed(1)} KB</td>
                <td style={{ padding: "4px 8px" }}>
                  <Badge tone={a.scanState === "clean" ? "positive" : a.scanState === "rejected" ? "warning" : "neutral"}>
                    {a.scanState}
                  </Badge>
                </td>
                <td style={{ padding: "4px 8px", fontSize: 13 }}>{a.altText ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={(e) => void finalizeAsset(e)} style={{ display: "grid", gap: 12 }}>
        <fieldset disabled={!online || finalizing}>
          <legend style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Finalize pending asset</legend>
          <p style={{ fontSize: 13, margin: "0 0 8px" }}>
            After a signed upload, supply the asset ID, its SHA-256 checksum, and optional alt text to mark it as clean.
          </p>
          <div className={styles.fields}>
            <label>
              Asset ID
              <input
                type="text"
                value={finalizeId}
                onChange={(e) => setFinalizeId(e.target.value)}
                placeholder="UUID"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              SHA-256 checksum
              <input
                type="text"
                value={finalizeChecksum}
                onChange={(e) => setFinalizeChecksum(e.target.value)}
                placeholder="hex"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              Alt text (optional)
              <input
                type="text"
                value={finalizeAlt}
                onChange={(e) => setFinalizeAlt(e.target.value)}
                placeholder="Describe the image"
              />
            </label>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <input
              type="checkbox"
              checked={finalizeRights}
              onChange={(e) => setFinalizeRights(e.target.checked)}
            />
            I own or have rights to use this media
          </label>
          {finalizeError && (
            <p className={styles.error} role="alert">
              {finalizeError}
              {finalizeUnknown && " Retry with the same key is safe."}
            </p>
          )}
          <Button
            type="submit"
            disabled={!online || finalizing || !finalizeId.trim() || !finalizeChecksum.trim() || !finalizeRights}
          >
            {finalizing ? "Finalizing…" : "Finalize asset"}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}

function FormsPanel({
  siteId,
  base,
  csrf,
  online,
}: {
  siteId: string;
  base: string;
  csrf: string;
  online: boolean;
}) {
  const [forms, setForms] = useState<Schema<"Form">[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<Schema<"PageForm">>(`${base}/sites/${siteId}/forms`);
      setForms(result.data.items);
    } catch (e) {
      setError(fail(e));
    } finally {
      setLoading(false);
    }
  }, [base, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.success} role="status">
          {notice}
        </p>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <p style={{ margin: 0 }}>
          {loading ? "Reading forms…" : `${forms.length} form${forms.length === 1 ? "" : "s"}`}
        </p>
        <Button variant="secondary" disabled={!online || loading} onClick={() => void load()}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>
      {forms.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Name</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Version</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>State</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Fields</th>
            </tr>
          </thead>
          <tbody>
            {forms.map((f) => (
              <tr key={f.id}>
                <td style={{ padding: "4px 8px" }}>{f.name}</td>
                <td style={{ padding: "4px 8px" }}>{f.version}</td>
                <td style={{ padding: "4px 8px" }}>
                  <Badge tone={f.state === "published" ? "positive" : "neutral"}>{f.state}</Badge>
                </td>
                <td style={{ padding: "4px 8px" }}>{f.fields.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && forms.length === 0 && (
        <p style={{ fontSize: 14 }}>
          No forms yet. Create forms through the API or a future form designer.
        </p>
      )}
      <p style={{ fontSize: 13, color: "var(--color-ink-secondary, #666)", margin: 0 }}>
        Form creation and the full designer are available through the API. This panel shows the current form catalogue.
      </p>
    </div>
  );
}
