// Account Settings Page

let profileDirty = false;

document.addEventListener('DOMContentLoaded', () => {
    loadProfile();
    loadUsers();
    initTabs();
    initProfileDirtyTracking();
    initCopyAccountId();
});

// =========================================================================
// TABBED WORKSPACE: tab switching, save-bar visibility, hash persistence
// =========================================================================

function initTabs() {
    const tabs = document.querySelectorAll('.ae-tab');
    if (!tabs.length) return;

    const fromHash = (location.hash || '').replace('#', '');
    const initial = Array.from(tabs).some(t => t.dataset.tab === fromHash) ? fromHash : 'profile';

    tabs.forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
    switchTab(initial);
}

function switchTab(name) {
    document.querySelectorAll('.ae-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.ae-tabpane').forEach(p =>
        p.hidden = (p.dataset.pane !== name));

    // The save bar only applies to the Profile tab.
    const saveBar = document.getElementById('profileSaveBar');
    if (saveBar) saveBar.style.display = name === 'profile' ? '' : 'none';

    // The Billing tab surfaces payment status in the panel itself (banner + card chip), so hide the
    // redundant site-wide payment banner while it's open; show it again on the other tabs.
    const payBanner = document.getElementById('paymentStatusBanner');
    if (payBanner) payBanner.style.display = name === 'billing' ? 'none' : '';

    if (history.replaceState) history.replaceState(null, '', '#' + name);
    else location.hash = name;
}

// =========================================================================
// PROFILE: dirty/save state + copy account ID
// =========================================================================

function initProfileDirtyTracking() {
    const row = document.getElementById('profileFieldsRow');
    if (!row) return;
    row.querySelectorAll('input, select, textarea').forEach(el => {
        if (el.readOnly) return;
        el.addEventListener('input', markProfileDirty);
    });

    window.addEventListener('beforeunload', (e) => {
        if (profileDirty) { e.preventDefault(); e.returnValue = ''; }
    });
}

function markProfileDirty() {
    profileDirty = true;
    const status = document.getElementById('profileSaveStatus');
    if (status) {
        status.textContent = 'Unsaved changes';
        status.className = 'ae-save-status dirty';
    }
}

function initCopyAccountId() {
    const btn = document.getElementById('aeCopyId');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const id = document.getElementById('aeAccountId')?.textContent?.trim() || '';
        try { await navigator.clipboard.writeText(id); } catch { /* clipboard blocked */ }
        // Pass the BUTTON, not the icon: once rendered the icon is an <svg> and any
        // reference to the original <i> is detached. AESetIcon re-finds it each time.
        btn.classList.add('copied');
        AESetIcon(btn, 'check');
        setTimeout(() => {
            btn.classList.remove('copied');
            AESetIcon(btn, 'copy');
        }, 1500);
    });
}


// =========================================================================
// PERSONAL PROFILE
// =========================================================================

async function loadProfile() {
    try {
        const res = await fetch('/api/account-settings/profile');
        if (!res.ok) return;
        const data = await res.json();
        document.getElementById('profileFirstName').value   = data.firstName || '';
        document.getElementById('profileLastName').value    = data.lastName  || '';
        document.getElementById('profileEmail').value       = data.email     || '';
        document.getElementById('profilePhone').value       = data.phone     || '';
        const addr = data.address || {};
        document.getElementById('profileAddrHouseNo').value  = addr.houseNo  || '';
        document.getElementById('profileAddrStreet').value   = addr.street   || '';
        document.getElementById('profileAddrCity').value     = addr.city     || '';
        document.getElementById('profileAddrState').value    = addr.state    || '';
        document.getElementById('profileAddrPincode').value  = addr.pincode  || '';
        document.getElementById('profileAddrCountry').value  = addr.country  || '';
        document.getElementById('profileAddrLandmark').value = addr.landmark || '';

        // Populate the summary header from the loaded profile.
        const fullName = `${data.firstName || ''} ${data.lastName || ''}`.trim();
        const display  = fullName || data.email || 'Account Settings';
        const titleEl  = document.getElementById('aeHeadTitle');
        const avatarEl = document.getElementById('aeAvatar');
        if (titleEl)  titleEl.textContent = display;
        if (avatarEl) avatarEl.textContent = initialsOf(data.firstName, data.lastName, data.email);

        // loadProfile() populates inputs programmatically, so keep the form pristine.
        profileDirty = false;
    } catch (err) {
        console.error('Failed to load profile', err);
    }
}

