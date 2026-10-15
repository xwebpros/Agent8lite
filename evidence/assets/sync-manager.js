/**
 * SyncManager â syncs account data via /v1/sync/data and shows the result inline
 * in the page footer (next to the copyright line), matching the footer font.
 * Status persists across page navigations via sessionStorage.
 *
 * Triggers (set ae_pending_sync = '1' in sessionStorage):
 *   - User logs in with an account (layout sets flag once per tab session)
 *   - Admin switches account via SelectAccount page
 *   - AE Admin loads an account (calls SyncManager.sync() directly)
 */
(function () {
    'use strict';

    const SYNC_URL  = '/api/account-management/sync-data';
    const STATE_KEY = 'ae_sync_widget_state';

    const statusEl = document.getElementById('footerSyncStatus');
    const iconEl   = document.getElementById('footerSyncIcon');
    const textEl   = document.getElementById('footerSyncText');

    let _inFlight = false;

    function formatTimestamp(d) {
        try {
            return d.toLocaleString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: '2-digit'
            });
        } catch {
            return d.toLocaleString();
        }
    }

    // -------------------------------------------------------------------------
    // State persistence
    // -------------------------------------------------------------------------

    function saveState(state, message) {
        if (state) {
            sessionStorage.setItem(STATE_KEY, JSON.stringify({ state, message }));
        } else {
            sessionStorage.removeItem(STATE_KEY);
        }
    }

    // -------------------------------------------------------------------------
    // Widget display
    // -------------------------------------------------------------------------

    function show(state, message) {
        if (!statusEl) return;

        statusEl.className = 'footer-sync footer-sync-' + state;
        statusEl.style.display = 'inline-flex';
        saveState(state, message);

        if (state === 'syncing') {
            textEl.textContent = 'Data sync running';
            iconEl.innerHTML   = '<span class="sync-spinner"></span>';
        } else if (state === 'success') {
            textEl.textContent = message || ('Data sync completed \u2014 ' + formatTimestamp(new Date()));
            iconEl.innerHTML   = '';
        } else if (state === 'error') {
            textEl.innerHTML = 'Data sync failed &mdash; please contact support';
            iconEl.innerHTML = '';
        }
    }

    function dismiss() {
        saveState(null);
        if (statusEl) {
            statusEl.style.display = 'none';
            statusEl.className = 'footer-sync';
        }
    }

    // -------------------------------------------------------------------------
    // Restore widget state on page navigation
    // -------------------------------------------------------------------------

    (function restore() {
        const raw = sessionStorage.getItem(STATE_KEY);
        if (!raw) return;
        try {
            const { state, message } = JSON.parse(raw);
            // A persisted "syncing" state means the page was reloaded mid-flight.
            // Drop it so the widget doesn't show "Syncingâ¦" forever.
            if (state === 'syncing') {
                sessionStorage.removeItem(STATE_KEY);
                return;
            }
            show(state, message);
        } catch {
            sessionStorage.removeItem(STATE_KEY);
        }
    })();

    // -------------------------------------------------------------------------
    // Sync
    // -------------------------------------------------------------------------

    async function sync() {
        if (_inFlight) return;
        _inFlight = true;

        show('syncing');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

        try {
            const r = await fetch(SYNC_URL, { method: 'POST', signal: controller.signal });
            const text = await r.text();

            // HTTP-level failure (401 auth, 500 crash)
            if (!r.ok) {
                _logger('Sync HTTP error', r.status, text);
                show('error');
                return;
            }

            let data = {};
            try { data = JSON.parse(text); } catch { /* non-JSON â treat as error */ }

            const status = data.status;

            if (status === 'skipped') {
                // No Stripe ID or no v2 account â nothing to sync, hide widget silently
                dismiss();
            } else if (status === 'error') {
                // API returned 200 but with a sync error (Cosmos/Stripe down etc.)
                _logger('Sync error from API', data.error);
                show('error');
            } else {
                // Successful sync â status is "synced" or similar.
                // Capture the completion time now so it stays fixed across
                // page navigations (the message is what gets persisted).
                show('success', 'Data sync completed - ' + formatTimestamp(new Date()));
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                _logger('Sync timed out after 30s');
            } else {
                _logger('Sync exception', err);
            }
            show('error');
        } finally {
            clearTimeout(timeoutId);
            _inFlight = false;
        }
    }

    function _logger(...args) {
        console.log('[SyncManager]', ...args);
    }

    // -------------------------------------------------------------------------
    // Auto-trigger
    // -------------------------------------------------------------------------

    if (sessionStorage.getItem('ae_pending_sync') === '1') {
        sessionStorage.removeItem('ae_pending_sync');
        sync();
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    window.SyncManager = { sync, dismiss };
}());
