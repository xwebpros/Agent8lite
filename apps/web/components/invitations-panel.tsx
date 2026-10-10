"use client";

import { MailPlus, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";

export type InvitationTransfer = {
  token: string;
  email: string;
  organizationId: string;
  organizationName: string;
};
type Props = {
  session: Schema<"Session">;
  online: boolean;
  working: boolean;
  transfer: InvitationTransfer | null;
  acceptanceJob: Schema<"Job"> | null;
  onAcceptedJob(job: Schema<"Job">): void;
  runCommand: <T>(
    path: string,
    body: unknown,
    method?: string,
    version?: number,
    receiveHeaders?: (headers: Headers) => void,
  ) => Promise<T>;
  onDirty(value: boolean): void;
  setWorking(value: boolean): void;
  onRefresh(): Promise<void>;
  onContinue(transfer: InvitationTransfer, identity: "owner" | "agent"): Promise<void>;
  onClearTransfer(): void;
};
export default function InvitationsPanel({
  session,
  online,
  working,
  transfer,
  acceptanceJob,
  onAcceptedJob,
  runCommand,
  onDirty,
  setWorking,
  onRefresh,
  onContinue,
  onClearTransfer,
}: Props) {
  const [roles, setRoles] = useState<Schema<"Role">[]>([]);
  const [offices, setOffices] = useState<Schema<"Office">[]>([]);
  const [roleCursor, setRoleCursor] = useState<string | null>(null);
  const [officeCursor, setOfficeCursor] = useState<string | null>(null);
  const [email, setEmail] = useState("agent@example.test");
  const [roleId, setRoleId] = useState("");
  const [officeIds, setOfficeIds] = useState<string[]>([]);
  const [inviteDirty, setInviteDirty] = useState(false);
  const [token, setToken] = useState(transfer?.token || "");
  const [acceptReviewed, setAcceptReviewed] = useState(false);
  const [created, setCreated] = useState<InvitationTransfer | null>(null);
  const [job, setJob] = useState<Schema<"Job"> | null>(acceptanceJob);
  const [accepted, setAccepted] = useState(Boolean(acceptanceJob));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [jobStale, setJobStale] = useState(false);
  const epoch = useRef(0);
  const lifetime = useRef(0);
  const organization = session.organizations.find((org) => org.id === session.activeOrgId);
  const base = `/v1/orgs/${session.activeOrgId}`;
  const canInvite = session.permissions.includes("members.manage");
  const canReadRoles = session.permissions.includes("roles.read");
  const canReadOffices = session.permissions.includes("offices.read");
  const canReadJobs = session.permissions.includes("jobs.read");
  const loadOptions = useCallback(
    async (resource?: "roles" | "offices", cursor?: string) => {
      if (!session.activeOrgId || !online) return;
      const generation = ++epoch.current;
      setLoading(true);
      setError("");
      const tasks = [
        canReadRoles && (!resource || resource === "roles")
          ? api<Schema<"PageRole">>(
              `${base}/roles?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            )
          : Promise.resolve(null),
        canReadOffices && (!resource || resource === "offices")
          ? api<Schema<"PageOffice">>(
              `${base}/offices?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            )
          : Promise.resolve(null),
      ];
      try {
        const [rolePage, officePage] = await Promise.all(tasks);
        if (generation !== epoch.current) return;
        if (rolePage) {
          setRoles((current) =>
            cursor
              ? [...current, ...(rolePage.data.items as Schema<"Role">[])]
              : (rolePage.data.items as Schema<"Role">[]),
          );
          setRoleCursor(rolePage.data.nextCursor);
        }
        if (officePage) {
          setOffices((current) =>
            cursor
              ? [...current, ...(officePage.data.items as Schema<"Office">[])]
              : (officePage.data.items as Schema<"Office">[]),
          );
          setOfficeCursor(officePage.data.nextCursor);
        }
      } catch (err) {
        if (generation !== epoch.current) return;
        setRoles([]);
        setOffices([]);
        setRoleCursor(null);
        setOfficeCursor(null);
        setError(err instanceof Error ? err.message : "Invitation options unavailable.");
      } finally {
        if (generation === epoch.current) setLoading(false);
      }
    },
    [session.activeOrgId, online, canReadRoles, canReadOffices, base],
  );
  useEffect(() => {
    if (canInvite) void loadOptions();
    return () => {
      ++epoch.current;
    };
  }, [loadOptions, canInvite]);
  useEffect(() => {
    onDirty(inviteDirty || Boolean(token));
  }, [inviteDirty, token, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(
    () => () => {
      ++lifetime.current;
    },
    [],
  );
  function failure(err: unknown) {
    setError(
      err instanceof Error
        ? err.message
        : "The invitation command could not be reconciled. Keep the same input when retrying.",
    );
    if (
      err instanceof ApiError &&
      (err.status === 401 || (err.status === 403 && err.code !== "invitation_email_mismatch"))
    ) {
      setCreated(null);
      setToken("");
      setRoles([]);
      setOffices([]);
      onClearTransfer();
    }
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roleId || working || !online || !organization) return;
    const generation = lifetime.current;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      let invitationToken = "";
      const input: Schema<"InviteMember"> = { email: email.trim(), roleId, officeIds };
      const result = await runCommand<Schema<"Job">>(
        `${base}/member-invitations`,
        input,
        "POST",
        undefined,
        (headers) => {
          invitationToken = headers.get("X-Synthetic-Invitation-Token") || "";
        },
      );
      if (generation !== lifetime.current) return;
      setJob(result);
      setJobStale(false);
      setAccepted(false);
      setInviteDirty(false);
      setCreated(
        invitationToken
          ? {
              token: invitationToken,
              email: email.trim().toLowerCase(),
              organizationId: organization.id,
              organizationName: organization.name,
            }
          : null,
      );
      setNotice(
        "The server acknowledged the invitation command. No email was delivered. Only the reported job state describes creation.",
      );
      if (!invitationToken)
        setError(
          "The local service returned no synthetic acceptance token. Real email delivery is unavailable; acceptance cannot be demonstrated from this response.",
        );
    } catch (err) {
      if (generation === lifetime.current) failure(err);
    } finally {
      setWorking(false);
    }
  }
  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.trim() || !acceptReviewed || working || !online) return;
    const generation = lifetime.current;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const input: Schema<"InvitationAccept"> = { token: token.trim() };
      const result = await runCommand<Schema<"Job">>("/v1/member-invitations/accept", input);
      if (generation !== lifetime.current) return;
      setJob(result);
      setJobStale(false);
      setAccepted(true);
      onAcceptedJob(result);
      setToken("");
      setAcceptReviewed(false);
      setCreated(null);
      onClearTransfer();
      setNotice(
        result.state === "succeeded"
          ? "Invitation acceptance succeeded. Refresh your organization selector, then choose the invited workspace explicitly."
          : "Acceptance is pending or requires reconciliation. No new membership is inferred from this page.",
      );
      await onRefresh();
    } catch (err) {
      if (generation === lifetime.current) failure(err);
    } finally {
      setWorking(false);
    }
  }
  async function checkJob() {
    if (!job || !online || !canReadJobs || checking) return;
    const generation = lifetime.current;
    setChecking(true);
    setError("");
    try {
      const result = await api<Schema<"Job">>(`${base}/jobs/${job.id}`);
      if (generation !== lifetime.current) return;
      setJob(result.data);
      setJobStale(false);
      if (accepted) onAcceptedJob(result.data);
      if (accepted && result.data.state === "succeeded") await onRefresh();
    } catch (err) {
      if (generation === lifetime.current) {
        setJobStale(true);
        failure(err);
      }
    } finally {
      if (generation === lifetime.current) setChecking(false);
    }
  }
  function discard() {
    if (working) return;
    setInviteDirty(false);
    setToken("");
    setAcceptReviewed(false);
    setCreated(null);
    onClearTransfer();
    setError("");
  }
  return (
    <section className="invitation-section" aria-label="Workspace invitations">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">INVITATIONS</span>
          <h2>A clear invitation to your workspace.</h2>
          <p className="section-description">
            Creation and acceptance use the same server authorization and one-use token rules as the published
            API.
          </p>
        </div>
        <MailPlus size={30} />
      </div>
      <div className="synthetic-note">
        <ShieldCheck size={20} />
        <div>
          <strong>Synthetic invitation · No delivery</strong>
          <span>
            No real email is sent. The local issuer can verify owner@example.test or agent@example.test.
            Tokens stay in memory in this tab and are never added to a link, cache or device storage.
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
      {canInvite && (
        <section className="panel settings-card invitation-create">
          <h3>Create a local invitation</h3>
          <p className="section-description">
            Select a role from the current organization. The server verifies delegated permissions, selected
            offices and duplicate pending invitations.
          </p>
          <form className="settings-form" onSubmit={invite} onChange={() => setInviteDirty(true)}>
            <fieldset disabled={working || loading || !online}>
              <label>
                Invitation email
                <input
                  type="email"
                  required
                  maxLength={254}
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label>
                Invitation role
                <select required value={roleId} onChange={(event) => setRoleId(event.target.value)}>
                  <option value="" disabled>
                    Select a role
                  </option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </label>
              {roleCursor && (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void loadOptions("roles", roleCursor)}
                >
                  Load more invitation roles
                </Button>
              )}
              {canReadOffices && (
                <fieldset className="office-options">
                  <legend>Office access (optional)</legend>
                  {offices.length ? (
                    offices.map((office) => (
                      <label key={office.id}>
                        <input
                          type="checkbox"
                          checked={officeIds.includes(office.id)}
                          onChange={(event) =>
                            setOfficeIds((current) =>
                              event.target.checked
                                ? [...current, office.id]
                                : current.filter((id) => id !== office.id),
                            )
                          }
                        />
                        <span>{office.name}</span>
                      </label>
                    ))
                  ) : (
                    <p className="muted">No loaded office records.</p>
                  )}
                  {officeCursor && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void loadOptions("offices", officeCursor)}
                    >
                      Load more invitation offices
                    </Button>
                  )}
                </fieldset>
              )}
              {!canReadRoles && (
                <p className="muted">Your role cannot read invitation roles. Creation is unavailable.</p>
              )}
              <Button type="submit" disabled={!roleId || !roles.length || working || !online}>
                Create synthetic invitation
              </Button>
            </fieldset>
          </form>
          {created && (
            <div className="created-invitation">
              <Badge tone={job?.state === "succeeded" ? "positive" : "warning"}>
                {job?.state || "Unavailable"} · No email delivered
              </Badge>
              <h4>Local recipient: {created.email}</h4>
              <p className="muted">
                For {created.organizationName}. The server stores a token hash, expires the invitation after
                48 hours and permits one acceptance. Existing membership or a different verified email is
                rejected.
              </p>
              <label>
                Local invitation token
                <input
                  readOnly
                  value={created.token}
                  aria-label="Local invitation token"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <p className="muted">
                Keep this in the local demonstration. Switching below transfers it only through this tab’s
                memory and signs in through the existing synthetic issuer.
              </p>
              {["owner@example.test", "agent@example.test"].includes(created.email) ? (
                <Button
                  variant="secondary"
                  disabled={working || !online || Boolean(token)}
                  onClick={() =>
                    void onContinue(created, created.email === "owner@example.test" ? "owner" : "agent")
                  }
                >
                  Continue as synthetic {created.email === "owner@example.test" ? "Owner" : "Agent"}
                </Button>
              ) : (
                <p className="muted">
                  This email has no local fixture identity. Real identity and email delivery are unconfigured.
                </p>
              )}
            </div>
          )}
        </section>
      )}
      <section className="panel settings-card invitation-accept">
        <h3>Accept a workspace invitation</h3>
        <p className="section-description">
          Signed in as {session.profile.displayName}. The server requires your actual verified email to match
          the invitation; typing an email here cannot establish identity.
        </p>
        {transfer && (
          <p className="invitation-target">
            Prepared for {transfer.email} · {transfer.organizationName}. Select the invited organization after
            successful acceptance.
          </p>
        )}
        <form className="settings-form" onSubmit={accept}>
          <fieldset disabled={working || !online}>
            <label>
              Invitation token
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={512}
                required
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                  setAcceptReviewed(false);
                }}
              />
            </label>
            <label className="accept-terms">
              <input
                type="checkbox"
                checked={acceptReviewed}
                onChange={(event) => setAcceptReviewed(event.target.checked)}
              />
              <span>
                I am signed in with the invitation’s verified email and want to join that workspace.
              </span>
            </label>
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={discard}>
                Discard invitation draft
              </Button>
              <Button type="submit" disabled={!token.trim() || !acceptReviewed || working || !online}>
                Accept invitation
              </Button>
            </div>
          </fieldset>
        </form>
      </section>
      {job ? (
        <section className="panel invitation-job">
          <div className="panel-heading">
            <h2>Invitation operation</h2>
            <Badge tone={job.state === "succeeded" && !jobStale ? "positive" : "warning"}>
              {jobStale ? `Last reported: ${job.state}` : job.state}
            </Badge>
          </div>
          <div className="billing-job-body">
            <p>
              {job.kind} · Operation {job.id}
            </p>
            <p>
              {accepted
                ? "The acceptance job belongs to the invited organization. Choose that organization before checking its current status. Membership appears only in a fresh Session response."
                : "Invitation creation does not establish membership or email delivery. The local token is the only available acceptance path."}
            </p>
            {job.error && (
              <div className="error">
                {job.error.title}
                {job.error.detail ? ` — ${job.error.detail}` : ""}
              </div>
            )}
            <Button
              variant="secondary"
              disabled={working || checking || !online || !canReadJobs}
              onClick={() => void checkJob()}
            >
              <RefreshCw size={16} />
              {checking ? "Checking…" : "Check invitation operation"}
            </Button>
          </div>
        </section>
      ) : (
        <Empty icon={<MailPlus size={30} />} title="No invitation operation in this tab">
          Creation and acceptance states appear only after a server acknowledgment.
        </Empty>
      )}
    </section>
  );
}