function initialsOf(first, last, email) {
    const a = (first || '').trim();
    const b = (last || '').trim();
    if (a || b) return ((a[0] || '') + (b[0] || '')).toUpperCase() || 'AE';
    const e = (email || '').trim();
    return e ? e[0].toUpperCase() : 'AE';
}

async function savePersonalProfile() {
    const status = document.getElementById('profileSaveStatus');
    const setStatus = (text, cls) => { if (status) { status.textContent = text; status.className = 'ae-save-status ' + cls; } };

    setStatus('Savingâ¦', 'saving');
    try {
        const res = await fetch('/api/account-settings/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                firstName : document.getElementById('profileFirstName').value || null,
                lastName  : document.getElementById('profileLastName').value  || null,
                phone     : document.getElementById('profilePhone').value     || null,
                address: {
                    houseNo  : document.getElementById('profileAddrHouseNo').value.trim()  || null,
                    street   : document.getElementById('profileAddrStreet').value.trim()   || null,
                    city     : document.getElementById('profileAddrCity').value.trim()     || null,
                    state    : document.getElementById('profileAddrState').value.trim()    || null,
                    pincode  : document.getElementById('profileAddrPincode').value.trim()  || null,
                    country  : document.getElementById('profileAddrCountry').value.trim()  || null,
                    landmark : document.getElementById('profileAddrLandmark').value.trim() || null,
                }
            })
        });
        if (res.ok) {
            profileDirty = false;
            setStatus('Saved â', 'saved');
            setTimeout(() => { if (status && status.classList.contains('saved')) { status.textContent = ''; status.className = 'ae-save-status'; } }, 2000);
        } else {
            const err = await res.json().catch(() => ({}));
            setStatus(err.error || 'Save failed', 'error');
        }
    } catch (err) {
        setStatus('Save failed', 'error');
    }
}

// =========================================================================
// USERS
// =========================================================================

async function loadUsers() {
    const container = document.getElementById('usersTableContainer');
    try {
        const res = await fetch('/api/account-settings/users');
        if (res.status === 404) {
            container.innerHTML = '<p class="text-muted">No users found.</p>';
            return;
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            container.innerHTML = `<p class="text-muted">Could not load users (${res.status}). ${escHtml(body.slice(0, 120))}</p>`;
            return;
        }
        const data = await res.json();
        // External API returns { Users: [...] }
        const users = data.Users || data.users || (Array.isArray(data) ? data : []);

        // Portal roles (Owner/Member/Custom) live on the account document, fetched separately.
        let roles = {}, canManage = false;
        try {
            const rolesRes = await fetch('/api/account-settings/user-roles');
            if (rolesRes.ok) {
                const rolesData = await rolesRes.json();
                roles = rolesData.roles || {};
                canManage = !!rolesData.canManage;
            }
        } catch { /* roles are best-effort; fall back to no-selector view */ }

        renderUsersTable(users, container, roles, canManage);
    } catch (err) {
        container.innerHTML = `<p class="text-muted">Could not load users: ${escHtml(err.message)}</p>`;
    }
}

// Portal sections an Owner can grant a Custom-role user. Keep in sync with
// homeportal.Models.PortalSections (server-side).
const PORTAL_SECTIONS = [
    { key: 'websites',       label: 'Websites' },
    { key: 'crm',            label: 'CRM / IDX' },
    { key: 'design_studio',  label: 'Design Studio' },
    { key: 'local_presence', label: 'Local Presence' },
    { key: 'facebook_ads',   label: 'Facebook Ads' },
    { key: 'support',        label: 'Support' },
    { key: 'marketplace',    label: 'Marketplace' },
    { key: 'billing',        label: 'Billing' },
    { key: 'manage_users',   label: 'Manage Users' }
];

