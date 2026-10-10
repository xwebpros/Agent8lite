"use client";

import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";
import { Building2, CircleCheck, ShieldCheck, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

type Props = {
  session: Schema<"Session">;
  profileVersion: number | null;
  online: boolean;
  working: boolean;
  runCommand: <T>(path: string, body: unknown, method?: string, version?: number) => Promise<T>;
  onRefresh(): Promise<void>;
  setWorking(value: boolean): void;
  onDirty(value: boolean): void;
};
export default function SettingsAdmin({
  session,
  profileVersion,
  online,
  working,
  runCommand,
  onRefresh,
  setWorking,
  onDirty,
}: Props) {
  const organization = session.organizations.find((org) => org.id === session.activeOrgId);
  const permitted = (code: string) => session.permissions.includes(code);
  const [profileBase, setProfileBase] = useState({ data: session.profile, version: profileVersion });
  const [organizationBase, setOrganizationBase] = useState(organization);
  const [profileDirty, setProfileDirty] = useState(false);
  const [organizationDirty, setOrganizationDirty] = useState(false);
  const [teamDirty, setTeamDirty] = useState(false);
  const [roleDirty, setRoleDirty] = useState(false);
  const [formEpoch, setFormEpoch] = useState(0);
  const [members, setMembers] = useState<Schema<"Member">[]>([]);
  const [roles, setRoles] = useState<Schema<"Role">[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [selectedMember, setSelectedMember] = useState<Schema<"Member"> | null>(null);
  const [selectedRole, setSelectedRole] = useState("");
  const [selectedStatus, setSelectedStatus] = useState<"active" | "disabled">("active");
  const teamEpoch = useRef(0);
  const membersReadable = permitted("members.read");
  const rolesReadable = permitted("roles.read");
  const loadTeam = useCallback(async () => {
    if (!session.activeOrgId) return;
    const epoch = ++teamEpoch.current;
    setLoading(true);
    setError("");
    try {
      const base = `/v1/orgs/${session.activeOrgId}`;
      const [memberPage, rolePage] = await Promise.all([
        membersReadable ? api<Schema<"PageMember">>(`${base}/members?limit=100`) : Promise.resolve(null),
        rolesReadable ? api<Schema<"PageRole">>(`${base}/roles?limit=100`) : Promise.resolve(null),
      ]);
      if (epoch !== teamEpoch.current) return;
      setMembers(memberPage?.data.items || []);
      setRoles(rolePage?.data.items || []);
      setHasMore(Boolean(memberPage?.data.hasMore || rolePage?.data.hasMore));
    } catch (err) {
      if (epoch !== teamEpoch.current) return;
      setMembers([]);
      setRoles([]);
      setError(err instanceof Error ? err.message : "Administration records unavailable.");
    } finally {
      if (epoch === teamEpoch.current) setLoading(false);
    }
  }, [session.activeOrgId, membersReadable, rolesReadable]);
  useEffect(() => {
    if (!profileDirty) setProfileBase({ data: session.profile, version: profileVersion });
  }, [session.profile, profileVersion, profileDirty]);
  useEffect(() => {
    if (!organizationDirty) setOrganizationBase(organization);
  }, [organization, organizationDirty]);
  useEffect(() => {
    setMembers([]);
    setRoles([]);
    setSelectedMember(null);
    setTeamDirty(false);
    setOrganizationDirty(false);
    setProfileDirty(false);
    setRoleDirty(false);
    setMessage("");
    void loadTeam();
    return () => {
      ++teamEpoch.current;
    };
  }, [loadTeam]);
  useEffect(() => {
    onDirty(profileDirty || organizationDirty || teamDirty || roleDirty);
  }, [profileDirty, organizationDirty, teamDirty, roleDirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  function failure(err: unknown) {
    setError(
      err instanceof ApiError && err.status === 412
        ? "This record changed. Discard your draft and reload the latest version before trying again. Your changes have not been saved."
        : err instanceof Error
          ? err.message
          : "The command could not be completed.",
    );
  }
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profileBase.version) return;
    const fields = new FormData(event.currentTarget);
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const input: Schema<"Profile"> = {
        displayName: String(fields.get("displayName")).trim(),
        phone: String(fields.get("phone")).trim() || null,
        timezone: String(fields.get("timezone")).trim(),
      };
      await runCommand<Schema<"Profile">>("/v1/session/profile", input, "PATCH", profileBase.version);
      setProfileDirty(false);
      setMessage("Profile saved.");
      await onRefresh();
    } catch (err) {
      failure(err);
    } finally {
      setWorking(false);
    }
  }
  async function saveOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationBase) return;
    const fields = new FormData(event.currentTarget);
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const input: Schema<"OrganizationCreate"> = {
        name: String(fields.get("name")).trim(),
        timezone: String(fields.get("timezone")).trim(),
        locale: String(fields.get("locale")).trim(),
      };
      await runCommand<Schema<"Organization">>(
        `/v1/orgs/${organizationBase.id}`,
        input,
        "PATCH",
        organizationBase.version,
      );
      setOrganizationDirty(false);
      setMessage("Organization settings saved.");
      await onRefresh();
    } catch (err) {
      failure(err);
    } finally {
      setWorking(false);
    }
  }
  async function saveMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMember || !session.activeOrgId) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const input: Schema<"MemberPatch"> = { roleId: selectedRole, status: selectedStatus };
      await runCommand<Schema<"Member">>(
        `/v1/orgs/${session.activeOrgId}/members/${selectedMember.id}`,
        input,
        "PATCH",
        selectedMember.version,
      );
      setSelectedMember(null);
      setTeamDirty(false);
      setMessage("Member access saved. The server protects the last active owner.");
      await loadTeam();
      await onRefresh();
    } catch (err) {
      failure(err);
    } finally {
      setWorking(false);
    }
  }
  async function createRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session.activeOrgId) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const source = roles.find((role) => role.id === fields.get("sourceRole"));
    if (!source) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const input: Schema<"RoleWrite"> = {
        name: String(fields.get("name")).trim(),
        permissions: source.permissions,
      };
      await runCommand<Schema<"Role">>(`/v1/orgs/${session.activeOrgId}/roles`, input);
      form.reset();
      setRoleDirty(false);
      setMessage("Role created with the selected template’s grants.");
      await loadTeam();
    } catch (err) {
      failure(err);
    } finally {
      setWorking(false);
    }
  }
  function discardChanges() {
    if (!window.confirm("Discard unsaved settings and reload current records?")) return;
    setProfileDirty(false);
    setFormEpoch((current) => current + 1);
    setOrganizationDirty(false);
    setTeamDirty(false);
    setRoleDirty(false);
    setSelectedMember(null);
    setError("");
    void onRefresh();
    void loadTeam();
  }
  return (
    <section className="admin-section" aria-label="Account and administration">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">ACCOUNT & ACCESS</span>
          <h2>A few details that make it yours.</h2>
        </div>
        {(profileDirty || organizationDirty || teamDirty || roleDirty) && (
          <Button variant="secondary" disabled={working} onClick={discardChanges}>
            Discard changes
          </Button>
        )}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="success" role="status">
          <CircleCheck size={17} />
          {message}
        </div>
      )}
      <div className="settings-grid">
        <section className="panel settings-card">
          <span className="settings-icon">
            <UserRound size={24} />
          </span>
          <h2>Your profile</h2>
          <p>Your display name and timezone follow you between organizations.</p>
          <form
            className="settings-form"
            onSubmit={saveProfile}
            onChange={() => setProfileDirty(true)}
            key={`profile-${profileBase.version}-${formEpoch}`}
          >
            <label>
              Display name
              <input
                name="displayName"
                required
                maxLength={120}
                defaultValue={profileBase.data.displayName}
                autoComplete="name"
              />
            </label>
            <label>
              Profile phone (optional)
              <input
                name="phone"
                type="tel"
                maxLength={32}
                defaultValue={profileBase.data.phone || ""}
                autoComplete="tel"
              />
            </label>
            <label>
              Your timezone
              <input
                name="timezone"
                required
                maxLength={80}
                defaultValue={profileBase.data.timezone}
                list="timezones"
              />
            </label>
            <p className="muted">
              IANA timezone, such as America/Los_Angeles or Asia/Bangkok.
              {!profileBase.version ? " Profile revision is unavailable; editing cannot be saved." : ""}
            </p>
            <Button
              type="submit"
              disabled={
                !profileDirty ||
                working ||
                !online ||
                !profileBase.version ||
                !permitted("self.profile.write")
              }
            >
              Save profile
            </Button>
          </form>
        </section>
        <section className="panel settings-card">
          <span className="settings-icon">
            <Building2 size={24} />
          </span>
          <h2>Organization settings</h2>
          <p>Manage the current workspace’s name, reporting timezone and locale.</p>
          {organizationBase ? (
            <form
              className="settings-form"
              onSubmit={saveOrganization}
              onChange={() => setOrganizationDirty(true)}
              key={`org-${organizationBase.id}-${organizationBase.version}-${formEpoch}`}
            >
              <label>
                Organization name
                <input
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={organizationBase.name}
                  readOnly={!permitted("org.manage")}
                />
              </label>
              <label>
                Organization timezone
                <input
                  name="timezone"
                  required
                  maxLength={80}
                  defaultValue={organizationBase.timezone}
                  list="timezones"
                  readOnly={!permitted("org.manage")}
                />
              </label>
              <label>
                Locale
                <input
                  name="locale"
                  required
                  maxLength={20}
                  defaultValue={organizationBase.locale}
                  readOnly={!permitted("org.manage")}
                />
              </label>
              <p className="muted">
                Changes use version {organizationBase.version} and cannot overwrite a newer edit.
              </p>
              <Button
                type="submit"
                disabled={!organizationDirty || working || !online || !permitted("org.manage")}
              >
                Save organization
              </Button>
            </form>
          ) : (
            <Empty icon={<Building2 size={25} />} title="Organization unavailable">
              Select an active organization to view its settings.
            </Empty>
          )}
        </section>
      </div>
      {(membersReadable || rolesReadable) && (
        <section className="panel team-panel">
          <div className="panel-heading">
            <h2>
              <Users size={19} />
              Workspace members
            </h2>
            <Badge>{loading ? "Loading…" : `${members.length} loaded members`}</Badge>
          </div>
          {members.length ? (
            <div className="member-list">
              {members.map((person) => (
                <div className="member-row" key={person.id}>
                  <span className="avatar light">
                    {person.displayName
                      .split(" ")
                      .slice(0, 2)
                      .map((part) => part[0])
                      .join("")}
                  </span>
                  <div className="member-info">
                    <strong>{person.displayName}</strong>
                    <span>{roles.find((role) => role.id === person.roleId)?.name || "Role unavailable"}</span>
                  </div>
                  <Badge tone={person.status === "active" ? "positive" : "neutral"}>{person.status}</Badge>
                  {permitted("members.manage") && (
                    <Button
                      variant="secondary"
                      disabled={working || !online || teamDirty}
                      onClick={() => {
                        setSelectedMember(person);
                        setSelectedRole(person.roleId);
                        setSelectedStatus(person.status === "disabled" ? "disabled" : "active");
                      }}
                    >
                      Edit access
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={<Users size={25} />} title={loading ? "Loading members" : "Member list unavailable"}>
              Only permitted organization records appear here.
            </Empty>
          )}
          {selectedMember && (
            <form
              className="member-editor settings-form"
              onSubmit={saveMember}
              onChange={() => setTeamDirty(true)}
            >
              <h3>Access for {selectedMember.displayName}</h3>
              <label>
                Member role
                <select value={selectedRole} onChange={(event) => setSelectedRole(event.target.value)}>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Member status
                <select
                  value={selectedStatus}
                  onChange={(event) => setSelectedStatus(event.target.value as "active" | "disabled")}
                >
                  <option value="active">Active</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              <p className="muted">
                Disabled members lose access. Only owners may change owner memberships, and the last active
                owner is protected.
              </p>
              <div className="form-actions">
                <Button
                  variant="secondary"
                  type="button"
                  disabled={working}
                  onClick={() => {
                    setSelectedMember(null);
                    setTeamDirty(false);
                  }}
                >
                  Cancel edit
                </Button>
                <Button type="submit" disabled={!teamDirty || working || !online || !roles.length}>
                  Save member access
                </Button>
              </div>
            </form>
          )}
          {hasMore && (
            <p className="panel-footer muted">
              Administration shows the first 100 members and roles. Additional-page administration is pending.
            </p>
          )}
        </section>
      )}
      {rolesReadable && (
        <section className="panel role-panel">
          <div className="panel-heading">
            <h2>
              <ShieldCheck size={19} />
              Permission roles
            </h2>
            <Badge>{roles.length} roles</Badge>
          </div>
          <div className="role-grid">
            {roles.map((role) => (
              <article key={role.id} className="role-card">
                <h3>{role.name}</h3>
                <p>
                  {role.permissions.length} permission grants · Version {role.version}
                </p>
                <details>
                  <summary>Review grants</summary>
                  <ul>
                    {role.permissions.map((grant) => (
                      <li key={`${grant.code}:${grant.scope}`}>
                        <code>{grant.code}</code>
                        <Badge>{grant.scope}</Badge>
                      </li>
                    ))}
                  </ul>
                </details>
              </article>
            ))}
          </div>
          {permitted("roles.write") && (
            <form
              className="settings-form role-create"
              key={`role-create-${formEpoch}`}
              onSubmit={createRole}
              onChange={() => setRoleDirty(true)}
            >
              <h3>Create a role from an existing template</h3>
              <p className="muted">
                The new role copies the template’s exact permission codes and row scopes. Review the grants
                above before creating it.
              </p>
              <label>
                New role name
                <input name="name" required maxLength={80} placeholder="e.g. Showing assistant" />
              </label>
              <label>
                Permission template
                <select name="sourceRole" required defaultValue="">
                  <option value="" disabled>
                    Select existing role
                  </option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" disabled={!roleDirty || working || !online || !roles.length}>
                Create role
              </Button>
            </form>
          )}
        </section>
      )}
      <datalist id="timezones">
        <option value="America/Los_Angeles" />
        <option value="America/New_York" />
        <option value="America/Chicago" />
        <option value="Asia/Bangkok" />
        <option value="UTC" />
      </datalist>
    </section>
  );
}
