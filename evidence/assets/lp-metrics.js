/* Local Presence — native metrics dashboard.
 * Renders KPI cards + Chart.js charts inside the General tab (#lp-dashboard)
 * on /Products?type=LocalPresence. Fetches per-category data in parallel from
 * /api/asset-settings/{assetId}/yext-analytics/{category} (proxied through
 * HomePortal → api-collection → Yext Analytics).
 *
 * Each card resolves independently — slow categories don't block fast ones.
 * On per-category failure, only that card flips to the empty state.
 */
(function () {
    'use strict';

    // Chart.js paints to canvas, where var() never resolves — read the token once.
    const CHART_COLOR = getComputedStyle(document.documentElement)
        .getPropertyValue('--ae-blue').trim() || '#11a7e0';
    const CHART_COLOR_MUTED = '#979797';
    // Same reason as CHART_COLOR above: resolve the token, never hand var() to canvas.
    const CHART_COLOR_DANGER = getComputedStyle(document.documentElement)
        .getPropertyValue('--ae-danger').trim() || '#cf4343';
    const CHART_COLOR_WARN = getComputedStyle(document.documentElement)
        .getPropertyValue('--ae-amber').trim() || '#eda32a';
    const CHART_COLOR_OK = getComputedStyle(document.documentElement)
        .getPropertyValue('--ae-success').trim() || '#1f9d6e';

    // Lazily-created chart instances so refetches can reuse them.
    const charts = {
        listingsTrend: null,
        newReviews:    null,
        clicks:        null,
    };

    let currentAssetId = null;
    // Set by init(); when true, the user has overridden the display name via
    // "Edit display name" and applyEntityHeader skips rewriting the h5 from
    // the Yext entity payload. The meta line (line 2) always updates.
    let hasCustomDisplayName = false;
    // Current global analytics range (mirrors the date-range toolbar) and
    // a per-card override for All Reviews. When `allReviewsAllTime` is true
    // the All Reviews card ignores `currentRange` and fetches with no
    // minPublisherDate so every historical review shows.
    // The default analytics window, one year. The toolbar can switch to 30 days or
    // 6 months. Shorter windows (7/90 days) were dropped because they tend to show
    // too little activity for a typical agent to draw any conclusion from.
    const DEFAULT_RANGE = '365d';
    let currentRange = DEFAULT_RANGE;
    let allReviewsAllTime = false;

    // Sub-scores feeding the Local Presence Score gauge. Each renderer pushes what
    // it knows (listings → coverage/aiSearch, reviews → reviews) and re-invokes
    // renderVisibilityScore() so the gauge updates as data lands.
    //
    // A component is one of FOUR things, and the difference is the whole point:
    //   number   the sub-score, 0-100
    //   null     not answered yet (still loading on first paint)
    //   NA       does not apply to this customer's plan (Reviews on Lite)
    //   ERR      we asked and could not get it
    //
    // It used to be number-or-null, and the gauge averaged whatever was non-null.
    // That meant a failed reviews fetch silently turned a three-part score into a
    // two-part one and still printed EXCELLENT, and a Lite customer stared at an
    // empty Reviews bar with no way to tell a bad score from data that was never
    // theirs. A headline grade has to state its own denominator.
    //
    // Accuracy is deliberately absent rather than shown empty: Yext only populates
    // fieldAccuracyPct with the premium field-scan add-on, so a fourth bar would be
    // permanently blank for everyone.
    const SCORE_NA   = 'na';
    const SCORE_ERR  = 'err';
    // Answered, but there is nothing there to score yet.
    const SCORE_NONE = 'none';
    const visibilityScoreState = {
        coverage: null,
        reviews:  null,
        aiSearch: null,
    };

    // Yext publisherIds we count toward the "AI Search" sub-score. AI search
    // surfaces (Gemini/Siri/ChatGPT/Alexa) ride on parent publishers' sync
    // channels so they show up in /listings/listings as alternate brands.
    const AI_SEARCH_PUBLISHER_IDS = ['SIRI', 'GEMINI', 'ALEXA', 'AMAZONALEXA', 'OPENAI', 'CHATGPT'];

    function $(id)   { return document.getElementById(id); }
    function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
    function showEl(id, on) { const el = $(id); if (el) el.style.display = on ? '' : 'none'; }
    function showCol(id, on) {
        // Toggle the whole grid column so cards with no data drop out of the
        // dashboard entirely (vs. showing an empty state inside the card).
        const el = $(id);
        if (el) el.style.display = on ? '' : 'none';
    }
    // IDs of every tip column on the dashboard. Source of truth for the banner-
    // visibility check below.
    const TIP_COL_IDS = [
        'lp-tip-visibility',
        'lp-tip-search',
        'lp-tip-reviews',
        'lp-tip-recent-reviews',
    ];

    function updateTipBanner() {
        // Show the "why am I seeing these?" banner whenever at least one tip
        // is currently visible. Banner uses display:flex when shown so the
        // gap utility class works.
        const banner = $('lp-tip-banner');
        if (!banner) return;
        const anyVisible = TIP_COL_IDS.some(id => {
            const el = $(id);
            return el && el.style.display !== 'none';
        });
        banner.style.display = anyVisible ? 'flex' : 'none';
    }

    function showDataAndTip(dataColId, hasData) {
        // Each data card has a sibling "Why Local Presence" tip card with the
        // mirrored id (lp-col-foo ↔ lp-tip-foo). Show the data card when data
        // exists; otherwise surface the tip so the slot stays useful.
        showCol(dataColId, hasData);
        showCol(dataColId.replace('lp-col-', 'lp-tip-'), !hasData);
        updateTipBanner();
    }

    // The customer OWNS this card and simply has nothing in it yet, so they get
    // their own empty state rather than the tip.
    //
    // The tip card is an upsell: it argues for buying Local Presence. Handing it
    // to somebody already paying for Elite, because they happen to have no reviews
    // yet, tells them to buy a product they own and hides the fact that the card
    // is theirs and empty. Gated cards do not come through here at all; a plan that
    // excludes a feature gets the frosted preview instead.
    function showOwnedCard(dataColId) {
        showCol(dataColId, true);
        showCol(dataColId.replace('lp-col-', 'lp-tip-'), false);
        updateTipBanner();
    }

    // Coaching hints — each lp-coach-* id is a "Hint" pill at the top-right of
    // its data card; the paired -popup div holds the actionable copy that opens
    // on click. Pure DOM toggling here (no Bootstrap dep) so a missing JS
    // bundle can never bubble up and trip the loadMetrics catch block.
    function setCoach(coachId, html) {
        const wrapper = $(coachId);
        if (!wrapper) return;
        const popup = $(coachId + '-popup');
        if (html) {
            if (popup) popup.innerHTML = html;
            wrapper.style.display = '';
        } else {
            if (popup) popup.classList.remove('open');
            wrapper.style.display = 'none';
        }
    }

    // Shown when a card FAILED, which is a different fact from a card that has no
    // data yet. The old code had no way to say so: a failure swapped the card for
    // its "Why Local Presence" tip, so a vendor outage, a genuinely quiet month and
    // a sales pitch were indistinguishable on screen.
    const ERROR_COPY = 'We could not load this just now. It refreshes on its own, so check back in a few minutes.';

    // Removed rather than hidden: they are placeholders, they never come back, and a
    // display:none element left in the flow is one more thing for a later change to
    // trip over. Safe to call more than once, which it is on every range change.
    function clearSkeleton() {
        document.querySelectorAll('[data-lp-skeleton]').forEach(el => el.remove());
    }

    // When nothing rendered, the placeholders become the answer rather than vanishing
    // and leaving the blank tab they existed to prevent. One block, since the shape of
    // a page that has no content to show is one line, not a layout.
    function skeletonMessage(text) {
        const blocks = document.querySelectorAll('[data-lp-skeleton]');
        if (!blocks.length) return;
        blocks.forEach((el, i) => { if (i > 0) el.remove(); });
        blocks[0].removeAttribute('aria-hidden');
        blocks[0].innerHTML =
            `<div class="lp-story-card lp-skeleton-card">${escapeHtml(text)}</div>`;
    }

    async function fetchCategory(category, range) {
        let url = `/api/asset-settings/${encodeURIComponent(currentAssetId)}/yext-analytics/${category}`;
        if (range && category !== 'profile-health') url += `?range=${encodeURIComponent(range)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return res.json();
    }

    async function fetchRecentReviews(limit, range, all) {
        let url = `/api/asset-settings/${encodeURIComponent(currentAssetId)}/yext-reviews?limit=${limit || 10}`;
        if (range) url += `&range=${encodeURIComponent(range)}`;
        if (all)   url += `&all=true`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return res.json();
    }

    // Single point of refresh for the All Reviews card. Honors the
    // `allReviewsAllTime` per-card override: when true, sets `all=true`
    // so api-collection paginates the Yext call up to its 100-review cap.
    // The renderRecentReviews function shows a "Showing top N of M"
    // notice when the upstream total exceeds what we returned.
    function refetchRecentReviews() {
        const recentReviewsCol = 'lp-col-recent-reviews';
        // All Reviews is a Boost+ feature. Lite tenants see the tip card
        // with the gate pill instead of any review data — skip the fetch
        // entirely.
        // Lite: no review data at all, so the rebuilt Reviews card is hidden rather than
        // shown empty. The frosted sample preview that used to sit here belonged to the
        // retired All reviews card and went with it; re-homing that upsell onto the new
        // card is a product decision, not something to reconstruct silently.
        if (cardIsGatedForPlan('recent-reviews', currentPlan)) {
            renderReviewsGatedPreview();
            return;
        }
        // Non-Lite path: clear any frosted preview in case the user switched
        // accounts from Lite → Boost in the same session.
        setCardGated(recentReviewsCol, false);
        const range = allReviewsAllTime ? null : currentRange;
        const limit = allReviewsAllTime ? null : 10;
        const all   = allReviewsAllTime;
        showDataAndTip(recentReviewsCol, true);
        fetchRecentReviews(limit, range, all)
            .then(data => renderRecentReviews(data))
            .catch(err => {
                console.warn('Failed to load recent reviews:', err);
                // Matches the other cards: a failure says so on the card itself.
                // It used to report 'empty' and swap in the tip, so a broken fetch
                // was indistinguishable from having no reviews, and both read as ads.
                showOwnedCard(recentReviewsCol);
            });
    }

    async function fetchListingsStatus() {
        const url = `/api/asset-settings/${encodeURIComponent(currentAssetId)}/yext-listings`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return res.json();
    }

    // ===== Renderers per category =====================================

    // One place that decides what a summary pill looks like, so "amber means context"
    // cannot drift between the two that use it.
    function setPillTone(el, tone) {
        el.classList.remove('text-danger', 'text-muted', 'lp-pill--good', 'lp-pill--context');
        if (tone === 'good')         el.classList.add('lp-pill--good');
        else if (tone === 'context') el.classList.add('lp-pill--context');
        else                         el.classList.add('text-muted');
    }

    /**
     * Where a number came from, for the two metrics Yext keeps a series for.
     *
     * Returns null when there is no story to tell: no series (an api-collection that
     * predates the change sends none, so the pills fall back to the bare number), a
     * single reading, or a value that has not moved. Callers must handle null rather
     * than invent a change out of one data point.
     *
     * `higherIsBetter` exists because the two metrics run opposite ways: accuracy
     * climbing is good news, duplicates climbing is not. Getting that backwards would
     * congratulate a customer for collecting duplicate listings.
     */
    function seriesStory(series, higherIsBetter) {
        if (!Array.isArray(series) || series.length < 2) return null;
        const first = series[0].value;
        const last  = series[series.length - 1].value;
        if (typeof first !== 'number' || typeof last !== 'number') return null;
        if (first === last) return null;
        const rose = last > first;
        return { first, last, rose, improved: higherIsBetter ? rose : !rose };
    }

    // Our own record of who saved what. Separate endpoint because it reads OUR data, not
    // Yext's: Yext reports that a field changed and never who changed it.
    async function fetchUpdateAttribution(range) {
        const url = `/api/asset-settings/${encodeURIComponent(currentAssetId)}/listing-updates?range=${encodeURIComponent(range || DEFAULT_RANGE)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return res.json();
    }

    function renderUpdateAttribution(data) {
        const el = $('lp-updates-ours');
        if (!el) return;
        const ours = (data && data.byUs) || 0;
        // Silent at zero. "Our team made 0 of these" is a worse thing to say than nothing,
        // and zero here often means the work happened somewhere this cannot see rather than
        // that it did not happen.
        if (ours <= 0) { el.style.display = 'none'; return; }
        el.textContent = ours === 1
            ? 'One of these was made by our team on your behalf.'
            : `${formatNumber(ours)} of these were made by our team on your behalf.`;
        el.title = 'Counts changes saved through Agent Elite. Work done directly in the listings network is not included, so the real figure is at least this.';
        el.style.display = '';
    }

    // Each of the four fetches feeding the story sections lands independently, so they
    // deposit their slice here and re-render. Same arrangement as visibilityScoreState
    // above, deliberately: one pattern for "several answers build one card", not two.
    const storyState = { listings: null, status: null, reviews: null, search: null, listingRows: null, reviewList: null, range: null };

    function renderStory() {
        if (storyState.listings) {
            renderDidSection(storyState.listings, storyState.status, storyState.reviews, storyState.range);
            renderGotSection(storyState.listings, storyState.search, storyState.range);
            renderMonths(storyState.listings.impressionsTrend);
            renderDidNext(storyState.search);
            renderReviewsCard(storyState.reviews, storyState.reviewList);
            renderWhereYouAppearCard(storyState.listingRows);
            const pair = $('lp-next-section');
            if (pair) {
                const live = ['lp-didnext-card', 'lp-where-card']
                    .filter(id => ($(id) || {}).style?.display === '').length;
                pair.style.display = live > 0 ? '' : 'none';
                const grid = pair.querySelector('.lp-story-pair');
                if (grid) grid.classList.toggle('lp-story-pair--single', live === 1);
            }
        }
    }

    // ── "What we did for you" / "What it got you" ─────────────────────────────
    //
    // Both sections are fed from data the other cards already fetched, so nothing here
    // adds a request. The sentences are the point: a figure on its own makes the reader
    // do the arithmetic, and most will not, so the card does it for them. "1,844" means
    // nothing; "five times every single day" is a fact about their week.

    function daysInRange(range) {
        return ({ '30d': 30, '180d': 180, '365d': 365 })[range] || 365;
    }

    // Deliberately vague wording on purpose. These are averages over a window, so "about"
    // and "roughly" are honest and "8.33 per month" is not. Rounding up from zero matters
    // too: "about 0 every month" would be a worse thing to print than saying nothing.
    function perPeriod(total, days, periodDays, noun) {
        if (!total || days < periodDays) return '';
        const per = total / (days / periodDays);
        if (per < 1) return '';
        return `About ${Math.round(per)} ${noun}.`;
    }

    // Show the cards that have something to say, hide the rest, return how many survived.
    // The row does the rest: auto-fit + 1fr means the survivors expand to fill the space
    // the hidden ones gave up, at any width, with no column count to keep in sync.
    function applyStoryCards(cards, gridSelector) {
        let shown = 0;
        for (const c of cards) {
            showEl(c.id, c.on);
            if (c.on) { c.fill(); shown++; }
        }
        // One survivor gets a capped track rather than the full row. See the note on
        // .lp-story-grid--single: auto-fit stretching a lone card across 1200px is the
        // mirror image of the empty-space problem, not a fix for it.
        if (gridSelector) {
            const grid = document.querySelector(gridSelector);
            if (grid) grid.classList.toggle('lp-story-grid--single', shown === 1);
        }
        return shown;
    }

    // ── Month by month ────────────────────────────────────────────────────────
    //
    // Aggregated from the daily impressions series the Visibility card already holds, so
    // the total across these bars is the same number shown above them by construction. A
    // second Yext query with a MONTHS dimension would have been the obvious move and the
    // wrong one: two sources for one figure is how two figures end up disagreeing.

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    function monthlyFromDaily(trend) {
        const buckets = new Map();   // insertion order is chronological, trend is sorted
        for (const pt of trend || []) {
            const d = String(pt.date || '');
            if (d.length < 7) continue;
            const key = d.slice(0, 7);                       // YYYY-MM
            buckets.set(key, (buckets.get(key) || 0) + (pt.count || 0));
        }
        let months = [...buckets.entries()].map(([key, total]) => ({
            key,
            total,
            label: MONTH_NAMES[Number(key.slice(5, 7)) - 1] || '',
        }));

        // Drop the first and last bucket. The window is a rolling 365 (or 180, or 30)
        // days back from today, so it always begins and ends mid-month and BOTH edge
        // buckets are part-months.
        //
        // Real data made this obvious: a year from 22 Sep gives thirteen buckets with
        // "Sep" at each end, 56 at the start and 54 at the finish against a mid-year
        // average near 160. Left in, they win "quietest month" every time and make the
        // floor line read "at least 54 every month" when the true floor is 117. They also
        // print the same month label twice, which just looks broken.
        //
        // Only when there is enough left to be worth drawing: below four buckets the
        // trimming would cost more than the distortion.
        if (months.length >= 4) months = months.slice(1, -1);
        return months;
    }

    function renderMonths(trend) {
        const host   = $('lp-months');
        const labels = $('lp-months-labels');
        const months = monthlyFromDaily(trend);

        // Under three months there is no shape to show, only a couple of bars saying
        // less than the headline number already did. Common on a 30-day range, and on a
        // customer who joined recently.
        if (!host || months.length < 3) { showEl('lp-months-section', false); return; }

        const best  = months.reduce((a, b) => (b.total > a.total ? b : a));
        const floor = months.reduce((a, b) => (b.total < a.total ? b : a));
        const peak  = Math.max(1, best.total);

        // One column count, set once, read by both grids. Without it the bars and the
        // labels underneath drift apart the moment a customer has other than twelve
        // months of history.
        const section = $('lp-months-section');
        if (section) {
            section.style.setProperty('--lp-months', String(months.length));
            // Fewer bars, shorter chart. Twelve months earn the full 240; a customer on a
            // six-month range with four bars gets a proportionate block instead of four
            // towers under a lot of empty card.
            const h = Math.max(140, Math.min(240, 60 + months.length * 15));
            section.style.setProperty('--lp-months-h', `${h}px`);
        }

        host.innerHTML = months.map(m => {
            // A floor of 3% so a genuinely quiet month is still a visible mark rather
            // than a gap that reads as missing data.
            const pct = Math.max(3, Math.round((m.total / peak) * 100));
            const isBest = m.key === best.key;
            return `<div class="lp-month${isBest ? ' lp-month--best' : ''}">
                        <div class="lp-month-bar" style="height:${pct}%">
                            <span class="lp-month-value">${formatNumber(m.total)}</span>
                        </div>
                    </div>`;
        }).join('');

        if (labels) {
            labels.innerHTML = months.map(m =>
                `<span class="${m.key === best.key ? 'is-best' : ''}">${escapeHtml(m.label)}</span>`).join('');
        }

        const el = $('lp-months-headline');
        if (el) {
            el.innerHTML = `Your best month was ${escapeHtml(best.label)}, `
                         + `with <strong>${formatNumber(best.total)}</strong> people seeing you.`;
        }

        // The floor is the reassuring half of the story: a good peak with a dead month
        // under it reads worse than a steady year does.
        const floorBox = $('lp-months-floor-box');
        if (floor.total > 0) {
            setText('lp-months-floor', `At least ${formatNumber(floor.total)} people saw you`);
            setText('lp-months-floor-label', months.length >= 11 ? 'Every month this year' : 'Every month');
            if (floorBox) floorBox.style.display = '';
        } else if (floorBox) {
            floorBox.style.display = 'none';
        }
        showEl('lp-months-section', true);
    }

    // ── Boost gate on the Reviews card ────────────────────────────────────────
    //
    // Lite accounts see the card filled with ideal sample data, blurred, under an
    // Upgrade overlay. Showing what the feature looks like sells it better than an empty
    // card or a line of text, which is why this exists rather than simply hiding it.
    //
    // The sample is carried verbatim from the retired All reviews card so the upsell a
    // Lite customer sees today is the one they saw yesterday. It never touches
    // storyState and never feeds the score: it is decoration over a locked card, and
    // letting it reach the gauge would have us scoring a customer on invented reviews.
    function buildSampleReviewTrend() {
        const out = [];
        const today = new Date();
        for (let i = 29; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            const wave = Math.abs(Math.sin(i / 3.5)) * 2;
            const ramp = (29 - i) / 10;
            out.push({ date: d.toISOString().slice(0, 10), count: Math.max(0, Math.round(1 + wave + ramp)) });
        }
        return out;
    }

    function renderReviewsGatedPreview() {
        const now = Date.now(), day = 86400000;
        const analytics = {
            totalReviews: 37,
            averageRating: 4.9,
            ratingTrend: buildSampleReviewTrend(),
        };
        const list = { reviews: [
            { authorName: 'Jessica M.', rating: 5, publisherId: 'GOOGLEMYBUSINESS', publishedAt: new Date(now - 2 * day).toISOString(),  content: 'Made selling our home effortless. Communicative, sharp on pricing, and closed above asking.' },
            { authorName: 'Daniel R.',  rating: 5, publisherId: 'FACEBOOK',         publishedAt: new Date(now - 6 * day).toISOString(),  content: 'Knew every neighborhood inside out and negotiated hard for us. Highly recommend.' },
            { authorName: 'Priya S.',   rating: 5, publisherId: 'GOOGLEMYBUSINESS', publishedAt: new Date(now - 11 * day).toISOString(), content: 'First-time buyers and we never felt lost. Patient, responsive, and genuinely caring.' },
            { authorName: 'Mark T.',    rating: 4, publisherId: 'GOOGLEMYBUSINESS', publishedAt: new Date(now - 18 * day).toISOString(), content: 'Smooth process from listing to close. Great photography and marketing.' },
        ] };
        renderReviewsCard(analytics, list);
        setCardGated('lp-reviews2-section', true);
    }

    // ── Reviews, rebuilt ──────────────────────────────────────────────────────
    function renderReviewsCard(analytics, list) {
        const section = $('lp-reviews2-section');
        if (!section) return;

        const count = analytics ? (analytics.totalReviews || 0) : 0;
        const avg   = analytics ? (analytics.averageRating || 0) : 0;
        const rows  = (list && (list.reviews || list.Reviews)) || [];

        // Nothing at all: the body is replaced rather than annotated, so the customer is
        // not shown an empty chart above an empty list.
        const hasAny = count > 0 || rows.length > 0;
        showEl('lp-reviews2-empty', !hasAny);
        showEl('lp-reviews2-chart-wrap', hasAny);
        const feed = document.querySelector('.lp-reviews2-feed');
        if (feed) feed.style.display = hasAny ? '' : 'none';
        showEl('lp-reviews2-headline', hasAny);
        section.style.display = '';
        if (!hasAny) { setText('lp-reviews2-avg', ''); return; }

        setText('lp-reviews2-avg', avg > 0 ? `${avg.toFixed(1)} \u2605` : '');
        const head = $('lp-reviews2-headline');
        if (head) {
            head.innerHTML = avg >= 4.9
                ? `<strong>${formatNumber(count)}</strong> new reviews, every one of them five stars.`
                : `<strong>${formatNumber(count)}</strong> new review${count === 1 ? '' : 's'}, averaging ${avg.toFixed(1)} stars.`;
        }

        // New reviews per day: blue line on a blue-light fill, three ticks. Reuses the
        // shared chart upserter so a range change replaces the data rather than stacking
        // a second canvas instance on the same element.
        // Two points make a line; one makes a dot in the middle of 160px of nothing.
        const trend = (analytics && analytics.ratingTrend) || [];
        showEl('lp-reviews2-chart-wrap', trend.length >= 2);
        if (trend.length >= 2) {
            upsertChart('reviews2', 'lp-reviews2-chart', {
                type: 'line',
                data: {
                    labels: trend.map(t => t.date),
                    datasets: [{
                        label: 'New reviews',
                        data: trend.map(t => t.count || 0),
                        borderColor: CHART_COLOR,
                        backgroundColor: 'rgba(17, 167, 224, 0.12)',
                        fill: true, tension: 0.4, borderWidth: 2.5, pointRadius: 0,
                    }],
                },
                options: commonLineOptions({ beginAtZero: true, ticks: { precision: 0 } }, { maxTicksLimit: 3 }),
            });
        }

        const ul = $('lp-reviews2-list');
        if (ul) {
            ul.innerHTML = rows.map(r => {
                const stars = Math.max(0, Math.min(5, Math.round(r.rating || 0)));
                const when  = r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : '';
                const text  = (r.content || '').trim();
                return `<li class="lp-reviews2-item">
                    <div class="lp-reviews2-top">
                        ${stars > 0 ? `<span class="lp-reviews2-stars">${'\u2605'.repeat(stars)}</span>` : ''}
                        <span class="lp-reviews2-name">${escapeHtml(r.authorName || 'Anonymous')}</span>
                        <span class="lp-reviews2-src">${escapeHtml(humanizePublisher(r.publisherId) || 'Listing')}</span>
                        ${when ? `<span class="lp-reviews2-date">${escapeHtml(when)}</span>` : ''}
                    </div>
                    ${text ? `<div class="lp-reviews2-text">${escapeHtml(text)}</div>` : ''}
                </li>`;
            }).join('');
        }
    }

    // ── What people did next ──────────────────────────────────────────────────
    function renderDidNext(search) {
        const card = $('lp-didnext-card');
        if (!card) return;
        const parts = [
            { key: 'directions', label: 'Asked for directions', value: search ? (search.clicksDirections || 0) : 0 },
            { key: 'website',    label: 'Visited your website', value: search ? (search.clicksWebsite || 0) : 0 },
            { key: 'calls',      label: 'Called you',           value: search ? (search.clicksCall || 0) : 0 },
        ];
        const total = parts.reduce((a, p) => a + p.value, 0);
        if (total <= 0) { card.style.display = 'none'; return; }

        const top  = parts.reduce((a, b) => (b.value > a.value ? b : a));
        const peak = Math.max(1, top.value);

        setText('lp-didnext-total', formatNumber(total));
        const head = $('lp-didnext-headline');
        if (head) {
            // "9 in 10" rather than "94%": a plain fraction is what the spec asks for and
            // what the audience reads without converting it first.
            const inTen = Math.round((top.value / total) * 10);
            const share = inTen >= 10 ? 'Nearly everyone' : `${inTen} in 10`;
            head.innerHTML = `<strong>${formatNumber(total)}</strong> ${share.toLowerCase() === 'nearly everyone'
                ? 'people got in touch, and nearly all of them'
                : `people got in touch, and ${share} of them`} ${topVerb(top.key)}.`;
        }
        const bars = $('lp-didnext-bars');
        if (bars) {
            bars.innerHTML = parts.map(pt => `
                <div class="lp-next-row">
                    <span class="lp-next-label">${escapeHtml(pt.label)}</span>
                    <span class="lp-next-value">${formatNumber(pt.value)}</span>
                    <span class="lp-next-track"><span class="lp-next-fill" style="width:${Math.round((pt.value / peak) * 100)}%"></span></span>
                </div>`).join('');
        }
        card.style.display = '';
    }

    function topVerb(key) {
        return key === 'directions' ? 'asked for directions to you'
             : key === 'website'    ? 'visited your website'
             :                        'called you';
    }

    // ── Where you appear ──────────────────────────────────────────────────────
    //
    // Categories are grouped from the real publisher ids this account returns, not from a
    // guess at Yext's taxonomy: they expose none. Anything unlisted falls to "Directories
    // and social", which is where the long tail genuinely belongs and means a publisher we
    // have never seen is counted rather than dropped.
    const PUBLISHER_CATEGORIES = [
        { label: 'Search engines', eg: 'Google, Bing, Yahoo',
          ids: ['GOOGLEMYBUSINESS','BING','YAHOO','YANDEX','BRAVE','SOLEO','DOLA'] },
        { label: 'Maps and GPS', eg: 'Apple Maps, Waze, TomTom',
          ids: ['APPLE','HERE','MAPBOX','MAPQUEST','MAPSTR','NAVMII','TOMTOM','UBER','WHERETO','AROUNDME','SAFEGRAPH','PITNEYBOWES'] },
        { label: 'Voice and AI assistants', eg: 'Siri, Alexa, ChatGPT',
          ids: ['ALEXA','OPENAI','METAPLACESGRAPH'] },
        { label: 'Directories and social', eg: 'Facebook, Yelp, Nextdoor', ids: null },   // catch-all
    ];

    function categorise(listings) {
        const counts = PUBLISHER_CATEGORIES.map(c => ({ ...c, count: 0 }));
        for (const l of listings) {
            const id = String(l.publisherId || '').toUpperCase();
            const hit = counts.find(c => c.ids && c.ids.indexOf(id) >= 0) || counts[counts.length - 1];
            hit.count++;
        }
        return counts;
    }

    function renderWhereYouAppearCard(listings) {
        const card = $('lp-where-card');
        if (!card || !listings || listings.length === 0) { if (card) card.style.display = 'none'; return; }

        const b = { live: 0, syncing: 0, needs: 0, out: 0 };
        for (const l of listings) {
            const g = groupListingForUi(l);
            if      (g === 'synced')     b.live++;
            else if (g === 'processing') b.syncing++;
            else if (g === 'opted_out')  b.out++;
            else                         b.needs++;
        }
        const total = listings.length;

        const head = $('lp-where-headline');
        if (head) head.innerHTML = `You are live on <strong>${formatNumber(b.live)}</strong> of the ${formatNumber(total)} places buyers search.`;

        const bar = $('lp-where-bar');
        if (bar) {
            const pct = n => (n / total) * 100;
            bar.innerHTML = [['live','live'],['syncing','syncing'],['needs','needs'],['out','out']]
                .filter(([k]) => b[k] > 0)
                .map(([k, cls]) => `<span class="lp-where-seg lp-where-seg--${cls}" style="width:${pct(b[k])}%"></span>`)
                .join('');
        }

        const counts = $('lp-where-counts');
        if (counts) {
            const rows = [
                ['live',    'Live now',          'var(--ae-success)'],
                ['syncing', 'Syncing today',     'var(--ae-blue)'],
                ['needs',   'Need a profile field', 'var(--ae-amber)'],
                ['out',     'Opted out by you',  'var(--ae-border)'],
            ];
            counts.innerHTML = rows.map(([k, label, colour]) => `
                <div class="lp-where-count">
                    <span class="lp-where-dot" style="background:${colour}"></span>
                    <strong>${formatNumber(b[k])}</strong><span>${escapeHtml(label)}</span>
                </div>`).join('');
        }

        const panel = $('lp-where-panel');
        if (panel) {
            // A zero category is still listed, per the spec: "we cover none of those" is
            // information, and a list that changes length between customers is harder to
            // read than one that does not.
            panel.innerHTML = categorise(listings).map(c => `
                <div class="lp-where-cat">
                    <span class="lp-where-cat-label">${escapeHtml(c.label)}</span>
                    <span class="lp-where-cat-count">${formatNumber(c.count)}</span>
                    <span class="lp-where-cat-eg">${escapeHtml(c.eg)}</span>
                </div>`).join('');
        }
        card.style.display = '';
    }

    function renderDidSection(data, status, reviews, range) {
        const days = daysInRange(range);
        const updates  = data.profileUpdates || 0;
        const accuracy = data.accuracyPct;
        const live     = status ? status.live : null;

        // A card with nothing in it is hidden, not zeroed. The grid is auto-fit with 1fr
        // tracks, so a hidden card leaves the row entirely and the survivors stretch to
        // fill it: three cards share the width evenly, one card takes the whole row.
        // Nothing here needs a column count, which is what keeps it responsive.
        const newReviews = reviews ? (reviews.totalReviews || 0) : 0;
        const cards = [
            { id: 'lp-did-card-updates', on: updates > 0, fill: () => {
                setText('lp-did-updates', formatNumber(updates));
                setText('lp-did-updates-note',
                    perPeriod(updates, days, 30, 'every month, hands off') || 'Pushed out to every directory for you.');
            }},
            { id: 'lp-did-card-directories', on: live != null && live > 0, fill: () => {
                setText('lp-did-directories', formatNumber(live));
                setText('lp-did-directories-note', 'Checked daily against your profile.');
            }},
            { id: 'lp-did-card-reviews', on: newReviews > 0, fill: () => {
                setText('lp-did-reviews', formatNumber(newReviews));
                const avg = reviews.averageRating || 0;
                setText('lp-did-reviews-note', avg >= 4.9
                    ? 'Every one of them five stars.'
                    : `Averaging ${avg.toFixed(1)} stars.`);
            }},
            { id: 'lp-did-card-accuracy', on: typeof accuracy === 'number' && accuracy > 0, fill: () => {
                setText('lp-did-accuracy', `${accuracy.toFixed(0)}%`);
                const dupes = data.duplicatesCount || 0;
                setText('lp-did-accuracy-note', dupes === 0
                    ? 'Zero duplicate listings left online.'
                    : `${dupes} duplicate${dupes === 1 ? '' : 's'} still to clear.`);
            }},
        ];
        showEl('lp-did-section', applyStoryCards(cards, '#lp-did-section .lp-story-grid') > 0);
    }

    function renderGotSection(data, search, range) {
        const days  = daysInRange(range);
        const seen  = data.totalImpressions || 0;
        const views = data.profileViews || 0;
        const acts  = search ? (search.totalSearches || 0) : 0;

        const cards = [
            { id: 'lp-got-card-seen', on: seen > 0, fill: () => {
                setText('lp-got-seen', formatNumber(seen));
                setText('lp-got-seen-copy', 'people looked at you.');
                setText('lp-got-seen-note', perPeriod(seen, days, 1, 'times every single day'));
            }},
            { id: 'lp-got-card-opened', on: views > 0, fill: () => {
                setText('lp-got-opened', formatNumber(views));
                setText('lp-got-opened-copy', 'stopped and read your profile.');
                // A ratio says more than either number: it is the difference between
                // being listed and being chosen.
                setText('lp-got-opened-note', seen > 0
                    ? `1 in ${Math.max(2, Math.round(seen / views))} of everyone who saw you.`
                    : '');
            }},
            // Zero on plenty of real accounts: TOTAL_LISTINGS_ACTIONS is 0 for entities
            // whose publishers do not report actions, and Yext's own dashboard shows the
            // same. The card leaves the row rather than sitting there reading nought.
            { id: 'lp-got-card-reach', on: acts > 0, fill: () => {
                setText('lp-got-reach', formatNumber(acts));
                setText('lp-got-reach-copy', 'called, clicked or asked for directions.');
                setText('lp-got-reach-note', perPeriod(acts, days, 7, 'people every week'));
            }},
        ];
        const shown = applyStoryCards(cards, '#lp-got-section .lp-story-grid');

        // Search versus maps. The APP dimension has exactly these two buckets, which is
        // why this is two figures and not the directory table it was mistaken for.
        const sr = data.impressionsSearch || 0;
        const mp = data.impressionsMaps || 0;
        showEl('lp-got-split', sr > 0 || mp > 0);
        if (sr > 0 || mp > 0) {
            setText('lp-got-search', formatNumber(sr));
            setText('lp-got-maps', formatNumber(mp));
        }
        showEl('lp-got-section', shown > 0);
    }

    // Feeds the story sections. The Visibility card this used to paint has been retired:
    // its headline is now "Times you were seen", its trend is the month chart, and its
    // accuracy and duplicate pills are the "Listing accuracy" card. What remains is the
    // deposit, because four fetches land independently and renderStory needs all of them.
    function renderListings(data) {
        storyState.listings = data;
        renderStory();
    }

    // Feeds the rebuilt Reviews card and the score gauge. The old Reviews card and its
    // rating-distribution popover have been retired.
    function renderReviews(data) {
        storyState.reviews = data;

        // The gauge still needs this: averageRating is 0-5, so multiply by 20. Zero
        // reviews is SCORE_NONE, not null and not zero, for the reasons on that constant.
        const hasReviews = (data.totalReviews || 0) > 0;
        visibilityScoreState.reviews = hasReviews && data.averageRating
            ? Math.round(data.averageRating * 20)
            : SCORE_NONE;
        setText('lp-sub-reviews', hasReviews
            ? `${(data.averageRating || 0).toFixed(1)} average across ${formatNumber(data.totalReviews)} reviews`
            : 'No reviews in this period yet');
        renderVisibilityScore();

        renderStory();
    }

    // Feeds "Tried to reach you" and "What people did next". The Search performance card
    // it used to paint has been retired.
    function renderSearch(data) {
        storyState.search = data;
        renderStory();
    }

    // Feeds the rebuilt Reviews feed. The All reviews card it used to paint is retired.
    function renderRecentReviews(data) {
        storyState.reviewList = data;
        renderStory();
    }

    // Map a listing to one of four buckets used by the "Where you appear"
    // grid. Mirrors the All Listings tile semantics 1:1 so the WYA counts
    // match the tile counts exactly:
    //   live      = Synced tile      (LIVE)
    //   syncing   = Processing tile  (PENDING / SYNC_IN_PROGRESS / WAITING_ON_*)
    //   needs     = Not Synced tile  (everything that needs profile fields)
    //   opted-out = Opted Out tile   (user explicitly suppressed)
    function bucketForWya(l) {
        const group = groupListingForUi(l);
        if (group === 'synced')     return 'live';
        if (group === 'processing') return 'syncing';
        if (group === 'opted_out')  return 'opted-out';
        return 'needs';
    }

    // "Where you appear" card — big "live / total" headline, a chip grid
    // with one chip per publisher (status-tinted), and the live/syncing/
    // needs legend below. Pulls everything from the same listings payload

    // Visibility Score card — donut on the left with the 0-100 composite
    // score + GOOD/FAIR/POOR grade pill; four sub-bars on the right.
    // Components with no data render with no fill and a named state, never a dash
    // (Accuracy in particular often has no upstream value).
    // What the previous window is called, so a delta names what it is measured
    // against instead of saying "previous period" and leaving the customer to guess.
    const PREV_LABELS = {
        '30d':  'vs the 30 days before',
        '180d': 'vs the 6 months before',
        '365d': 'vs the year before',
    };

    // One delta renderer for the three headline cards, which each carried their own copy.
    //
    // A FALL IS NOT SHOWN AT ALL, and neither is a first period with nothing to compare
    // against. Only a rise gets a pill. This is the spec's rule and it replaces the amber
    // treatment that was here: the figure itself is never touched, so nothing is hidden
    // from the customer, but the dashboard does not editorialise a quiet month at them.
    //
    // The consequence to keep in mind when reading this page: the absence of a pill means
    // "flat, down, or nothing to compare", three different things that deliberately look
    // the same. Anyone tempted to infer "no pill means no change" from the UI would be
    // wrong, which is why it is written down here.
    function renderDelta(el, current, previous, emptyCopy) {
        if (!el) return;
        if (previous > 0 && current > 0) {
            const pct = ((current - previous) / previous) * 100;
            if (pct > 0) {
                const since = PREV_LABELS[currentRange] || 'vs the period before';
                el.innerHTML = `<span class="lp-delta-up">\u25b2 ${Math.round(pct)}%</span> `
                             + `<span class="text-muted small">${since}</span>`;
                return;
            }
        }
        // Everything else: no pill. Not a dash, not a zero, not a grey "no change".
        el.innerHTML = current > 0 ? '' : `<span class="text-muted small">${emptyCopy}</span>`;
    }

    function renderVisibilityScore() {
        const { coverage, reviews, aiSearch } = visibilityScoreState;
        const all = [coverage, reviews, aiSearch];

        // Only components that COULD have answered count toward the denominator.
        // NA is excluded because it is not a gap in the customer's performance, it is
        // a metric their plan does not cover. ERR is counted as still-owed so the
        // score can say it is incomplete rather than quietly rebasing itself.
        const scored  = all.filter(v => typeof v === 'number');
        const errored = all.filter(v => v === SCORE_ERR).length;
        const pending = all.filter(v => v === null).length;

        const overall = scored.length > 0
            ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
            : null;

        const numberEl = $('lp-vscore-number');
        const gradeEl  = $('lp-vscore-grade');
        const arc      = $('lp-vscore-arc');
        const noteEl   = $('lp-vscore-basis');
        const circumference = 2 * Math.PI * 72; // r=72, matching the design file's ring

        if (numberEl) numberEl.textContent = overall == null ? '\u2026' : String(overall);

        // Say what the number is actually made of. Without this the same business can
        // show two different scores on two loads and look like it is guessing.
        // The basis line is now only for when something is WRONG. "Average of 3 measures
        // below" restated what the three bars underneath already showed, and a card that
        // narrates its own layout is noise.
        //
        // The incomplete case stays, and is the reason the element survives at all: a
        // score built from two of three measures has to say so, or the same business
        // shows two different scores on two loads with nothing to explain it.
        if (noteEl) {
            if (overall == null) {
                noteEl.textContent = pending > 0 ? 'Working it out\u2026' : 'Not enough data yet.';
                noteEl.style.display = '';
            } else if (errored > 0) {
                noteEl.textContent = 'Based on ' + scored.length + ' of ' +
                    (scored.length + errored) + ' measures. One could not be loaded, so this is incomplete.';
                noteEl.style.display = '';
            } else {
                noteEl.textContent = '';
                noteEl.style.display = 'none';
            }
        }

        if (arc) {
            // dasharray, not dashoffset: "draw score/100 of the circumference, then gap
            // for the rest" is what the spec asks for and it needs no offset to line up
            // with the -90 rotation the svg already carries.
            const pct = overall == null ? 0 : Math.max(0, Math.min(100, overall));
            arc.setAttribute('stroke-dasharray', `${(circumference * pct / 100).toFixed(1)} ${circumference.toFixed(1)}`);
        }

        // One Poppins sentence on where they stand, which is what the card is for. The
        // band word alone ("EXCELLENT") is a label; the sentence is the point.
        const standing = $('lp-vscore-standing');
        if (standing) {
            // Split rather than one string, because the design file colours the tail of
            // the sentence and not a whole clause: "Excellent. You are ahead of" stays
            // white, "most agents." goes blue. Where to break is a judgement per
            // sentence, so each one carries its own break rather than a rule guessing.
            const [lead, tail] =
                overall == null   ? ['Working out where you stand.', '']
              : errored > 0       ? ['Part of your score could not be measured just now.', '']
              : overall >= 85     ? ['Excellent. You are ahead of ', 'most agents.']
              : overall >= 70     ? ['Strong. A few places left to ', 'tidy up.']
              : overall >= 50     ? ['Coming along. There is ', 'room to climb.']
              :                     ['Early days. The quickest ', 'wins are below.'];
            standing.innerHTML = escapeHtml(lead) + (tail ? `<em>${escapeHtml(tail)}</em>` : '');
        }

        if (gradeEl) {
            // An incomplete score gets no verdict. "EXCELLENT" computed from two of
            // three measures is the exact claim we cannot defend if a customer asks.
            if (overall == null || errored > 0) {
                gradeEl.style.display = 'none';
            } else {
                const label = overall >= 85 ? 'EXCELLENT'
                             : overall >= 70 ? 'GOOD'
                             : overall >= 50 ? 'FAIR'
                             : 'POOR';
                const mod = overall >= 70 ? ''
                          : overall >= 50 ? 'lp-vscore-grade--fair'
                          : 'lp-vscore-grade--poor';
                gradeEl.className = `lp-vscore-grade ${mod}`.trim();
                gradeEl.textContent = label;
                gradeEl.style.display = '';
            }
        }

        // Sub-bars: fill width plus the value text, or the named state when not a number.
        document.querySelectorAll('.lp-vscore-row').forEach(row => {
            const key = row.dataset.component;
            const v = key === 'aisearch' ? aiSearch
                    : key === 'coverage' ? coverage
                    : key === 'reviews'  ? reviews
                    : null;
            const fill = row.querySelector('.lp-vscore-fill');
            const val  = row.querySelector('.lp-vscore-value');
            if (fill) fill.style.width = (typeof v === 'number' ? Math.max(0, Math.min(100, v)) : 0) + '%';
            if (val) {
                // Naming the state is the fix. A bare dash reads as a zero the customer
                // earned, which is wrong for a metric their plan does not include and
                // wrong again for one that simply failed to load.
                val.textContent = typeof v === 'number' ? String(v)
                                : v === SCORE_NA   ? 'Not included'
                                : v === SCORE_ERR  ? 'Unavailable'
                                : v === SCORE_NONE ? 'None yet'
                                : '\u2026';
                val.classList.toggle('lp-vscore-value--muted', typeof v !== 'number');
            }
            row.classList.toggle('lp-vscore-row--inactive', typeof v !== 'number');
        });
    }

    function renderListingsStatus(data) {
        // Renders the full-width "All listings" card at the bottom of the
        // Dashboard tab: 5 summary tiles + scrollable table.
        //
        // Suppressed duplicates (from /listings/duplicates, IsDuplicate=true)
        // are excluded from both the table and the tile counts so HomePortal
        // mirrors Yext's "All Listings" view, which only shows the active
        // listing per publisher (each publisher row appears once).
        const allListings = (data && data.listings) || [];
        const listings    = allListings.filter(l => !l.isDuplicate);

        // Drive the Visibility Score sub-scores that come from listings data.
        // Coverage = % synced overall. Accuracy = avg of fieldAccuracyPct
        // across listings that have it (null when Yext doesn't report any
        // — typical without the premium scan add-on). AI Search = % of
        // AI-publisher rows that are live.
        if (listings.length > 0) {
            const liveCount = listings.filter(l => groupListingForUi(l) === 'synced').length;
            visibilityScoreState.coverage = Math.round((liveCount / listings.length) * 100);

            const ai = listings.filter(l => AI_SEARCH_PUBLISHER_IDS.indexOf((l.publisherId || '').toUpperCase()) >= 0);
            visibilityScoreState.aiSearch = ai.length > 0
                ? Math.round(ai.filter(l => groupListingForUi(l) === 'synced').length / ai.length * 100)
                : null;

            // The sub-score details. "89" is a number; "63 of 71 directories showing you"
            // is the same fact in terms the customer can check, which is the whole reason
            // the spec asks for a line under each bar.
            const liveN = listings.filter(l => groupListingForUi(l) === 'synced').length;
            setText('lp-sub-coverage', `${formatNumber(liveN)} of ${formatNumber(listings.length)} directories showing you`);

            const aiRows = listings.filter(l => AI_SEARCH_PUBLISHER_IDS.indexOf((l.publisherId || '').toUpperCase()) >= 0);
            const aiLive = aiRows.filter(l => groupListingForUi(l) === 'synced').length;
            setText('lp-sub-aisearch', aiRows.length === 0
                ? 'No AI or voice assistants carry you yet'
                : aiLive === ai.length
                    ? 'Gemini, Siri, Alexa and ChatGPT carry you'
                    : `${formatNumber(aiLive)} of ${formatNumber(aiRows.length)} AI and voice assistants carry you`);

            showEl('lp-score-section', true);
            storyState.status = { live: listings.filter(l => groupListingForUi(l) === 'synced').length,
                                  total: listings.length };
            storyState.listingRows = listings;
            renderStory();
        }
        renderVisibilityScore();

        // Sync the page header (account name + meta line) from the
        // authoritative Yext entity payload. The Razor server-render shows
        // the friendly DisplayName + entity ID as a fast first paint; once
        // /yext-listings resolves we overwrite both with name + address +
        // sign-up date + entity ID.
        applyEntityHeader(data && data.entity);
    }

    // Bucket a listing into one of Yext's four "All Listings" filter groups:
    // synced / not_synced / processing / opted_out. Suppressed duplicates
    // (l.isDuplicate=true) fold into "not_synced" to match Yext's UI — Yext
    // doesn't surface them as a separate top-level bucket. Status enum covers
    // both the /listings/listings enum (WAITING_ON_*, LIVE, UNAVAILABLE,
    // OPTED_OUT) and the /listings/entitylistings enum (SYNC_IN_PROGRESS,
    // NOT_SYNCED) so we don't have to care which endpoint the backend uses.
    function groupListingForUi(l) {
        if (l && l.isDuplicate) return 'not_synced';
        const s = (l && l.status || '').toUpperCase();
        if (s === 'LIVE') return 'synced';
        if (s === 'OPTED_OUT') return 'opted_out';
        if (s.startsWith('WAITING_ON_') || s === 'SYNC_IN_PROGRESS' || s === 'PENDING' || s === 'UPDATE_IN_PROGRESS') return 'processing';
        return 'not_synced';
    }

    // Map a listing to a Yext-style soft-tinted status pill: a slug for the
    // CSS class, a Font Awesome glyph, and a display label. Labels match
    // Yext's UI wording exactly (Synced / Not Synced / Processing / Opted Out
    // / Duplicate) rather than echoing the raw API enum like "Unavailable".
    function listingStatusBadge(l) {
        if (l && l.isDuplicate)     return { slug: 'duplicate',   icon: 'fa-copy',                label: 'Duplicate' };
        const group = groupListingForUi(l);
        if (group === 'synced')     return { slug: 'synced',      icon: 'fa-circle-check',        label: 'Synced' };
        if (group === 'opted_out')  return { slug: 'opted-out',   icon: 'fa-ban',                 label: 'Opted Out' };
        if (group === 'processing') return { slug: 'processing',  icon: 'fa-arrows-rotate',       label: 'Processing' };
        return                              { slug: 'not-synced', icon: 'fa-triangle-exclamation', label: 'Not Synced' };
    }

    // Render the publisher icon for a listing row. Prefers the backend-supplied
    // PublisherIconUrl (Yext catalog → favicon-service fallback chain — covers
    // all 72 publishers including AI/voice/map alternates). Falls back to a
    // Font Awesome brand glyph for the handful of publishers FA ships icons
    // for, and finally to a neutral globe so every row has a visual marker.
    function publisherIconHtml(l) {
        const label = escapeHtml(humanizePublisher(l && l.publisherId));
        if (l && l.publisherIconUrl) {
            return `<img src="${escapeHtml(l.publisherIconUrl)}" alt="" title="${label}" `
                 + `style="width:18px;height:18px;border-radius:var(--ae-radius-sm);object-fit:contain;" `
                 + `onerror="this.outerHTML='&lt;i class=\\'fa-solid fa-globe text-muted\\' style=\\'font-size:var(--ae-text-sm);\\'&gt;&lt;/i&gt;';">`;
        }
        return publisherBadge(l && l.publisherId);
    }

    // Update the account-card header (h5 name + meta paragraph) from the
    // entity summary returned by /yext-listings. The Razor view server-
    // renders fallback values (friendly DisplayName + bare entity ID) so
    // there's something on the page during the initial fetch; this then
    // replaces both with the canonical Yext-side values.
    //
    // Line 1: Yext entity name.
    // Line 2: "<address line 1>, <city/state/zip> · Signed up <date> · Entity ID: <id>"
    //         — any segment missing is dropped, joined by " · ".
    // LP subscription plan from Cosmos: "lite" / "boost" / "elite" / "".
    // Drives the per-card "Requires Boost" pill on cards whose feature
    // isn't part of the customer's plan tier. Empty string means
    // unknown (legacy asset) — we treat it as "no gating" so we never
    // false-positive a paying customer.
    let currentPlan = '';

    // Resolve a free-form plan string into a tier index. Mirrors the
    // server's GetPlanTierFuzzy: Asset.Plan can be stored as "lite",
    // "LP_lite", "Local Presence Lite", "local_presence_lite", etc., so
    // we substring-match after lowercasing. Order matters: check "elite"
    // first because "elite".includes("lite") is true and we don't want
    // an Elite user gated as Lite.
    function resolvePlanTier(plan) {
        const p = (plan || '').toLowerCase();
        if (!p)                  return -1;  // unknown — no gating
        if (p.includes('elite')) return 2;
        if (p.includes('boost')) return 1;
        if (p.includes('lite'))  return 0;
        return -1;
    }

    // Which cards need the "Requires Boost" pill at the given plan tier.
    // Reviews and All Reviews are Boost+ features — Lite (tier 0) users
    // see the tip card with the pill instead of the data card.
    function cardIsGatedForPlan(cardKey, plan) {
        const tier = resolvePlanTier(plan);
        if (tier === 0) { // Lite
            return cardKey === 'reviews' || cardKey === 'recent-reviews';
        }
        return false;
    }

    // ===== Boost-gated frosted-glass previews =========================
    // Lite tenants see the real card filled with ideal sample data, blurred,
    // with a centered Upgrade overlay — so the upsell shows exactly what the
    // feature unlocks instead of an empty/text-only tip card. The sample data
    // is decorative only and never feeds the LP Score or any real metric.

    // Toggle the frosted overlay + blur on a gated card. The overlay is a
    // sibling of .card-body (so it stays sharp while the data blurs) and is
    // injected lazily the first time a card is gated.
    function setCardGated(colId, on, opts) {
        const col = $(colId);
        if (!col) return;
        // Either card shape. The rebuilt sections use .lp-story-card and the surviving
        // ones .lp-section-card, and the overlay is identical on both, so the lookup
        // widened rather than the markup being forced to match.
        const card = col.querySelector('.lp-section-card, .lp-story-card')
                  || (col.classList.contains('lp-story-card') ? col : null);
        if (!card) return;
        let overlay = card.querySelector('.lp-gate-overlay');
        if (on) {
            card.classList.add('lp-gated');
            if (!overlay) {
                const compact = !!(opts && opts.compact);
                overlay = document.createElement('div');
                overlay.className = 'lp-gate-overlay' + (compact ? ' lp-gate-overlay--compact' : '');
                overlay.innerHTML = compact
                    ? '<div class="lp-gate-overlay__icon"><i data-lucide="lock"></i></div>'
                      + '<div class="lp-gate-overlay__title">Boost feature</div>'
                    : '<div class="lp-gate-overlay__icon"><i data-lucide="lock"></i></div>'
                      + '<div class="lp-gate-overlay__title">Unlock this with Local Presence Boost</div>'
                      + '<div class="lp-gate-overlay__sub">See your real review trends, ratings, and feedback from every publisher in one place.</div>'
                      + '<a href="/Marketplace?type=local_presence" data-ae-upgrade="local_presence" data-ae-label="Local Presence" class="btn btn-sm lp-upgrade-btn ae-upgrade-cta"><i class="me-2" data-lucide="trending-up"></i>Upgrade to Boost</a>';
                card.appendChild(overlay);
            }
        } else {
            card.classList.remove('lp-gated');
            if (overlay) overlay.remove();
        }
    }




    function applyEntityHeader(entity) {
        if (!entity) return;
        const nameEl = $('lp-account-name');
        const metaEl = $('lp-account-meta');
        // Only rewrite the title from the Yext name when the user hasn't
        // overridden it via "Edit display name" — otherwise the server-
        // rendered custom name stays. Same priority applies to the matching
        // option in the asset-selector dropdown so the two stay in sync.
        if (entity.name && !hasCustomDisplayName) {
            // title as well as text: the heading is cut with an ellipsis when it runs
            // past the space the reserved switcher column leaves it, and the tooltip is
            // where the rest of the name lives. Setting one without the other leaves the
            // hover showing whatever the server rendered before this overwrote it.
            if (nameEl) { nameEl.textContent = entity.name; nameEl.title = entity.name; }
            const selector = $('lpAssetSelector');
            if (selector) {
                const opt = selector.querySelector(`option[value="${currentAssetId}"]`);
                if (opt) opt.textContent = entity.name;
            }
        }
        if (!metaEl) return;

        const segments = [];
        if (entity.cityStateZip) segments.push(entity.cityStateZip);
        if (entity.createdAt) {
            const d = new Date(entity.createdAt);
            if (!isNaN(d.getTime())) {
                segments.push(`Active since ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`);
            }
        }
        // The Yext entity id is deliberately not here. It is an internal vendor
        // reference the customer cannot use for anything, and it sat in the one
        // line under their own business name. Staff who need it have the admin
        // vendor tag on the row below.
        metaEl.textContent = segments.join(' · ');
    }

    function humanizePublisher(id) {
        if (!id) return 'Unknown';
        // GOOGLEMYBUSINESS → "Google My Business"; APPLE → "Apple"; etc.
        return id.toLowerCase()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .replace(/Googlemybusiness/i, 'Google My Business');
    }

    // Map a Yext publisherId to a Font Awesome icon. Returns null when nothing
    // matches; publisherBadge then falls back to a generic icon (NOT the
    // publisher name, which is rendered separately by the caller and would
    // otherwise appear twice).
    function publisherIcon(id) {
        if (!id) return null;
        const u = id.toUpperCase();
        // Order matters: more specific tokens (UBEREATS, UBERFREIGHT) must
        // be checked before the looser "includes('UBER')" rule below.
        if (u === 'GOOGLEMYBUSINESS' || u.includes('GOOGLE')) return { icon: 'fa-brands fa-google',       color: '#4285F4', label: 'Google' };
        if (u === 'INSTAGRAM')                                 return { icon: 'fa-brands fa-instagram',    color: '#E4405F', label: 'Instagram' };
        if (u.includes('FACEBOOK') || u === 'META' || u === 'METAPLACESGRAPH')
                                                               return { icon: 'fa-brands fa-facebook',     color: '#1877F2', label: 'Facebook' };
        if (u.includes('YELP'))                                return { icon: 'fa-brands fa-yelp',         color: '#D32323', label: 'Yelp' };
        if (u.includes('TRIPADVISOR'))                         return { icon: 'fa-brands fa-tripadvisor',  color: '#00AA6C', label: 'Tripadvisor' };
        if (u.includes('APPLE') || u === 'SIRI')               return { icon: 'fa-brands fa-apple',        color: '#000000', label: 'Apple' };
        if (u.includes('BING'))                                return { icon: 'fa-brands fa-microsoft',    color: '#00A4EF', label: 'Bing' };
        if (u.includes('FOURSQUARE'))                          return { icon: 'fa-brands fa-foursquare',   color: '#F94877', label: 'Foursquare' };
        if (u.includes('YAHOO'))                               return { icon: 'fa-brands fa-yahoo',        color: '#6001D2', label: 'Yahoo' };
        if (u === 'TIKTOK')                                    return { icon: 'fa-brands fa-tiktok',       color: '#000000', label: 'TikTok' };
        if (u === 'SNAPCHAT')                                  return { icon: 'fa-brands fa-snapchat',     color: '#FFFC00', label: 'Snapchat' };
        if (u === 'WAZE')                                      return { icon: 'fa-brands fa-waze',         color: '#33CCFF', label: 'Waze' };
        if (u === 'GEMINI')                                    return { icon: 'fa-solid fa-gem',           color: '#4285F4', label: 'Gemini' };
        if (u === 'ALEXA' || u === 'AMAZONALEXA' || u === 'AMAZON')
                                                               return { icon: 'fa-brands fa-amazon',       color: '#FF9900', label: 'Amazon' };
        if (u === 'OPENAI')                                    return { icon: 'fa-solid fa-robot',         color: '#10A37F', label: 'OpenAI' };
        if (u.includes('UBER'))                                return { icon: 'fa-brands fa-uber',         color: '#000000', label: 'Uber' };
        if (u === 'POSTMATES')                                 return { icon: 'fa-solid fa-bicycle',       color: '#000000', label: 'Postmates' };
        if (u === 'INSTACART')                                 return { icon: 'fa-solid fa-cart-shopping', color: '#43B02A', label: 'Instacart' };
        if (u === 'NEXTDOOR')                                  return { icon: 'fa-solid fa-house',         color: '#00B551', label: 'Nextdoor' };
        if (u === 'BRAVE')                                     return { icon: 'fa-solid fa-shield-halved', color: '#FB542B', label: 'Brave' };
        if (u === 'YANDEX' || u === 'YANGO')                   return { icon: 'fa-solid fa-y',             color: '#FFCC00', label: 'Yandex' };
        if (u === 'HERE')                                      return { icon: 'fa-solid fa-location-dot',  color: '#48DAD0', label: 'HERE' };
        if (u === 'MAPBOX' || u === 'MAPQUEST' || u === 'TOMTOM' || u === 'NAVMII')
                                                               return { icon: 'fa-solid fa-map',           color: '#3B82F6', label: 'Maps' };
        return null;
    }

    function publisherBadge(id) {
        const meta = publisherIcon(id);
        if (meta) {
            return `<i class="${meta.icon}" style="color: ${meta.color}; font-size: var(--ae-text-base);" title="${escapeHtml(meta.label)}" aria-label="${escapeHtml(meta.label)}"></i>`;
        }
        // Generic fallback: a neutral globe icon so every row has a visual
        // marker. The publisher name is rendered separately by the caller —
        // returning the name here too would cause it to appear twice.
        const label = escapeHtml(humanizePublisher(id));
        return `<i data-lucide="globe" style="color: #6c757d; font-size: var(--ae-text-sm);" title="${label}" aria-label="${label}"></i>`;
    }

    function humanizeStatus(s) {
        if (!s) return '';
        return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }

    // The reference card names what is missing rather than only counting it: "One
    // field, TikTok, stands between you and a complete local profile." A name is
    // something the customer can act on, where a bare count only tells them to go
    // looking for it. Yext's labels are already written for a reader ("TikTok",
    // "Hours of operation", "Main phone"), so they drop into a sentence unedited.
    //
    // Past three the list stops being a sentence and becomes an inventory, so it falls
    // back to the count, which is the form the design system's own ProgressMeter
    // example uses ("Just 7 fields stand between you and...").
    const COUNT_WORDS = ['', 'One', 'Two', 'Three'];

    function missingFieldsSentence(fields) {
        const count = fields.length;
        const verb  = count === 1 ? 'stands' : 'stand';
        const tail  = `${verb} between you and a complete local profile.`;
        const names = fields.map(f => f && f.label).filter(Boolean);

        // Falls back whenever the list is too long to read, or when any entry arrived
        // without a label, since a sentence with a gap in it is worse than a count.
        if (count === 0 || count > 3 || names.length !== count) {
            return `Just ${count} field${count === 1 ? '' : 's'} ${tail}`;
        }

        const list = names.length === 1
            ? names[0]
            : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
        return `${COUNT_WORDS[count]} field${count === 1 ? '' : 's'}, ${list}, ${tail}`;
    }

    function renderProfileHealth(data) {
        const pct = Math.round(data.completenessPct || 0);
        const missingFields = data.missingFields || [];
        const count = missingFields.length;

        // A complete profile has nothing to ask for, so the whole card goes away rather
        // than sitting at the top of the dashboard congratulating itself above the
        // analytics the customer actually came for.
        //
        // Nothing is remembered and nothing needs to be: this runs against a fresh
        // profile-health response on every load and every range change, so the card
        // returns by itself the moment a field goes missing again.
        //
        // Both halves of the test are kept deliberately. The server derives the
        // percentage as (total - missing) / total, so 100% and an empty missing list
        // are the same condition and cannot disagree. But `pct` is rounded here, so a
        // 99.x would read as 100 while a field is genuinely still missing. Requiring
        // the list to be empty too means a rounding artefact can never hide a card that
        // still has something to say.
        if (pct >= 100 && count === 0) {
            showEl('lp-profile-section', false);
            return;
        }

        // Big percentage + milestone progress bar (Start → Complete).
        setText('lp-profile-pct', `${pct}%`);
        showEl('lp-profile-section', true);
        // Width only. The colour belongs to .ae-meter-fill, which paints
        // --ae-progress-fill (amber) at every value, because in this system amber marks
        // progress rather than a warning. This used to override it to green at 80 and
        // had gone red under 50 before that, inventing a severity scale the
        // ProgressMeter component does not have. The percentage beside the bar and the
        // named fields below carry the precision those colour changes were reaching for.
        const barFill = $('lp-ph-bar-fill');
        if (barFill) barFill.style.width = `${pct}%`;

        // Motivating rail copy — tone scales with how complete the profile is. There is
        // no "you're done" arm any more, because the card does not survive being done.
        // The 90 band is the reference card's own state: at 96% with one field left it
        // reads "You're almost there.", which 80-and-up copy cannot say.
        setText('lp-ph-headline',
              pct >= 90  ? "You're almost there."
            : pct >= 80  ? "You're ahead of most agents."
            : pct >= 50  ? "You're well on your way."
            :              "Let's strengthen your profile.");
        setText('lp-ph-subcopy', missingFieldsSentence(missingFields));

        // The button keeps its markup label. It only ever renders while fields are
        // outstanding now, so "Finish in settings" is always the honest ask.

        // The grouped missing-fields panel and the complete callout went with the old
        // split-rail card. The spec's card carries the remainder as one counted sentence
        // in the sub line above, which is the "exactly what remains, counted" it asks for,
        // so there is nothing further to paint here.
    }

    // ===== Helpers =====================================================

    // xTicks is the second argument because the reviews card wants three date ticks and
    // everything else wants six. Passing it as an ignored extra, which is what the first
    // attempt did, leaves the caller believing it asked for something it did not get.
    function commonLineOptions(scaleOpts, xTicks) {
        // Merge caller-supplied ticks with the muted-axis defaults instead
        // of replacing them outright. Lets callers pass `{ precision: 0 }`
        // (integer y-axis) without losing the default font/color styling.
        const sOpts = scaleOpts || { beginAtZero: true };
        // 12.5px, which is the reference's axis size. Only the reviews chart runs
        // through here, so this is that card's axis and nothing else's.
        const yTicks = { font: { size: 12.5 }, color: CHART_COLOR_MUTED, ...(sOpts.ticks || {}) };
        const { ticks: _drop, ...sRest } = sOpts;
        return {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { maxTicksLimit: 6, font: { size: 12.5 }, color: CHART_COLOR_MUTED, ...(xTicks || {}) } },
                y: { ...sRest, ticks: yTicks },
            },
        };
    }

    function upsertChart(key, canvasId, config) {
        if (typeof Chart === 'undefined') return;
        const canvas = $(canvasId);
        if (!canvas) return;
        if (charts[key]) {
            charts[key].data = config.data;
            charts[key].options = config.options;
            charts[key].update();
        } else {
            charts[key] = new Chart(canvas.getContext('2d'), config);
        }
    }

    function formatPct(v)    { return `${Math.round(v || 0)}%`; }
    function formatNumber(v) { return (v || 0).toLocaleString(); }
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ===== Top-level loader ============================================

    // What each range value should read as on a card. Keyed by the same values the
    // toolbar buttons carry, so a new button needs one entry here and nothing else.
    const RANGE_LABELS = {
        '30d':  'Last 30 days',
        '180d': 'Last 6 months',
        '365d': 'Last 12 months',
    };

    function applyWindowLabels(range) {
        const label = RANGE_LABELS[range] || 'Selected period';
        document.querySelectorAll('[data-lp-window]').forEach(el => { el.textContent = label; });
    }

    function loadMetrics(range) {
        if (!currentAssetId) return;
        applyWindowLabels(range || DEFAULT_RANGE);
        storyState.range = range || DEFAULT_RANGE;

        // Each job owns one fetch and the render that consumes it. Every one of these
        // renders decides its own section's visibility from the data it gets, which is
        // why there is no longer a cols list here: it named lp-col-* wrappers that went
        // with the cards the rebuild retired, and nothing read it any more.
        const jobs = [
            { key: 'listings', cat: 'listings',       render: renderListings },
            { key: 'reviews',  cat: 'reviews',        render: renderReviews },
            { key: 'search',   cat: 'search',         render: renderSearch },
            { key: 'profile',  cat: 'profile-health', render: renderProfileHealth },
        ];
        const recentReviewsCol = 'lp-col-recent-reviews';

        // The loading state is the placeholders in the markup, cleared below once the
        // fetches settle. What used to stand here called setSectionState and
        // showDataAndTip, both of which addressed lp-metric-* and lp-col-* ids that
        // went with the retired cards, so the page had a loading state that wrote to
        // nothing and a blank tab is what the customer got.
        const pending = [];
        let failed = 0;

        // Clear the score components before a refresh so a stale "Unavailable" from the
        // previous range cannot survive into a run that succeeded.
        visibilityScoreState.coverage = null;
        visibilityScoreState.reviews  = null;
        visibilityScoreState.aiSearch = null;

        jobs.forEach(job => {
            // Boost-gated cards skip the fetch entirely and show the frosted
            // sample preview (ideal data, blurred, with an Upgrade overlay).
            if (job.key === 'reviews' && cardIsGatedForPlan('reviews', currentPlan)) {
                renderReviewsGatedPreview();
                // Not a gap in their performance, so it must not drag the score down
                // or sit there as an unexplained empty bar. The gauge drops it from
                // the denominator and the bar reads "Not included".
                visibilityScoreState.reviews = SCORE_NA;
                renderVisibilityScore();
                return;
            }
            pending.push(fetchCategory(job.cat, range)
                .then(data => job.render(data))
                .catch(err => {
                    console.warn(`Failed to load ${job.cat} analytics:`, err);
                    failed++;
                    if (job.key === 'reviews') {
                        visibilityScoreState.reviews = SCORE_ERR;
                        renderVisibilityScore();
                    }
                }));
        });

        // Listings status from the Listings API (authoritative per-publisher state).
        // Overlays the publisher table that the analytics-driven renderListings populates first.
        // Attribution rides alongside rather than inside renderListings: it is our data, on
        // its own endpoint, and a failure to answer it must not cost the customer the
        // Yext-backed figure it annotates.
        fetchUpdateAttribution(range)
            .then(data => renderUpdateAttribution(data))
            .catch(err => console.warn('Failed to load update attribution:', err));

        pending.push(fetchListingsStatus()
            .then(data => renderListingsStatus(data))
            .catch(err => {
                console.warn('Failed to load listings status:', err);
                failed++;
                // Coverage and AI Search both derive from this one call, so a failure
                // here takes out two thirds of the score. Saying so beats printing a
                // confident number built from the one measure that answered.
                visibilityScoreState.coverage = SCORE_ERR;
                visibilityScoreState.aiSearch = SCORE_ERR;
                renderVisibilityScore();
            }));

        // allSettled, not all: one failed category must still clear the placeholders,
        // or a single outage leaves the whole tab spinning behind a state that will
        // never resolve.
        Promise.allSettled(pending).then(() => {
            // Every section decides its own visibility from its own data, so "did
            // anything render" is the only honest test of whether the page has
            // something to say. If one did, the placeholders have done their job.
            const anyVisible = Array.from(document.querySelectorAll('.lp-story'))
                .some(el => el.style.display !== 'none');
            if (anyVisible) { clearSkeleton(); return; }

            // An outage and a genuinely quiet period both end with a blank page, and
            // they are not the same fact. Saying the wrong one is how a vendor
            // problem gets read as "my listings did nothing".
            skeletonMessage(failed > 0
                ? ERROR_COPY
                : 'Nothing to show for this period yet.');
        });

        // Recent reviews content (separate Yext endpoint). refetchRecentReviews
        // honors the per-card "All time" override so changing the global
        // range only refreshes this card when the user hasn't overridden it.
        currentRange = range || DEFAULT_RANGE;
        refetchRecentReviews();
    }

    function init(assetId, options) {
        currentAssetId = assetId;
        hasCustomDisplayName = !!(options && options.hasCustomName);
        currentPlan = (options && options.plan) ? String(options.plan).toLowerCase() : '';
        // Debug aid: visible in DevTools so we can confirm the plan flag
        // reached the renderer. Remove once gating is confirmed working.
        console.info('LpMetrics init — assetId:', assetId, 'plan:', currentPlan, 'tier:', resolvePlanTier(currentPlan));
        if (typeof Chart === 'undefined') {
            console.warn('Chart.js not loaded; LP metrics will render KPI numbers only.');
        }

        // Default analytics window — 1 year. The toolbar below the overview
        // row lets the user switch to 30 days / 6 months on demand. Shorter
        // windows (7/90 days) were dropped because they tend to show too
        // little activity for typical agents to draw useful conclusions.
        // DEFAULT_RANGE is module-level (see the top of this file) so loadMetrics
        // and the label helper can both read it.

        // Wire the date-range segmented control: clicking a button updates
        // the active highlight and re-runs loadMetrics with the new range.
        // The overview-row cards (LP Score, Where You Appear) are snapshot
        // data, so re-fetching is harmless — only the time-windowed cards
        // visibly change.
        document.querySelectorAll('.lp-range-btn[data-range]').forEach(btn => {
            btn.addEventListener('click', () => {
                // is-active, not active: that is the class .ae-segmented styles, and the
                // selected segment now comes from the design system rather than a local rule.
                document.querySelectorAll('.lp-range-btn[data-range]').forEach(b => b.classList.remove('is-active'));
                btn.classList.add('is-active');
                currentRange = btn.dataset.range || DEFAULT_RANGE;
                loadMetrics(currentRange);
            });
        });

        // The kinds-of-places panel. Click to open, click again or Escape to close, per
        // the spec: never hover, because a hover panel is unusable on touch and fiddly
        // for the audience this page is built for.
        const whereToggle = $('lp-where-toggle');
        const wherePanel  = $('lp-where-panel');
        if (whereToggle && wherePanel) {
            const setOpen = (open) => {
                wherePanel.hidden = !open;
                whereToggle.setAttribute('aria-expanded', String(open));
            };
            whereToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                setOpen(wherePanel.hidden);
            });
            document.addEventListener('click', (e) => {
                if (!wherePanel.hidden && !wherePanel.contains(e.target) && e.target !== whereToggle) setOpen(false);
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !wherePanel.hidden) { setOpen(false); whereToggle.focus(); }
            });
        }

        loadMetrics(DEFAULT_RANGE);
    }

    // Expose for the inline LP script.
    window.LpMetrics = { init };
})();