function renderUsersTable(users, container, roles, canManage) {
    if (!users || users.length === 0) {
        container.innerHTML = '<div class="ae-empty"><i data-lucide="users"></i><p class="mb-0">No users yet.</p></div>';
        return;
    }
    roles = roles || {};
    const colspan = canManage ? 3 : 2;
    // External API returns PascalCase: Name, Email, Roles, LastAccessed
    const rows = users.map((u, i) => {
        const name  = u.Name  || u.name  || `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Unknown';
        const email = u.Email || u.email || '';
        // Users not explicitly listed default to Owner (matches the backend).
        const entry = roles[(email || '').toLowerCase()] || { role: 'owner', permissions: [] };
        const role  = entry.role || 'owner';
        const perms = entry.permissions || [];

        const userCell = `
            <div class="ae-user-cell">
                <span class="ae-user-avatar">${escHtml(userInitials(name, email))}</span>
                <div class="ae-user-meta">
                    <div class="ae-user-name">${escHtml(name)}</div>
                    <div class="ae-user-email">${escHtml(email)}</div>
                </div>
            </div>`;

        const roleCell = canManage
            ? `<select class="form-select form-select-sm ae-role-select"
                       onchange="onRoleChange(${i}, '${escHtml(email)}', this)">
                   <option value="owner"${role === 'owner' ? ' selected' : ''}>Owner</option>
                   <option value="member"${role === 'member' ? ' selected' : ''}>Member</option>
                   <option value="custom"${role === 'custom' ? ' selected' : ''}>Custom</option>
               </select>`
            : `<span class="ae-role-badge ae-role-${escHtml(role)}">${escHtml(role)}</span>`;

        const actionCell = canManage
            ? `<button class="ae-icon-btn ae-icon-btn-danger" title="Remove user" onclick="deleteUser('${escHtml(email)}')">
                   <i data-lucide="trash-2"></i>
               </button>`
            : '';

        const customRow = canManage
            ? `<tr id="customPanel_${i}" class="ae-custom-row" style="display:${role === 'custom' ? '' : 'none'}">
                   <td colspan="${colspan}">${renderCustomPanel(i, email, perms)}</td>
               </tr>`
            : '';

        return `
        <tr class="ae-user-row">
            <td>${userCell}</td>
            <td class="ae-role-col">${roleCell}</td>
            ${canManage ? `<td class="text-end">${actionCell}</td>` : ''}
        </tr>${customRow}`;
    }).join('');

    container.innerHTML = `
        <table class="ae-user-table">
            <thead>
                <tr>
                    <th>Member</th>
                    <th>Role</th>
                    ${canManage ? '<th></th>' : ''}
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
}

// Initials for a user avatar, from name if available, else email.
function userInitials(name, email) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts.length === 1 && parts[0]) return parts[0].slice(0, 2).toUpperCase();
    const e = (email || '').trim();
    return e ? e.slice(0, 2).toUpperCase() : '?';
}

function renderCustomPanel(i, email, perms) {
    perms = perms || [];
    const checks = PORTAL_SECTIONS.map(s => `
        <label class="form-check form-check-inline">
            <input type="checkbox" class="form-check-input" value="${s.key}" ${perms.includes(s.key) ? 'checked' : ''}>
            <span class="form-check-label">${s.label}</span>
        </label>`).join('');
    return `
        <div class="ae-perm-panel" id="customChecks_${i}">
            <div class="small text-muted mb-2"><i class="me-1" data-lucide="sliders-horizontal"></i>Choose the sections this user can see:</div>
            ${checks}
            <div class="mt-2">
                <button class="btn btn-sm btn-success" onclick="applyCustomRole(${i}, '${escHtml(email)}')">
                    <i class="me-1" data-lucide="check"></i>Apply
                </button>
            </div>
        </div>`;
}

function onRoleChange(i, email, selectEl) {
    const role = selectEl.value;
    const panel = document.getElementById(`customPanel_${i}`);
    if (role === 'custom') {
        if (panel) panel.style.display = '';
        // Custom is committed via the Apply button so the section choices go with it.
    } else {
        if (panel) panel.style.display = 'none';
        setUserRole(email, role, null);
    }
}

function applyCustomRole(i, email) {
    const wrap = document.getElementById(`customChecks_${i}`);
    const perms = wrap
        ? Array.from(wrap.querySelectorAll('input[type=checkbox]:checked')).map(c => c.value)
        : [];
    setUserRole(email, 'custom', perms);
}

