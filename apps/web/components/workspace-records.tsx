"use client";

import { Building2, Paintbrush, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";

type Editor =
  | { kind: "offices"; record: Schema<"Office"> | null }
  | { kind: "business-profiles"; record: Schema<"BusinessProfile"> | null };
type Props = {
  session: Schema<"Session">;
  online: boolean;
  working: boolean;
  runCommand: <T>(path: string, body: unknown, method?: string, version?: number) => Promise<T>;
  onDirty(value: boolean): void;
  setWorking(value: boolean): void;
};
export default function WorkspaceRecords({
  session,
  online,
  working,
  runCommand,
  onDirty,
  setWorking,
}: Props) {
  const [offices, setOffices] = useState<Schema<"Office">[]>([]);
  const [profiles, setProfiles] = useState<Schema<"BusinessProfile">[]>([]);
  const [officeCursor, setOfficeCursor] = useState<string | null>(null);
  const [profileCursor, setProfileCursor] = useState<string | null>(null);
  const [officeLoaded, setOfficeLoaded] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#2459B8");
  const [fontToken, setFontToken] = useState<"sans" | "serif">("sans");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const lifetime = useRef(0);
  const editorInput = useRef<HTMLInputElement>(null);
  const officeRead = session.permissions.includes("offices.read");
  const profileRead = session.permissions.includes("profiles.read");
  const officeWrite = session.permissions.includes("offices.write");
  const profileWrite = session.permissions.includes("profiles.write");
  const base = `/v1/orgs/${session.activeOrgId}`;
  const organization = session.organizations.find((org) => org.id === session.activeOrgId);
  const load = useCallback(
    async (resource?: "offices" | "business-profiles", cursor?: string) => {
      if (!session.activeOrgId || !online) return;
      const generation = ++epoch.current;
      setLoading(true);
      setError("");
      const responses = await Promise.allSettled([
        officeRead && (!resource || resource === "offices")
          ? api<Schema<"PageOffice">>(
              `${base}/offices?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            )
          : Promise.resolve(null),
        profileRead && (!resource || resource === "business-profiles")
          ? api<Schema<"PageBusinessProfile">>(
              `${base}/business-profiles?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            )
          : Promise.resolve(null),
      ]);
      if (generation !== epoch.current) return;
      const [officePage, profilePage] = responses;
      if (officePage.status === "fulfilled" && officePage.value) {
        setOffices((current) =>
          cursor
            ? [...current, ...(officePage.value!.data.items as Schema<"Office">[])]
            : (officePage.value!.data.items as Schema<"Office">[]),
        );
        setOfficeCursor(officePage.value.data.nextCursor);
        setOfficeLoaded(true);
      } else if (officePage.status === "rejected") {
        setOffices([]);
        setOfficeCursor(null);
        setOfficeLoaded(false);
      }
      if (profilePage.status === "fulfilled" && profilePage.value) {
        setProfiles((current) =>
          cursor
            ? [...current, ...(profilePage.value!.data.items as Schema<"BusinessProfile">[])]
            : (profilePage.value!.data.items as Schema<"BusinessProfile">[]),
        );
        setProfileCursor(profilePage.value.data.nextCursor);
        setProfileLoaded(true);
      } else if (profilePage.status === "rejected") {
        setProfiles([]);
        setProfileCursor(null);
        setProfileLoaded(false);
      }
      const failed = responses.find((item) => item.status === "rejected");
      if (failed?.status === "rejected") {
        setError(
          failed.reason instanceof Error ? failed.reason.message : "Some workspace records are unavailable.",
        );
        if (failed.reason instanceof ApiError && [401, 403].includes(failed.reason.status)) {
          setEditor(null);
          setDirty(false);
        }
      }
      setLoading(false);
    },
    [session.activeOrgId, online, officeRead, profileRead, base],
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
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(
    () => () => {
      ++lifetime.current;
    },
    [],
  );
  useEffect(() => {
    if (editor) editorInput.current?.focus();
  }, [editor]);
  function openEditor(next: Editor) {
    if (working || (dirty && !window.confirm("Discard this unsaved workspace record and open another?")))
      return;
    applyEditor(next);
  }
  function applyEditor(next: Editor) {
    setEditor(next);
    setName(next.record?.name || "");
    setDirty(false);
    setError("");
    setNotice("");
    if (next.kind === "offices")
      setTimezone(next.record?.timezone || organization?.timezone || "America/Los_Angeles");
    else {
      setWebsiteUrl(next.record?.websiteUrl || "");
      setPrimaryColor(next.record?.brand.primaryColor || "#2459B8");
      setFontToken(next.record?.brand.fontToken || "sans");
    }
  }
  function closeEditor() {
    if (working || (dirty && !window.confirm("Discard this unsaved workspace record?"))) return;
    setEditor(null);
    setDirty(false);
    setError("");
  }
  async function reloadEditor() {
    if (
      !editor ||
      working ||
      !online ||
      (dirty && !window.confirm("Discard this draft and reload the latest server version?"))
    )
      return;
    if (!editor.record) {
      openEditor({ ...editor, record: null });
      return;
    }
    const generation = lifetime.current;
    setWorking(true);
    setError("");
    try {
      if (editor.kind === "offices") {
        const result = await api<Schema<"Office">>(`${base}/offices/${editor.record.id}`);
        if (generation === lifetime.current) applyEditor({ kind: "offices", record: result.data });
      } else {
        const result = await api<Schema<"BusinessProfile">>(`${base}/business-profiles/${editor.record.id}`);
        if (generation === lifetime.current) applyEditor({ kind: "business-profiles", record: result.data });
      }
    } catch (err) {
      if (generation === lifetime.current) failure(err);
    } finally {
      setWorking(false);
    }
  }
  function failure(err: unknown) {
    setError(
      err instanceof ApiError && err.status === 412
        ? "This record changed on the server. Your draft is preserved. Use Discard and reload version before submitting again."
        : err instanceof Error
          ? err.message
          : "The command could not be reconciled. Retry the same input.",
    );
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
      setEditor(null);
      setDirty(false);
      if (err.status !== 404) {
        setOffices([]);
        setProfiles([]);
        setOfficeLoaded(false);
        setProfileLoaded(false);
        setOfficeCursor(null);
        setProfileCursor(null);
      }
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || working || !online) return;
    const generation = lifetime.current;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const path = `${base}/${editor.kind}${editor.record ? `/${editor.record.id}` : ""}`;
      if (editor.kind === "offices") {
        const input: Schema<"OfficeWrite"> = { name: name.trim(), timezone: timezone.trim() };
        await runCommand<Schema<"Office">>(
          path,
          input,
          editor.record ? "PATCH" : "POST",
          editor.record?.version,
        );
      } else {
        const input: Schema<"BusinessProfileWrite"> = {
          name: name.trim(),
          websiteUrl: websiteUrl.trim() || null,
          brand: { ...(editor.record?.brand || {}), primaryColor, fontToken },
        };
        await runCommand<Schema<"BusinessProfile">>(
          path,
          input,
          editor.record ? "PATCH" : "POST",
          editor.record?.version,
        );
      }
      if (generation !== lifetime.current) return;
      setEditor(null);
      setDirty(false);
      setNotice(
        `${editor.kind === "offices" ? "Office" : "Business profile"} saved with a durable server acknowledgment.`,
      );
      await load();
    } catch (err) {
      if (generation === lifetime.current) failure(err);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="workspace-records-section" aria-label="Offices and business profiles">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h2>A place for every office and brand.</h2>
          <p className="section-description">
            Manage the current organization’s records. Versioned changes preserve other members’ concurrent
            edits.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={working || loading || !online || dirty}
          onClick={() => void load()}
        >
          <RefreshCw size={16} />
          Refresh workspace records
        </Button>
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
      {editor && (
        <section
          className="panel settings-card workspace-record-editor"
          aria-label={editor.kind === "offices" ? "Office editor" : "Business profile editor"}
        >
          <h3>
            {editor.record ? "Edit" : "Create"} {editor.kind === "offices" ? "office" : "business profile"}
          </h3>
          <form className="settings-form" onSubmit={save} onChange={() => setDirty(true)}>
            <fieldset disabled={working || !online}>
              <label>
                {editor.kind === "offices" ? "Office name" : "Business profile name"}
                <input
                  ref={editorInput}
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {editor.kind === "offices" ? (
                <label>
                  Office timezone
                  <input
                    required
                    maxLength={80}
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    list="workspace-timezones"
                  />
                </label>
              ) : (
                <>
                  <label>
                    Business website (optional)
                    <input
                      type="url"
                      maxLength={2048}
                      placeholder="https://example.test"
                      value={websiteUrl}
                      onChange={(event) => setWebsiteUrl(event.target.value)}
                    />
                  </label>
                  <label>
                    Brand primary color
                    <div className="brand-color-field">
                      <span
                        className="brand-swatch"
                        aria-hidden="true"
                        style={{
                          backgroundColor: /^#[0-9a-f]{6}$/i.test(primaryColor)
                            ? primaryColor
                            : "transparent",
                        }}
                      />
                      <input
                        required
                        pattern="#[0-9a-fA-F]{6}"
                        maxLength={7}
                        title="A six-digit hexadecimal color, such as #2459B8"
                        value={primaryColor}
                        onChange={(event) => setPrimaryColor(event.target.value)}
                      />
                    </div>
                  </label>
                  <label>
                    Brand typeface
                    <select
                      value={fontToken}
                      onChange={(event) => setFontToken(event.target.value as "sans" | "serif")}
                    >
                      <option value="sans">Sans serif</option>
                      <option value="serif">Serif</option>
                    </select>
                  </label>
                  <p className="muted">
                    Logo uploads are unavailable until scoped media handling is implemented. This command
                    saves business-profile records; it does not publish a public website.
                  </p>
                </>
              )}
              <p className="muted">
                {editor.record
                  ? `Editing version ${editor.record.version}. A newer server edit returns a conflict without replacing this draft.`
                  : "The server validates this new organization-scoped record."}
              </p>
              <div className="form-actions">
                <Button variant="secondary" type="button" onClick={closeEditor}>
                  Cancel workspace edit
                </Button>
                {editor.record && (
                  <Button variant="secondary" type="button" onClick={() => void reloadEditor()}>
                    Discard and reload version
                  </Button>
                )}
                <Button type="submit" disabled={!dirty || working || !online}>
                  Save {editor.kind === "offices" ? "office" : "business profile"}
                </Button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
      <div className="workspace-record-grid">
        {officeRead && (
          <section className="panel workspace-record-list">
            <div className="panel-heading">
              <h2>
                <Building2 size={20} />
                Offices
              </h2>
              {officeWrite && (
                <Button
                  variant="secondary"
                  disabled={working || !online}
                  onClick={() => openEditor({ kind: "offices", record: null })}
                >
                  <Plus size={16} />
                  Add office
                </Button>
              )}
            </div>
            {offices.length ? (
              <div className="workspace-record-rows">
                {offices.map((office) => (
                  <article key={office.id}>
                    <div>
                      <h3>{office.name}</h3>
                      <p>{office.timezone}</p>
                      <span>Version {office.version}</span>
                    </div>
                    {officeWrite && (
                      <Button
                        variant="secondary"
                        disabled={working || !online}
                        onClick={() => openEditor({ kind: "offices", record: office })}
                      >
                        Edit office
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <Empty
                icon={<Building2 size={30} />}
                title={loading ? "Loading offices" : officeLoaded ? "No offices yet" : "Offices unavailable"}
              >
                Only current-organization office records appear here.
              </Empty>
            )}
            {officeCursor && (
              <div className="panel-footer">
                <Button
                  variant="secondary"
                  disabled={working || loading || !online || dirty}
                  onClick={() => void load("offices", officeCursor)}
                >
                  Load more offices
                </Button>
              </div>
            )}
          </section>
        )}
        {profileRead && (
          <section className="panel workspace-record-list">
            <div className="panel-heading">
              <h2>
                <Paintbrush size={20} />
                Business profiles
              </h2>
              {profileWrite && (
                <Button
                  variant="secondary"
                  disabled={working || !online}
                  onClick={() => openEditor({ kind: "business-profiles", record: null })}
                >
                  <Plus size={16} />
                  Add business profile
                </Button>
              )}
            </div>
            {profiles.length ? (
              <div className="workspace-record-rows">
                {profiles.map((profile) => (
                  <article key={profile.id}>
                    <div>
                      <h3>{profile.name}</h3>
                      <p>{profile.websiteUrl || "Website not specified"}</p>
                      <div className="profile-brand">
                        <span
                          className="brand-swatch"
                          aria-hidden="true"
                          style={{
                            backgroundColor: /^#[0-9a-f]{6}$/i.test(profile.brand.primaryColor)
                              ? profile.brand.primaryColor
                              : "transparent",
                          }}
                        />
                        <span>
                          {profile.brand.primaryColor} · {profile.brand.fontToken} · Version {profile.version}
                        </span>
                      </div>
                    </div>
                    {profileWrite && (
                      <Button
                        variant="secondary"
                        disabled={working || !online}
                        onClick={() => openEditor({ kind: "business-profiles", record: profile })}
                      >
                        Edit business profile
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <Empty
                icon={<Paintbrush size={30} />}
                title={
                  loading
                    ? "Loading business profiles"
                    : profileLoaded
                      ? "No business profiles yet"
                      : "Business profiles unavailable"
                }
              >
                Brand records stay separate from the user’s profile and organization settings.
              </Empty>
            )}
            {profileCursor && (
              <div className="panel-footer">
                <Button
                  variant="secondary"
                  disabled={working || loading || !online || dirty}
                  onClick={() => void load("business-profiles", profileCursor)}
                >
                  Load more business profiles
                </Button>
              </div>
            )}
          </section>
        )}
      </div>
      {!officeRead && !profileRead && (
        <Empty icon={<Building2 size={30} />} title="Workspace management unavailable">
          Your current role cannot read offices or business profiles.
        </Empty>
      )}
      <datalist id="workspace-timezones">
        <option value="America/Los_Angeles" />
        <option value="America/New_York" />
        <option value="Asia/Bangkok" />
        <option value="UTC" />
      </datalist>
    </section>
  );
}
