/*
 * Main dashboard (Index). Renders the greeting from the client's local time, then loads
 * each widget independently and fail-soft: website visits (live WP sites), new reviews +
 * "waiting on you" actions (Local Presence Boost), support-ticket count, and per-product
 * metrics on the plan cards. Anything without data simply doesn't render.
 */
(function () {
    'use strict';

    const root = document.querySelector('.ae-dash');
    if (!root) return;

    const D = root.dataset;
    const firstName = (D.firstName || '').trim();
    const locale = (D.locale || '').trim();
    const wpAsset = (D.wpAsset || '').trim();
    const siteLive = D.siteLive === 'true';
    const lpAsset = (D.lpAsset || '').trim();
    const lpPlan = (D.lpPlan || '').trim().toLowerCase();
    const lpBoost = /boost|elite/.test(lpPlan);   // reviews/analytics are Boost+
    // Highest-priority product the client doesn't own yet (server-computed). Drives the
    // simple "worth exploring next" suggestion in the caught-up state; empty when they
    // own everything.
    const nextRec = {
        name: (D.nextName || '').trim(),
        why: (D.nextWhy || '').trim(),
        icon: (D.nextIcon || '').trim(),
        url: (D.nextUrl || '').trim()
    };
    // Whether each stat card has real data. Set during the fetches, but the cards are
    // revealed together afterwards so the row is laid out for the final count (no
    // half-width leftovers, no mid-load resize).
    let showVisits = false, showProfile = false, showSearch = false;

    const $ = (id) => document.getElementById(id);
    const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    async function getJson(url) {
        try {
            const res = await fetch(url);
            if (!res.ok) return null;
            return await res.json();
        } catch { return null; }
    }

    // âââ Hero: greeting + eyebrow ââââââââââââââââââââââââââââââââââââââââââââ
    (function greeting() {
        const h = new Date().getHours();
        const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
        $('dashGreeting').textContent = firstName ? `${part}, ${firstName}.` : `${part}.`;
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        $('dashEyebrow').textContent = locale ? `${today} Â· ${locale}` : today;
    })();

    // Bits collected across widgets to build the hero narrative sentence.
    const narrative = [];
    function renderNarrative() {
        if (!narrative.length) return;
        const parts = narrative.slice();
        let text;
        if (parts.length === 1) text = parts[0];
        else text = parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
        $('dashNarrative').textContent = 'Over the last 30 days, ' + text + '.';
    }

    // âââ Date ranges (local) âââââââââââââââââââââââââââââââââââââââââââââââââ
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const now = new Date();
    // Rolling last 30 days (ending today), compared against the 30 days before that.
    // A fixed-width window â unlike calendar month-to-date â keeps the current and
    // previous periods the same length, so the comparison is always fair (no partial
    // "early in the month" dip to explain away).
    const WINDOW_DAYS = 30;
    const curStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (WINDOW_DAYS - 1));
    const prevEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - WINDOW_DAYS);
    const prevStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (WINDOW_DAYS * 2 - 1));

    function deltaPill(el, cur, prev, asPercent) {
        if (prev == null || prev <= 0 || cur == null) return;
        const diff = cur - prev;
        if (diff === 0) return;
        el.hidden = false;
        el.classList.toggle('is-down', diff < 0);
        el.textContent = asPercent
            ? `${diff > 0 ? '+' : ''}${Math.round((diff / prev) * 100)}%`
            : `${diff > 0 ? '+' : ''}${diff}`;
    }

    const plMetric = (key, text) => {
        const el = document.querySelector(`[data-plan-metric="${key}"]`);
        if (el && text) el.textContent = text;
    };

    // âââ Website visits ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    // Shown only when: the site is live AND analytics returned AND there's a real
    // number (last 30 days or the prior 30). A live site with zero data shows no card.
    async function loadVisits() {
        if (!wpAsset || !siteLive) return;
        const base = `/api/asset-settings/${encodeURIComponent(wpAsset)}/wp-analytics`;
        const [cur, prev] = await Promise.all([
            getJson(`${base}/summary?start=${fmt(curStart)}&end=${fmt(now)}`),
            getJson(`${base}/summary?start=${fmt(prevStart)}&end=${fmt(prevEnd)}`)
        ]);
        if (!cur) return;
        const visits = cur.totalViews ?? cur.TotalViews ?? 0;
        const prevVisits = prev ? (prev.totalViews ?? prev.TotalViews ?? 0) : 0;
        if (visits <= 0) return;   // no visits in the last 30 days â hide the card (never show a "0")

        showVisits = true;
        $('visitsValue').textContent = visits.toLocaleString();
        deltaPill($('visitsDelta'), visits, prevVisits, true);   // encouraging when up; the full trend lives on the Website page
        plMetric('wordpress_site', `${visits.toLocaleString()} visits Â· last 30 days`);
        narrative.push(`your site pulled ${visits.toLocaleString()} visits`); renderNarrative();
    }

    // âââ Reviews + actions (Local Presence Boost) ââââââââââââââââââââââââââââ
    async function loadLocalPresence() {
        const actionsEl = $('dashActions');
        const actions = [];

        if (lpAsset) {
            const req = (p) => getJson(`/api/asset-settings/${encodeURIComponent(lpAsset)}/${p}`);
            // Profile-health (completeness) and searches both work on any Local Presence
            // tier; reviews are Boost+.
            const [health, searchData, analytics, list, listings] = await Promise.all([
                req('yext-analytics/profile-health'),
                req('yext-analytics/search?range=30d'),
                lpBoost ? req('yext-analytics/reviews?range=30d') : Promise.resolve(null),
                // Scoped to the last 365 days to match the Local Presence dashboard's
                // review window â so the "approve replies" count never flags an old review
                // the client can't actually see (or act on) over in Local Presence.
                lpBoost ? req('yext-reviews?all=true&range=365d') : Promise.resolve(null),
                // Listings analytics carries profileUpdates, which is the only figure on
                // this page about work done FOR the customer rather than things that
                // happened to them. Any Local Presence tier, so it is not gated.
                req('yext-analytics/listings?range=30d')
            ]);

            // Profile strength stat card â profile completeness %, the LP dashboard's
            // headline profile metric. Publisher-independent (so it's meaningful for any
            // business type) and available on any LP tier. It's a status %, not a 30-day
            // trend, so no delta pill â the "fields to complete" line is its supporting number.
            const completeness = health ? (health.completenessPct ?? health.CompletenessPct) : null;
            if (typeof completeness === 'number' && completeness > 0) {
                showProfile = true;
                const pct = Math.round(completeness);
                $('profileValue').textContent = `${pct}%`;
                // Celebratory, encouraging copy that scales with how strong the profile is â
                // even a mid-range score is framed as momentum, not a to-do list.
                $('profileNote').textContent =
                    pct >= 100 ? 'Fully optimized. Outstanding work!'
                    : pct >= 85 ? "You're doing awesome. Ahead of most agents!"
                    : pct >= 60 ? "Looking great. You're almost there!"
                    : "Off to a strong start. Keep it going!";
            }

            // Local searches stat card â how many searches surfaced the business. Any LP
            // tier. No reliable previous-searches field upstream, so no delta shown.
            if (searchData) {
                const searches = searchData.totalSearches ?? searchData.TotalSearches ?? 0;
                if (searches > 0) {
                    showSearch = true;
                    $('searchValue').textContent = searches.toLocaleString();
                    // Date the figure. This card asks for 30 days while the Local
                    // Presence dashboard defaults to a year, so the two legitimately
                    // disagree; unlabelled, that looks like one of them is wrong.
                    const searchNote = $('searchNote');
                    if (searchNote) searchNote.textContent = 'Times you turned up in local searches, last 30 days.';
                    narrative.push(`you turned up in ${searches.toLocaleString()} local searches`); renderNarrative();
                }
            }

            // The line that answers "what am I paying for": everything else here is
            // something that happened to the customer, this is the service working.
            //
            // Worded around publishing rather than authoring. Yext counts a field change
            // whoever made it, so "we made 45 updates" would be claiming edits that may
            // have been the customer's own. What is ours either way is that each change
            // reached every directory. Silent at zero.
            if (listings) {
                const upd = listings.profileUpdates ?? listings.ProfileUpdates ?? 0;
                if (upd > 0) {
                    narrative.push(`${upd} update${upd === 1 ? '' : 's'} to your listing profile went out across every directory`);
                    renderNarrative();
                }
            }

            // Reviews (Boost+ only) â no longer a stat card; still powers the "approve
            // replies" action and a narrative note when the client has them.
            if (analytics) {
                const nw = analytics.totalReviews ?? analytics.TotalReviews ?? 0;
                const pending = list ? ((list.reviews || list.Reviews || []).filter(r => r.awaitingResponse ?? r.AwaitingResponse).length) : 0;
                if (nw > 0) { narrative.push(`you picked up ${nw} new review${nw === 1 ? '' : 's'}`); renderNarrative(); }
                if (pending > 0) actions.push({
                    warn: false, icon: 'message-circle',
                    title: `Reply to ${pending} review${pending === 1 ? '' : 's'}`,
                    // We do NOT draft replies. Local Presence surfaces reviews that have
                    // had no response; writing the reply is the customer's. The old copy
                    // promised a draft that was never there, so the customer arrived
                    // looking for something to approve and found an empty box.
                    sub: 'These reviews have not had a reply yet.',
                    label: 'Review', url: '/Products?type=LocalPresence'
                });
            }

            // Business hours missing (any LP tier)
            const missing = health ? (health.missingFields || health.MissingFields || []) : [];
            if (missing.some(f => (f.key ?? f.Key ?? '').toLowerCase() === 'hours')) actions.push({
                warn: true, icon: 'clock',
                title: 'Add your business hours',
                sub: "Add them once and we'll keep your profile up to date.",
                label: 'Add', url: '/Products?type=LocalPresence'
            });
        }

        // Render the action list
        $('actionsLoading')?.remove();
        if (actions.length === 0) {
            // Caught-up state owns its own header ("You're ahead of it" + pill), so hide
            // the panel's default "Waiting on you" heading.
            const head = document.querySelector('#dashActionsPanel .ae-panel-head');
            if (head) head.style.display = 'none';
            const rec = nextRec.name ? `
                    <div class="ae-ahead-next">
                        <div class="ae-ahead-next-label">Worth exploring next</div>
                        <a class="ae-ahead-next-item" href="${esc(nextRec.url)}">
                            <span class="ae-ahead-next-ico"><i data-lucide="${esc(nextRec.icon)}"></i></span>
                            <span class="ae-ahead-next-body">
                                <span class="ae-ahead-next-title">Add ${esc(nextRec.name)}</span>
                                <span class="ae-ahead-next-why">${esc(nextRec.why)}</span>
                            </span>
                            <i class="ae-ahead-next-arrow" data-lucide="arrow-right"></i>
                        </a>
                    </div>` : '';
            actionsEl.innerHTML = `
                <div class="ae-ahead">
                    <div class="ae-ahead-head">
                        <span class="ae-ahead-title">You're ahead of it</span>
                        <span class="ae-ahead-pill"><i data-lucide="check"></i> All caught up</span>
                    </div>
                    <p class="ae-ahead-sub">Nothing's waiting on you right now. We'll flag anything the moment it needs your attention.</p>
                    ${rec}
                </div>`;
            return;
        }
        const pill = $('actionsCount');
        pill.hidden = false; pill.textContent = actions.length;
        actionsEl.innerHTML = actions.map(a => `
            <div class="ae-action">
                <span class="ae-action-ico ${a.warn ? 'is-warn' : ''}"><i data-lucide="${a.icon}"></i></span>
                <div class="ae-action-body">
                    <div class="ae-action-title">${esc(a.title)}</div>
                    <div class="ae-action-sub">${esc(a.sub)}</div>
                </div>
                <a class="ae-action-cta ae-btn ae-btn-primary" style="width:auto" href="${esc(a.url)}">${esc(a.label)}</a>
            </div>`).join('');
    }

    // âââ Manage billing ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    // Billing lives on Account Settings âº Billing now, so #dashManageBilling is a
    // plain anchor to /AccountSettings#billing (no JS, no Stripe-portal redirect).

    // The widgets below only exist on the active dashboard (client owns products).
    // The get-started storefront has none of them â greeting/eyebrow above already ran.
    if ($('dashStats')) {
        // Kick off widgets (each independent / fail-soft). Collapse the stat row entirely
        // when neither card has meaningful data, so we never leave an empty gap.
        Promise.all([loadVisits(), loadLocalPresence()]).then(() => {
            // Reveal the stat cards together, sized to how many actually have data: a lone
            // card fills the whole row (no leftover half-width column), two cards split it,
            // and none show until now so there's no mid-load resize.
            const count = (showVisits ? 1 : 0) + (showProfile ? 1 : 0) + (showSearch ? 1 : 0);
            if (count === 0) { $('dashStats').style.display = 'none'; return; }
            $('dashStats').classList.add('count-' + count);   // CSS sizes the grid to the count
            if (showVisits) $('statVisits').hidden = false;
            if (showSearch) $('statSearch').hidden = false;
            if (showProfile) $('statProfile').hidden = false;
        });
    }
})();