// Brief inline confirmation/error banner at the top of the Account Settings card.
function flashAccountAlert(message, type) {
    const el = document.getElementById('accountSettingsAlert');
    if (!el) return;
    el.className = `alert alert-${type === 'danger' ? 'danger' : 'success'} py-2 mb-3`;
    el.textContent = message;
    el.style.display = '';
    clearTimeout(flashAccountAlert._t);
    flashAccountAlert._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

async function setUserRole(email, role, permissions) {
    try {
        const res = await fetch('/api/account-settings/user-role', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, role, permissions })
        });
        if (res.ok) {
            // Confirm + reflect the saved role. Custom is committed via Apply, which
            // otherwise gives no visible feedback, so always surface success here.
            const label = role === 'custom'
                ? `Custom access saved for ${email}.`
                : `Role updated to ${role} for ${email}.`;
            flashAccountAlert(label, 'success');
            await loadUsers();
        } else {
            const err = await res.json().catch(() => ({}));
            flashAccountAlert(err.error || err.message || 'Failed to update role.', 'danger');
            await loadUsers(); // reset the UI to the server's state
        }
    } catch {
        flashAccountAlert('Failed to update role.', 'danger');
        await loadUsers();
    }
}

// Show/hide the custom-section checkboxes in the Add User form.
function onAddUserRoleChange() {
    const role = document.getElementById('newUserRole')?.value;
    const panel = document.getElementById('newUserCustomPanel');
    if (panel) panel.style.display = role === 'custom' ? '' : 'none';
}

async function addUser() {
    const status = document.getElementById('addUserStatus');
    const email     = document.getElementById('newUserEmail').value.trim();
    const firstName = document.getElementById('newUserFirstName').value.trim();
    const lastName  = document.getElementById('newUserLastName').value.trim();
    const phone     = document.getElementById('newUserPhone').value.trim();
    const role      = document.getElementById('newUserRole')?.value || 'owner';
    const permissions = role === 'custom'
        ? Array.from(document.querySelectorAll('.newUserPerm:checked')).map(c => c.value)
        : null;

    if (!email || !firstName || !lastName) {
        status.textContent = 'First name, last name, and email are required.';
        status.className = 'ms-2 text-danger small';
        return;
    }

    status.textContent = 'Adding user...';
    status.className = 'ms-2 text-muted small';
    try {
        const res = await fetch('/api/account-settings/add-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, firstName, lastName, phone: phone || null })
        });
        if (res.ok) {
            // Apply the chosen role (new users default to Owner on the backend,
            // so only persist when the Owner picked something else).
            if (role && role !== 'owner') {
                await fetch('/api/account-settings/user-role', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, role, permissions })
                }).catch(() => { /* surfaced on reload via the role column */ });
            }

            status.textContent = 'User added. Invitation emailed.';
            status.className = 'ms-2 text-success small';
            document.getElementById('newUserEmail').value = '';
            document.getElementById('newUserFirstName').value = '';
            document.getElementById('newUserLastName').value = '';
            document.getElementById('newUserPhone').value = '';
            document.getElementById('newUserRole').value = 'owner';
            onAddUserRoleChange();
            await loadUsers();
        } else {
            const err = await res.json().catch(() => ({}));
            // The onboarding API returns { message } or { title, errors }, not { error }.
            // Surface whichever is present so the real reason is visible.
            const validation = err.errors ? Object.values(err.errors).flat().join(' ') : null;
            status.textContent = err.error || err.message || validation || err.title
                || `Failed to add user (${res.status})`;
            status.className = 'ms-2 text-danger small';
        }
    } catch (err) {
        status.textContent = 'Failed to add user (network error)';
        status.className = 'ms-2 text-danger small';
    }
}

async function deleteUser(email) {
    if (!confirm(`Remove ${email} from this account?`)) return;
    try {
        const res = await fetch(`/api/account-settings/delete-user?email=${encodeURIComponent(email)}`, { method: 'DELETE' });
        if (res.ok) {
            await loadUsers();
        } else {
            alert('Failed to remove user.');
        }
    } catch {
        alert('Failed to remove user.');
    }
}

function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
