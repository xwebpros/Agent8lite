/* =====================================================================
   Billing tab behaviour: menus, invoice expansion, modals, the cancellation
   save flow, grace countdown and toasts.

   The save flow carries NO copy and NO rules here. It renders what
   GET /api/billing/save-flow/{assetId} returns and posts back only which offer
   the customer accepted; the wording lives in SaveFlowCatalog.cs plus the AE Admin
   copy overlay, and the server decides what each offer does and whether it is
   available at all. See Services/CancellationSaveFlow.cs.

   Wiring status (flag Features:SelfServiceBilling gates the server side):
     â¢ Cancel product .......... LIVE  â POST /api/billing/cancel-product
     â¢ Save flow (offers) ...... GET  /api/billing/save-flow/{assetId}
                                POST /api/billing/save-flow/accept
     â¢ Change payment method ... LIVE  â Stripe Customer Portal (/Billing?handler=PortalUrl)
     â¢ Relaunch / Undo ......... POST /api/billing/relaunch-product   (Slice 2)
     â¢ Add additional .......... LIVE  â POST /api/marketplace/checkout (add-on flow)
     â¢ Switch to annual / cycle  POST /api/billing/switch-cycle       (Slice 5)
     â¢ Change plan tier ........ POST /api/billing/change-tier        (later)
     â¢ Edit billing contact .... PUT  /api/billing/contact            (later)
   Endpoints not built yet degrade to an honest "coming soon" message, no
   action ever fakes success.
   ===================================================================== */
(function () {
  'use strict';
  // Root carries the data-bp-* attributes. The panel now lives inside the Account Settings
  // "Billing" tab as the .bp-shell rendered by the BillingPanel view component.
  const pane = document.querySelector('.bp-shell');
  if (!pane) return;

  // Render the design's Lucide icons (line-style) that are server-rendered as <i data-lucide>.
  function drawIcons() { try { window.lucide && window.lucide.createIcons(); } catch (e) {} }
  drawIcons();

  // Returning from the Stripe portal (card may have changed) â reconcile the synced billing box so the
  // site-wide banner isn't stale. Fire-and-forget, then strip the marker from the URL.
  (function () {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('billing_refresh') === '1') {
        fetch('/api/billing/refresh', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
        q.delete('billing_refresh');
        var url = location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash;
        if (history.replaceState) history.replaceState(null, '', url);
      }
    } catch (e) {}
  })();

  const overlay = document.getElementById('bpOverlay');
  const modalEl = document.getElementById('bpModal');
  const toastEl = document.getElementById('bpToast');
  const toastMsg = document.getElementById('bpToastMsg');
  const enabled = pane.getAttribute('data-bp-enabled') === 'true';

  let toastTimer = null;
  function toast(msg) {
    toastMsg.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2800);
  }

  // Back from Stripe Checkout after a tier upgrade. The webhook does the actual subscription-item
  // swap, and it may not have landed by the time Stripe bounces the customer here â so the copy
  // promises the payment (which definitely happened) rather than the new tier, then reloads once to
  // pick up the swap. The marker is stripped BEFORE the reload so this can't loop.
  (function () {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('success') !== 'true') return;
      q.delete('success');
      var url = location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash;
      if (history.replaceState) history.replaceState(null, '', url);
      toast('Payment received. Your new plan is being appliedâ¦');
      fetch('/api/billing/refresh', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
      holdThenReload(2600, 'Finishing your upgradeâ¦');
    } catch (e) {}
  })();

  function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // `cls` is an optional modifier on .bp-modal (the upgrade picker is wider and lays its own
  // sections out edge to edge). Existing single-argument callers are unaffected.
  function openModal(html, cls) {
    // A modal that is not part of the cancel walk has taken the overlay over, so the walk is finished
    // whatever else happens: its screens are gone and the customer will never reach its exit. Settling it
    // here rather than waiting for closeModal is what stops the NEXT unrelated modal's close being
    // recorded as an abandonment of a cancellation the customer left several screens ago.
    if (!openingWalkScreen) endWalk('abandoned');
    openingWalkScreen = false;

    modalEl.className = 'bp-modal' + (cls ? ' ' + cls : '');
    modalEl.innerHTML = html;
    // The switch confirmation is the one modal that becomes a bottom sheet on a phone, and the overlay
    // has to know: the sheet is flush to the bottom edge, which is the overlay's padding, not the
    // dialog's. Set here so both paints of that modal (its placeholder and its content) carry it.
    overlay.classList.toggle('bp-overlay--sheet', (cls || '').indexOf('bp-modal--switch') !== -1);
    overlay.hidden = false;
    drawIcons();
  }

  // Set for exactly one openModal call, by the renders that ARE the cancel walk. A one-shot marker
  // rather than an argument threaded through a dozen call sites, and rather than a flag somebody has to
  // remember to clear: openModal consumes it on every path, so forgetting it can only ever end a walk
  // early, never leave a dead one live.
  let openingWalkScreen = false;
  function openWalkModal(html, cls) {
    openingWalkScreen = true;
    openModal(html, cls);
  }
  // Bumped on every close. An async flow that was mid-await when the customer pressed Escape or clicked
  // the overlay compares its own token before painting, so a dismissed modal cannot reappear.
  let modalEpoch = 0;
  // Undoes whatever the open modal did to the page around it (focus, body scroll, key handlers). Set by
  // dialogSemantics, cleared here, so nothing a modal switched on can outlive it.
  let modalCleanup = null;
  function closeModal() {
    modalEpoch++;
    if (modalCleanup) { try { modalCleanup(); } catch (e) {} modalCleanup = null; }
    // The customer closed the cancel modal without accepting an offer and without going through with
    // the cancellation. That is its own outcome, and it is the one the server can never witness: every
    // other step leaves a request behind, this one leaves nothing. Recorded here, before the context is
    // cleared, because there is no later moment to do it in.
    endWalk('abandoned');
    overlay.hidden = true; modalEl.innerHTML = ''; modalEl.className = 'bp-modal';
    overlay.classList.remove('bp-overlay--sheet');
  }

  // Makes the open modal a real dialog for anyone not using a mouse: named by its own heading, holding
  // focus while it is up, and returning focus to whatever opened it. Escape and the backdrop already
  // close it; this adds what they cannot.
  //
  // Applied per modal rather than inside openModal, because it also locks page scroll behind the
  // dialog, and that is a change to the page every other billing modal has shipped without.
  function dialogSemantics(titleId, descId) {
    const opener = document.activeElement;
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    if (titleId) modalEl.setAttribute('aria-labelledby', titleId);
    if (descId) modalEl.setAttribute('aria-describedby', descId);
    modalEl.setAttribute('tabindex', '-1');
    modalEl.focus();

    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Tab stays inside the dialog. Without it the next Tab lands on the page behind, which is still
    // there, still scrollable by keyboard, and about to be replaced.
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
    function onKey(e) {
      if (e.key !== 'Tab') return;
      const items = Array.from(modalEl.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);

    modalCleanup = function () {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = bodyOverflow;
      modalEl.removeAttribute('role'); modalEl.removeAttribute('aria-modal');
      modalEl.removeAttribute('aria-labelledby'); modalEl.removeAttribute('aria-describedby');
      modalEl.removeAttribute('tabindex');
      if (opener && typeof opener.focus === 'function') { try { opener.focus(); } catch (e) {} }
    };
  }

  // The tab, the window or a navigation away, which closeModal never sees. Without this a customer who
  // gives up by closing the tab leaves no ending at all, and the walk lands in the report's "never
  // finished a step" column: honest, but it lumps a real abandonment in with our own dropped requests.
  // pagehide rather than beforeunload, because beforeunload does not fire reliably on mobile Safari,
  // which is where a browser session is most likely to end this way.
  window.addEventListener('pagehide', () => endWalk('abandoned'));

  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) closeModal(); });

  // ââ busy state ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // A money mutation takes about a second and then reloads. For that second nothing moved, which
  // customers read as "it didn't work", so they click again - and a second click is a second Stripe
  // mutation, not a retry of the first. These two helpers are the whole answer: say the work started,
  // and stop the stale page being clickable until it is replaced.

  // Puts the confirm button into a spinner + label state and locks the rest of the modal, so the
  // secondary button and the X cannot fire while a mutation is in flight either.
  function busy(label, selector) {
    const btn = modalEl.querySelector(selector || '[data-bp-confirm]');
    if (btn) {
      btn.innerHTML = '<span class="bp-spin"></span><span>' + esc(label) + '</span>';
      btn.disabled = true;
      btn.style.opacity = '.75';
      btn.style.cursor = 'progress';
    }
    modalEl.querySelectorAll('[data-bp-close]').forEach(b => { b.disabled = true; b.style.opacity = '.5'; });
    // Fields too. The type-to-confirm box drives the primary button's own disabled state as it is typed
    // in, so leaving it live would let an edit made while the cancellation is already in flight hand the
    // spinner back to a button that looks pressable again.
    modalEl.querySelectorAll('input,textarea,select').forEach(f => { f.disabled = true; });
    return btn;
  }

  // Covers the page until the reload lands. Without this there is a window between "modal closed,
  // toast shown" and "page replaced" where every stale row still looks clickable.
  function holdThenReload(ms, label) {
    let veil = document.getElementById('bpVeil');
    if (!veil) {
      veil = document.createElement('div');
      veil.id = 'bpVeil';
      veil.className = 'bp-veil';
      veil.setAttribute('role', 'status');
      veil.setAttribute('aria-live', 'polite');
      document.body.appendChild(veil);
    }
    veil.innerHTML = '<span class="bp-spin"></span><span>' + esc(label || 'Updating your planâ¦') + '</span>';
    veil.hidden = false;
    setTimeout(() => window.location.reload(), ms);
  }

  // POST helper. Returns { ok, status, data }. Never throws.
  async function post(url, body, method) {
    try {
      const res = await fetch(url, {
        method: method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: body ? JSON.stringify(body) : undefined
      });
      let data = null; try { data = await res.json(); } catch (_) {}
      return { ok: res.ok, status: res.status, data };
    } catch (_) {
      return { ok: false, status: 0, data: null };
    }
  }

  // GET helper. Same contract as post(): { ok, status, data }, never throws. Times out rather than
  // leaving a caller awaiting forever, which on the cancel path meant a modal stuck on its placeholder.
  async function getJson(url, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 12000);
    try {
      const res = await fetch(url, { credentials: 'same-origin', signal: ctl.signal });
      let data = null; try { data = await res.json(); } catch (_) {}
      return { ok: res.ok, status: res.status, data };
    } catch (_) {
      return { ok: false, status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  // Honest degrade for endpoints not yet deployed / feature not enabled.
  function handleResult(r, okMsg, comingSoonLabel) {
    if (r.ok) { toast((r.data && r.data.message) ? r.data.message : okMsg); return true; }
    // The server's message always wins when there is one. 404/403 used to be rewritten to
    // "will be available shortly" unconditionally, which threw away real guidance (for example
    // "we couldn't find an active subscription, please contact support") and told the customer a
    // built feature was unbuilt. Only fall back to that when the server said nothing.
    if (r.data && r.data.error) { toast(r.data.error); return false; }
    if (r.status === 404 || r.status === 403) { toast((comingSoonLabel || 'This') + ' will be available shortly.'); return false; }
    toast('Something went wrong. Please try again.');
    return false;
  }

  // ââ Menus ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  function closeMenus() { pane.querySelectorAll('.bp-menu').forEach(m => m.hidden = true); }
  pane.addEventListener('click', e => {
    const btn = e.target.closest('.bp-menu-btn');
    if (btn) {
      const menu = btn.parentElement.querySelector('.bp-menu');
      const wasHidden = menu.hidden;
      closeMenus();
      menu.hidden = !wasHidden;
      if (!menu.hidden) flipMenuIfClipped(btn, menu);
      e.stopPropagation();
    }
  });

  // Opens upward when there is no room below.
  //
  // The menu is taller than it was: Change Plan and Keep my plan can both be present, and the last row
  // of a long products table sits near the fold. Measured after it is visible, because a hidden
  // element has no height to measure, and reset first so a menu that flipped once does not stay
  // flipped when the page is scrolled and it opens again with room to spare.
  function flipMenuIfClipped(btn, menu) {
    menu.classList.remove('bp-menu--up');
    const room = window.innerHeight - btn.getBoundingClientRect().bottom;
    if (room < menu.offsetHeight + 16) menu.classList.add('bp-menu--up');
  }
  document.addEventListener('click', e => { if (!e.target.closest('.bp-menu-root')) closeMenus(); });

  // ââ Tabs (Overview / Invoices / Payment) âââââââââââââââââââââââââââ
  pane.querySelectorAll('.bp-tab').forEach(tab => tab.addEventListener('click', () => {
    const name = tab.getAttribute('data-bp-tab');
    pane.querySelectorAll('.bp-tab').forEach(t => t.classList.toggle('active', t === tab));
    pane.querySelectorAll('.bp-pane').forEach(p => { p.hidden = p.getAttribute('data-bp-pane') !== name; });
    closeMenus();
  }));

  // ââ Invoice expansion ââââââââââââââââââââââââââââââââââââââââââââââ
  pane.addEventListener('click', e => {
    const inv = e.target.closest('[data-bp-inv-toggle]');
    if (!inv) return;
    const detail = inv.parentElement.querySelector('.bp-inv-detail');
    const chev = inv.querySelector('.bp-inv-chev');
    if (detail) {
      detail.hidden = !detail.hidden;
      // The chevron is now a Lucide SVG â rotate it rather than swapping FontAwesome classes.
      if (chev) { chev.style.transition = 'transform .15s'; chev.style.transform = detail.hidden ? '' : 'rotate(180deg)'; }
    }
  });

  // ââ Action dispatch ââââââââââââââââââââââââââââââââââââââââââââââââ
  pane.addEventListener('click', e => {
    const el = e.target.closest('[data-bp-action]');
    if (!el) return;
    closeMenus();
    const a = el.getAttribute('data-bp-action');
    const d = el.dataset;
    switch (a) {
      case 'view': openDetails(d.bpName, d.bpDetails); break;
      case 'payment': openPaymentModal(); break;
      case 'concierge': window.location.href = '/tickets'; break;
      case 'contact': openContact(); break;
      case 'cycle': openCycle(); break;
      case 'annual': openCycleSwitch('annual'); break;
      case 'twoyear': openCycleSwitch('two_year'); break;
      // Deliberately NOT openCycleSwitch. This row exists because the price could not be resolved, so
      // the switch would refuse; it opens a prefilled ticket instead. The term goes in the subject so
      // the queue can see what was asked for without opening it.
      case 'cycle-enquiry': {
        // The server always sets the term. The fallback is only so a missing attribute degrades to a
        // sentence rather than to "Moving to  billing".
        const term = d.bpTerm ? d.bpTerm + ' billing' : 'a longer billing term';
        window.location.href = '/tickets/Create?' + new URLSearchParams({
          category: 'Billing Question',
          title: 'Moving to ' + term,
          description: "I'd like to look at paying for " + term
            + ' instead of monthly. Please let me know what my options are.'
        });
        break;
      }
      case 'change-plan': openPlanChange(d); break;
      case 'keep-plan': openKeepPlan(d); break;
      case 'add': openAdd(d.bpName, d.bpType, d.bpPriceId, d.bpPlan, d.bpCycle); break;
      case 'relaunch': openRelaunch(d.bpAsset, d.bpName, d.bpPending === 'true'); break;
      case 'cancel': openCancel(d.bpAsset, d.bpType, d.bpName, d.bpDependents, d.bpEndsall === 'true', d.bpNewtotal); break;
      case 'cancel-all': openCancelAll(d.bpProducts, d.bpNewtotal); break;
      case 'undo-all': openUndoAll(); break;
    }
  });

  // ââ Change payment method â Stripe Customer Portal (LIVE) ââââââââââ
  async function openPortal() {
    toast('Opening your secure billing portalâ¦');
    const r = await fetch('/Billing?handler=PortalUrl', { credentials: 'same-origin' });
    let data = null; try { data = await r.json(); } catch (_) {}
    if (r.ok && data && data.url) window.location.href = data.url;
    else toast((data && data.error) || 'Unable to open the billing portal right now.');
  }

  // ââ Modal building blocks (exact copy of the design handoff markup) â
  // Blue-tile header: 46x46 tile, blue-50 bg, 22px blue-600 Lucide icon + 700/19 display title.
  const mHead = (icon, title) =>
    `<div style="display:flex;align-items:center;gap:13px;margin-bottom:14px">
       <div style="width:46px;height:46px;border-radius:var(--ae-radius-lg);background:var(--ae-blue-50);display:flex;align-items:center;justify-content:center;flex:none"><i data-lucide="${icon}" style="width:22px;height:22px;color:var(--ae-blue-600)"></i></div>
       <div style="font:700 19px var(--ae-font-display);color:var(--ae-ink-700)">${esc(title)}</div>
     </div>`;
  const mBody = (html) =>
    `<p style="font:400 14.5px/1.65 var(--ae-font-body);color:var(--ae-fg-2);margin:0 0 22px">${html}</p>`;
  // The cancellation confirmation names the dependent fee lines and the new total, so it runs two or
  // three times the length of a normal modal body. At 14.5px that much prose shouts; this reads as
  // the fine print it is.
  const mBodySm = (html) =>
    `<p style="font:400 13px/1.6 var(--ae-font-body);color:var(--ae-fg-2);margin:0 0 20px">${html}</p>`;
  const S_PRIMARY = 'display:inline-flex;align-items:center;gap:8px;color:#fff;border:none;border-radius:var(--ae-radius);padding:12px 20px;font:600 15px var(--ae-font-body);cursor:pointer';
  const S_SECONDARY = 'background:#fff;color:var(--ae-ink-700);border:1px solid var(--ae-gray-300);border-radius:var(--ae-radius);padding:12px 18px;font:600 15px var(--ae-font-body);cursor:pointer';
  // Quieter variants, for a modal carrying more explanation than a dialog usually does. Separate
  // constants rather than smaller defaults, because every other modal in this file shares those and
  // reads fine at the larger size.
  const S_PRIMARY_SM = 'display:inline-flex;align-items:center;gap:7px;color:#fff;border:none;border-radius:var(--ae-radius);padding:10px 16px;font:600 13px var(--ae-font-body);cursor:pointer';
  const S_SECONDARY_SM = 'background:#fff;color:var(--ae-ink-700);border:1px solid var(--ae-gray-300);border-radius:var(--ae-radius);padding:10px 15px;font:600 13px var(--ae-font-body);cursor:pointer';
  // The greyed-out state that every locked button in this file already spelled out inline. Named now
  // that a second place needs it, and that something has to be able to take it back off again.
  const S_LOCKED = 'background:var(--ae-gray-200);color:var(--ae-fg-3);cursor:not-allowed';
  // Footer: right-aligned secondary (outline) + primary (action or danger).
  // opts: {secondary, danger, noSecondary, compact, locked}. compact matches mBodySm.
  const mFooter = (primaryLabel, opts) => {
    opts = opts || {};
    const bg = opts.danger ? 'var(--ae-danger)' : 'var(--ae-action)';
    const pri = opts.compact ? S_PRIMARY_SM : S_PRIMARY;
    const secStyle = opts.compact ? S_SECONDARY_SM : S_SECONDARY;
    const sec = opts.noSecondary ? '' :
      `<button type="button" class="bp-hg" style="${secStyle}" data-bp-close>${esc(opts.secondary || 'Not now')}</button>`;
    // `locked` paints the primary disabled from its first frame and carries its live style along with
    // it, so whatever unlocks it later does not have to know how this footer was built. Painting it
    // disabled in the markup rather than a tick later is the point: there is no frame in which the
    // button looks pressable. See gateWire, and wwwroot/js/confirm-gate.js.
    const live = pri + ';background:' + bg;
    const lock = opts.locked ? ` disabled data-bp-live-style="${esc(live)}"` : '';
    return `<div style="display:flex;justify-content:flex-end;gap:10px">${sec}` +
           `<button type="button" style="${opts.locked ? live + ';' + S_LOCKED : live}"${lock} data-bp-confirm>${esc(primaryLabel)}</button></div>`;
  };
  // Selectable option row (billing cycle / cancel reason).
  const S_ROW = 'display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;border-radius:var(--ae-radius-lg);padding:14px 16px;cursor:pointer;background:#fff';
  const rowOn = S_ROW + ';border:2px solid var(--ae-action);background:var(--ae-blue-50)';
  const rowOff = S_ROW + ';border:1px solid var(--ae-gray-300)';
  const checkIcon = '<i data-lucide="check-circle-2" style="width:20px;height:20px;color:var(--ae-action)"></i>';

  modalEl.addEventListener('click', e => { if (e.target.closest('[data-bp-close]')) closeModal(); });

  // ââ View product details âââââââââââââââââââââââââââââââââââââââââââ
  function openDetails(name, detailsJson) {
    let rows = [];
    try { rows = JSON.parse(detailsJson || '[]'); } catch (_) {}
    const body = rows.length
      ? '<div style="border:1px solid var(--ae-gray-200);border-radius:var(--ae-radius-lg);overflow:hidden;margin:0 0 22px">' + rows.map((r, i) =>
          `<div style="display:flex;justify-content:space-between;gap:16px;padding:11px 15px;${i ? 'border-top:1px solid var(--ae-gray-200);' : ''}"><span style="font:500 13px var(--ae-font-body);color:var(--ae-fg-2)">${esc(r.Label)}</span><span style="font:600 13px var(--ae-font-body);color:var(--ae-ink-700);text-align:right">${esc(r.Value)}</span></div>`).join('') + '</div>'
      : mBody('No additional details are available for this product.');
    openModal(mHead('eye', name || 'Product details') + body +
      mFooter('Close', { noSecondary: true }));
    wireConfirm(closeModal);
  }

  // ââ Change payment method (design confirm â Stripe portal) âââââââââ
  function openPaymentModal() {
    openModal(mHead('lock', 'Update payment method') +
      mBody("For your security, your card details are entered in Stripe's encrypted payment form. Agent Elite never sees or stores your full card number. Click continue to add or replace your card.") +
      mFooter('Continue to secure form', { secondary: 'Not now' }));
    wireConfirm(() => { closeModal(); openPortal(); });
  }

  // ââ Edit billing contact & address âââââââââââââââââââââââââââââââââ
  const fld = (label, id) =>
    `<div style="flex:1;min-width:140px"><div style="font:600 var(--ae-text-xs) var(--ae-font-body);color:var(--ae-fg-2);margin-bottom:5px">${esc(label)}</div><input id="${id}" style="width:100%;box-sizing:border-box;border:1px solid var(--ae-gray-300);border-radius:var(--ae-radius);padding:11px 13px;font:400 14.5px var(--ae-font-body);color:var(--ae-ink-700)"></div>`;
  function openContact() {
    openModal(mHead('receipt', 'Edit billing contact & address') +
      `<div style="display:flex;flex-direction:column;gap:12px;margin:0 0 22px">
         ${fld('Full name', 'bpcName')}
         <div style="display:flex;gap:12px;flex-wrap:wrap">${fld('Email for receipts', 'bpcEmail')}${fld('Phone', 'bpcPhone')}</div>
         ${fld('Billing address', 'bpcAddr')}
         <div style="display:flex;gap:12px;flex-wrap:wrap">${fld('City', 'bpcCity')}${fld('State', 'bpcState')}${fld('ZIP', 'bpcZip')}</div>
       </div>` +
      // The billing contact is who the invoice is addressed to and where receipts land. Changing it
      // quietly redirects a customer's billing correspondence, which is why it signs like the rest.
      gateField(gate.PHRASE.BILLING_CONTACT, SIGNED_ACTION) +
      mFooter('Save changes', { secondary: 'Cancel', locked: true }));
    // Pre-fill from the current billing contact (Stripe customer), so Save never wipes existing values.
    fetch('/api/billing/contact', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        const set = (id, v) => { const e = document.getElementById(id); if (e && v != null) e.value = v; };
        set('bpcName', d.name); set('bpcEmail', d.email); set('bpcPhone', d.phone);
        set('bpcAddr', d.address); set('bpcCity', d.city); set('bpcState', d.state); set('bpcZip', d.zip);
      })
      .catch(() => {});
    const typed = gateWire(gate.PHRASE.BILLING_CONTACT, SIGNED_ACTION);
    wireConfirm(async () => {
      if (signatureRefused()) return renderSignatureRefused(openContact,
        { what: 'A change to the billing contact' });
      if (!typed()) return;
      const signature = signedValue();
      busy('Savingâ¦');
      const r = await post('/api/billing/contact', {
        name: val('bpcName'), email: val('bpcEmail'), phone: val('bpcPhone'),
        address: val('bpcAddr'), city: val('bpcCity'), state: val('bpcState'), zip: val('bpcZip'),
        signature: signature
      }, 'PUT');
      closeModal();
      if (r.ok) toast((r.data && r.data.message) || 'Billing information saved.');
      else handleResult(r, '', 'Editing billing contact');
    });
  }

  // ââ Billing cycle ââââââââââââââââââââââââââââââââââââââââââââââââââ
  //
  // Three cycles, forming a ladder of commitment length. A customer can only move UP it: a longer term
  // prepays more, so the proration is a charge the switch can take atomically, while a shorter one
  // produces a credit that a charge cannot express. So the rows below are not all equal â the ones the
  // customer could actually switch to are pickable, and the rest are their history.
  const CYCLES = [
    { id: 'monthly',  label: 'Monthly',       months: 1  },
    { id: 'annual',   label: 'Annually',      months: 12 },
    { id: 'two_year', label: 'Every 2 years', months: 24 }
  ];

  function cycleMonths(id) {
    const c = CYCLES.find(x => x.id === id);
    return c ? c.months : 0;
  }

  function openCycle() {
    const cycle = pane.getAttribute('data-bp-cycle');
    // Which cycles the server says this customer can actually be switched to. Read from the server
    // rather than derived from the ladder here, because availability also depends on the feature flag,
    // on every product resolving to a usable price, and on the switch actually saving money. The client
    // cannot know any of that, and guessing would offer a change the endpoint then refuses.
    const upgrades = (pane.getAttribute('data-bp-cycle-upgrades') || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    const detail = {
      monthly:  pane.getAttribute('data-bp-cyc-m')  || 'Billed every month',
      annual:   pane.getAttribute('data-bp-cyc-a')  || 'Billed once a year',
      two_year: pane.getAttribute('data-bp-cyc-2y') || 'Billed once every 2 years'
    };
    const save = {
      monthly:  '',
      annual:   pane.getAttribute('data-bp-cyc-save')    || '',
      two_year: pane.getAttribute('data-bp-cyc-2y-save') || ''
    };

    const opt = (c) => {
      const on = c.id === cycle;
      const pickable = upgrades.indexOf(c.id) !== -1;
      const title = esc(c.label) + (save[c.id]
        ? ` <span style="color:var(--ae-success);font-weight:600;font-size:12.5px">&middot; ${esc(save[c.id])}</span>` : '');
      // A row that is neither current nor pickable is a shorter cycle, i.e. this customer's past. Shown
      // so the ladder reads as a ladder, dimmed and inert so it is not a dead end to click.
      const inert = !on && !pickable;
      const style = (on ? rowOn : rowOff) + (inert ? ';opacity:.5;cursor:default' : '');
      return `<button type="button" class="bp-cyc" data-cyc="${c.id}" data-pickable="${pickable ? '1' : '0'}" style="${style}">
         <div style="text-align:left"><div style="font:600 15px var(--ae-font-body);color:var(--ae-ink-700)">${title}</div><div style="font:400 12.5px var(--ae-font-body);color:var(--ae-fg-2)">${esc(detail[c.id])}</div></div>
         <span class="bp-cyc-check" style="${on ? '' : 'display:none'}">${checkIcon}</span>
       </button>`;
    };

    // A shorter cycle is arranged by a person, not here. One line of copy rather than a disabled row
    // per cycle, which is what a two-year customer would otherwise be shown twice over.
    const anyShorter = CYCLES.some(c => c.months < cycleMonths(cycle));
    const footnote = anyShorter
      ? `<div style="font:400 12.5px var(--ae-font-body);color:var(--ae-fg-3);margin:0 0 18px">Need to move to a shorter billing cycle? Your Concierge team can arrange it for you.</div>`
      : '';

    openModal(mHead('calendar', 'Choose your billing cycle') +
      `<div style="display:flex;flex-direction:column;gap:10px;margin:0 0 ${anyShorter ? '14px' : '22px'}">
         ${CYCLES.map(opt).join('')}
       </div>` + footnote +
      mFooter('Save billing cycle', { secondary: 'Cancel' }));

    let pick = cycle;
    modalEl.querySelectorAll('.bp-cyc').forEach(o => o.addEventListener('click', () => {
      if (o.getAttribute('data-pickable') !== '1') return;
      pick = o.getAttribute('data-cyc');
      modalEl.querySelectorAll('.bp-cyc').forEach(x => {
        const on = x === o;
        const inert = !on && x.getAttribute('data-pickable') !== '1' && x.getAttribute('data-cyc') !== cycle;
        x.setAttribute('style', (on ? rowOn : rowOff) + (inert ? ';opacity:.5;cursor:default' : ''));
        x.querySelector('.bp-cyc-check').style.display = on ? '' : 'none';
      });
    }));

    wireConfirm(async () => {
      if (pick === cycle) { closeModal(); return; }
      closeModal();
      // Every switch this modal can produce is an IMMEDIATE change with a charge today, so it routes
      // through the confirmation flow rather than saving from here. That is why this modal no longer
      // promises "effective at your next renewal", which was wrong.
      if (cycleMonths(pick) > cycleMonths(cycle)) openCycleSwitch(pick);
      else toast('Moving to a shorter billing cycle isn\u2019t available online yet. Your Concierge team can arrange it for you.');
    });
  }

  // ââ Switch billing cycle: the confirmation âââââââââââââââââââââââââ
  //
  // One confirmation for every lengthening, parameterised by the target cycle. Two copies of this
  // would be two places for the money copy to drift from what the endpoint actually does, and that copy
  // is the customer's only warning about a charge landing today.
  //
  // Every figure in it comes from GET /api/billing/switch-cycle/preview, which prices the switch with
  // the switch's own planner and reads the charge off the invoice Stripe would raise. Nothing here
  // computes proration: the customer ticks a box against these numbers, and a second opinion about them
  // is exactly what later disagrees with their card statement.
  const CYCLE_COPY = {
    annual: {
      confirm: 'Switch to yearly',
      title: 'Switch to yearly billing?',
      // "the year", not "the 2 year term": both halves of this pair appear in the same sentence as a
      // dollar figure, so they have to read as the thing being bought.
      termWord: 'yearly term',
      termNoun: 'the year',
      termTotalLabel: 'Yearly total',
      termLineLabel: 'Yearly term',
      sfx: ' /yr',
      per: '/year',
      once: 'once a year',
      rateNoun: 'annual',
      saveSuffix: 'a year',
      busy: 'Switching you to yearlyâ¦',
      done: "You're on yearly billing now.",
      failing: 'Switching to yearly'
    },
    two_year: {
      confirm: 'Switch to 2 years',
      title: 'Switch to 2 years and save {pct}?',
      termWord: '2-year term',
      termNoun: 'the 2 year term',
      termTotalLabel: '2-year total',
      termLineLabel: '2-year term',
      sfx: ' /2yr',
      per: '/2 years',
      once: 'once every 2 years',
      rateNoun: '2 year',
      saveSuffix: 'over the 2 years',
      busy: 'Setting up your 2 year planâ¦',
      done: "You're on the 2 year plan now.",
      failing: 'Setting up the 2 year plan'
    }
  };

  // How the cycle the customer is on today is spoken, in the three places the copy names it.
  const CYCLE_NOW = {
    monthly:  { every: 'every month',        per: '/month',   unused: 'month' },
    annual:   { every: 'once a year',        per: '/year',    unused: 'year' },
    two_year: { every: 'once every 2 years', per: '/2 years', unused: '2 years' }
  };

  function money(cents, currency) {
    var n = (cents || 0) / 100;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: (currency || 'usd').toUpperCase()
      }).format(n);
    } catch (_) {
      return '$' + n.toFixed(2);
    }
  }

  function openCycleSwitch(target) {
    const c = CYCLE_COPY[target];
    if (!c) { toast('That billing cycle is not available.'); return; }

    // Opened empty and filled from the preview, rather than opened after it: the round trip reads
    // Stripe twice and a button that does nothing for a second reads as broken.
    openModal('<div class="scm-loading"><span class="bp-spin"></span><span>Working out your priceâ¦</span></div>',
      'bp-modal--switch');
    const epoch = modalEpoch;

    getJson('/api/billing/switch-cycle/preview?cycle=' + encodeURIComponent(target)).then(function (r) {
      // Dismissed while we were waiting. Painting now would reopen a modal the customer closed.
      if (epoch !== modalEpoch) return;
      if (!r.ok || !r.data || !r.data.products) {
        closeModal();
        // The server's refusal is the customer's answer: it is the same refusal the switch itself
        // would have given, worded for them ("one of your products isn't offered on a 2 year term").
        handleResult(r, '', c.failing);
        return;
      }
      renderCycleSwitch(target, r.data);
    });
  }

  function renderCycleSwitch(target, q) {
    const c = CYCLE_COPY[target];
    const cur = CYCLE_NOW[q.currentCycle] || CYCLE_NOW.monthly;
    const cy = q.currency;
    const pct = q.savingsPct || '';
    const renewal = q.renewalDate || '';
    const trialing = !!q.trialing;
    // Null means Stripe could not price the invoice, which is not the same as nothing being owed.
    // Without a figure the payment block is dropped rather than guessed at, exactly as a trial drops it.
    const charged = !trialing && q.chargeToday != null;
    const chargeText = money(q.chargeToday, cy);
    const products = q.products || [];

    const head =
      `<div class="scm-header">
         <div class="scm-tile"><i data-lucide="sparkles"></i></div>
         <h2 class="scm-title" id="scmTitle">${esc(c.title.replace('{pct}', pct))}</h2>
       </div>`;

    const intro = target === 'two_year'
      ? `Pay ${c.once} instead of ${cur.every}${pct ? ' and save ' + esc(pct) : ''}. `
        + 'Your plan and products stay exactly the same, and we switch you right now.'
      : `Pay once a year instead of ${cur.every}${pct ? ' and save ' + esc(pct) : ''}. `
        + 'Everything else about your plan stays exactly the same, and we switch you right now.';

    const compare =
      `<div class="scm-compare">
         <div>
           <div class="scm-compare-label">Today</div>
           <div class="scm-compare-value">${esc(money(q.currentTotal, cy))} ${esc(cur.every)}</div>
         </div>
         <i data-lucide="arrow-right"></i>
         <div>
           <div class="scm-compare-label is-to">After you switch</div>
           <div class="scm-compare-value is-to">${esc(money(q.targetTotal, cy))} ${esc(c.once)}</div>
         </div>
       </div>`;

    // One product is the common case, and a table of one row surrounded by column headings and a
    // total that repeats it is how the first version of this came to read as busy. It gets a sentence
    // instead. Two or more get rows, and only then is a total worth printing.
    const solo = products.length === 1;
    const zero = p => !p.targetAmount;
    const priced = p => zero(p)
      ? 'Included'
      : esc(money(p.targetAmount, cy)) + '<span class="scm-sfx">' + esc(c.sfx) + '</span>';

    const productBody = solo
      ? `<div class="scm-solo-name">${esc(products[0].name)}</div>
         <div class="scm-solo-line">${zero(products[0])
            ? 'Included with your plan'
            : esc(money(products[0].currentAmount, cy)) + esc(cur.per) + ' &rarr; <strong>'
              + esc(money(products[0].targetAmount, cy)) + '</strong>' + esc(c.per)}</div>`
      : `<div class="scm-rows">${products.map(p =>
          `<div class="scm-row">
             <div class="scm-row-l">
               <div class="scm-row-name">${esc(p.name)}</div>
               <div class="scm-row-now">${zero(p) ? 'Included with your plan'
                  : esc(money(p.currentAmount, cy)) + esc(cur.per) + ' today'}</div>
             </div>
             <div class="scm-row-r"><span class="scm-row-next">${priced(p)}</span></div>
           </div>`).join('')}</div>
         <div class="scm-total">
           <span class="scm-total-label">${esc(c.termTotalLabel)}</span>
           <span class="scm-total-value">${esc(money(q.targetTotal, cy))}</span>
         </div>`;

    const productsBlock =
      `<div>
         <div class="scm-section-label">${products.length > 1
            ? 'Your products on the new term' : 'Your product on the new term'}</div>
         <div class="scm-card">${productBody}</div>
       </div>`;

    // Charged today is the arithmetic of the two lines above it, which is what makes the big figure
    // above trustworthy; it is deliberately the quietest row of the three.
    const payRow = (label, value, cls) =>
      `<div class="scm-pay-row${cls ? ' ' + cls : ''}"><span>${label}</span><span>${value}</span></div>`;

    const pay = !charged ? '' :
      `<div class="scm-pay">
         <div class="scm-pay-label">You'll pay today</div>
         <div class="scm-pay-amount">${esc(chargeText)}</div>
         <div class="scm-pay-lines">
           ${payRow(esc(c.termLineLabel), esc(money(q.targetTotal, cy)))}
           ${q.credit ? payRow('Unused current-term credit', '&minus;' + esc(money(q.credit, cy)), 'is-green') : ''}
           ${payRow('Charged today', esc(chargeText), 'is-total')}
           ${q.savings ? payRow('You save', esc(money(q.savings, cy)) + ' ' + esc(c.saveSuffix), 'is-green') : ''}
         </div>
       </div>`;

    // The date first, because it is the third of the three things this dialog exists to answer. The
    // five commitments of a prepaid term sit behind the disclosure: one click away, never in the way.
    const details = [
      `The whole ${esc(chargeText)} leaves your card today, in one charge. There is no payment plan and no instalments.`,
      `Nothing else is billed until ${esc(renewal)}. No monthly charges, and no separate product charges in between.`,
      `A prepaid ${esc(c.termWord)} is non-refundable. If you cancel, your products keep running until ${esc(renewal)} and then stop.`,
      `On ${esc(renewal)} we renew you at the ${esc(c.rateNoun)} rate in effect then, unless you change or cancel first. We email you 30 days before.`,
      `Add a product mid term and we charge only the time left on your ${esc(c.termWord)}, so your one renewal date does not move.`
    ];

    const next = !charged ? '' :
      `<div class="scm-next">
         <div class="scm-next-head">
           <i data-lucide="info"></i>
           <div>
             <div class="scm-next-title">Next payment: ${esc(renewal)}</div>
             <div class="scm-next-sub">Nothing else will be charged before then.</div>
           </div>
         </div>
         <button type="button" class="scm-more" id="scmMore" aria-expanded="false" aria-controls="scmDetail">
           What happens after I switch?<i data-lucide="chevron-down"></i>
         </button>
         <div class="scm-detail" id="scmDetail" hidden>
           ${details.map(d => `<div class="scm-detail-item"><span class="scm-detail-dot"></span><span class="scm-detail-text">${d}</span></div>`).join('')}
         </div>
       </div>`;

    // A trial changes what is owed, not just what it costs: the price moves now, the trial keeps
    // running, and nothing is charged until it ends. Promising a charge today would be wrong for
    // exactly these customers, so the whole payment column is replaced by this notice.
    const trialNote = !trialing ? '' :
      `<div class="scm-trial">
         <i data-lucide="info"></i>
         <div class="scm-trial-text">Nothing is charged today and your free trial keeps running${
           q.trialEndDate ? ' until ' + esc(q.trialEndDate) : ''}. Your ${esc(c.rateNoun)} rate starts after that${
           renewal ? ', and renews on ' + esc(renewal) : ''}.</div>
       </div>`;

    // Short enough to be read, and it still names the two facts a prepaid term turns on: the amount
    // and that it cannot be handed back. The renewal sits under it, quieter, because it is a date
    // rather than a commitment being made right now.
    const ack = trialing
      ? `I understand my new rate starts when my trial ends${q.trialEndDate ? ' on ' + esc(q.trialEndDate) : ''}.`
      : charged
        ? `I understand I'm paying ${esc(chargeText)} today and this ${esc(c.termWord)} is non-refundable.`
        : `I understand my card is charged today and this ${esc(c.termWord)} is non-refundable.`;
    const ackSub = renewal
      ? `Renews ${esc(renewal)} unless changed or cancelled beforehand.`
      : '';

    const footer =
      `<div class="scm-footer">
         <div class="scm-ack">
           <div>
             <div class="scm-ack-text">${ack}</div>
             ${ackSub ? `<div class="scm-ack-sub">${ackSub}</div>` : ''}
           </div>
         </div>
         ${gateField(gate.PHRASE.SWITCH_CYCLE, SIGNED_ACTION)}
         <div class="scm-actions">
           <button type="button" class="scm-btn scm-btn--secondary" data-bp-close>Not now</button>
           <button type="button" class="scm-btn scm-btn--primary" data-bp-confirm disabled>${esc(c.confirm)}</button>
         </div>
       </div>`;

    openModal(head +
      `<p class="scm-intro" id="scmIntro">${intro}</p>` +
      compare +
      `<div class="scm-grid${charged ? '' : ' is-single'}">${productsBlock}${charged ? '<div>' + pay + next + '</div>' : ''}</div>` +
      trialNote +
      '<div id="scmError" hidden></div>' +
      footer, 'bp-modal--switch');

    dialogSemantics('scmTitle', 'scmIntro');

    const more = document.getElementById('scmMore');
    const detail = document.getElementById('scmDetail');
    if (more && detail) more.addEventListener('click', function () {
      const open = detail.hidden;
      detail.hidden = !open;
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // Empty on every open, from all four entry points, and the handler re-reads it too: a disabled
    // button is a UI state, not a permission.
    //
    // This replaced an acknowledgement checkbox. The sentence it used to label is still above the field,
    // unchanged - the disclosure was always the words, not the box - and what is now between the
    // customer and a non-refundable charge of this size is having written the word out.
    //
    // No onLock painter: .scm-btn--primary:disabled is already styled in billing-panel.css, so an inline
    // override here would only make this one button disagree with the rest of its own modal.
    const box = modalEl.querySelector('#aeTtcInput');
    const go = modalEl.querySelector('[data-bp-confirm]');
    const typed = gateWire(gate.PHRASE.SWITCH_CYCLE,
        Object.assign({ button: go, onLock: null }, SIGNED_ACTION));

    // Not wireConfirm: its once-only latch is right for a modal that closes on either outcome, and this
    // one stays open on failure so the customer can try again. The in-flight guard does the job the
    // latch was there for, and is released only on a failure we have reported.
    let inFlight = false;
    if (go) go.addEventListener('click', async function () {
      // Staff are stopped at the press, like everywhere else. Back returns to this same priced
      // confirmation, which is a fresh preview rather than the stale one behind the refusal.
      if (signatureRefused()) return renderSignatureRefused(
        function () { openCycleSwitch(target); },
        { what: 'A billing cycle change' });
      if (!typed() || inFlight) return;
      inFlight = true;
      const signature = box ? box.value : '';
      if (box) box.disabled = true;
      busy('Switchingâ¦');
      const r = await post('/api/billing/switch-cycle', { cycle: target, signature: signature });
      if (r.ok) {
        closeModal();
        // Prefer the server's message: it names the real renewal date Stripe returned, which is the
        // authoritative one, and says correctly whether anything was charged.
        toast((r.data && r.data.message) || c.done);
        holdThenReload(1600, c.busy);
        return;
      }
      // Kept open on failure. Closing it would leave the customer unable to tell whether a charge of
      // this size went through, and with nothing to retry.
      showSwitchError(r, c);
      inFlight = false;
      // Re-enabled with what they typed still in it: they have already read the screen and written the
      // word, and a declined card is not a reason to make them do it again.
      if (box) box.disabled = false;
    });
  }

  // Puts the failure above the footer rule and re-arms the button, so a declined card is something the
  // customer can act on rather than a dialog that has gone inert.
  function showSwitchError(r, c) {
    const box = document.getElementById('scmError');
    const msg = (r.data && r.data.error)
      || (r.status === 404 || r.status === 403 ? c.failing + ' will be available shortly.' : '')
      || 'Something went wrong and you have not been charged. Please try again.';
    if (box) {
      box.className = 'scm-error';
      box.innerHTML = '<i data-lucide="alert-circle"></i><div class="scm-error-text">' + esc(msg) + '</div>';
      box.hidden = false;
    } else {
      toast(msg);
    }
    const go = modalEl.querySelector('[data-bp-confirm]');
    if (go) {
      go.innerHTML = esc(c.confirm);
      go.disabled = false;
      go.style.opacity = '';
      go.style.cursor = '';
    }
    modalEl.querySelectorAll('[data-bp-close]').forEach(b => { b.disabled = false; b.style.opacity = ''; });
    drawIcons();
  }

  // ââ Upgrade plan âââââââââââââââââââââââââââââââââââââââââââââââââââ
  //
  // Delegates to the portal-wide picker (upgrade-modal.js) rather than carrying its own copy.
  // Billing is the one caller that already holds the catalog â the view component serialises the
  // options onto the menu button â so it passes them straight through and skips the round trip
  // every other entry point has to make.
  function openPlanChange(d) {
    var tiers = [];
    try { tiers = JSON.parse(d.bpTiers || '[]'); } catch (_) { tiers = []; }
    // Counts what can be PICKED. In change mode the list also carries the customer's own rung, so a
    // plain length check would open a picker whose only card is the plan they already have.
    var pickable = tiers.filter(function (t) { return !t.isCurrent; });
    if (!pickable.length) { toast('There are no other plans available for this product right now.'); return; }
    if (!window.aeUpgrade) { toast('Plans are unavailable right now. Please refresh and try again.'); return; }

    // Billing has no link to fall through to â the trigger is a menu item, not an anchor â so a picker
    // that cannot open has to say so here. Without this the menu item just closed and nothing happened.
    window.aeUpgrade.open({
      tiers: tiers,
      productLabel: d.bpName || '',
      // Billing is the one surface where BOTH directions belong: it is where a customer goes to manage
      // what they already pay for. The product pages stay upgrade only by passing nothing.
      mode: 'change',
      current: {
        name: d.bpTier || d.bpName || '',
        priceDisplay: d.bpPrice || '',
        cadence: d.bpCadence || ' /mo',
        // Lets the current-plan card say "Renews Oct 1", which answers the question a customer is
        // already holding while comparing: when would this take effect. Blank when the page does not
        // know it, and the card then omits the chip rather than guessing.
        renewalDate: d.bpRenews || ''
      },
      returnTo: 'billing'
    }).then(function (opened) {
      if (!opened) toast('We could not open the plan options. Please refresh and try again.');
    });
  }
  // ââ Keep my current plan âââââââââââââââââââââââââââââââââââââââââââ
  //
  // Abandons a scheduled tier change. This is the promise the downgrade confirmation makes in as many
  // words, so it is not a convenience: without it that copy is false and the only way back is a
  // support ticket.
  //
  // Confirmed rather than immediate. It is reversing something the customer deliberately chose, and a
  // menu item that silently undoes a decision is as surprising as one that silently makes it.
  function openKeepPlan(d) {
    var tier = d.bpTier || 'current';
    var newTier = d.bpNewtier || 'a different plan';
    var at = d.bpAt || 'your renewal date';

    openModal(mHead('rotate-ccw', 'Keep your ' + esc(tier) + ' plan?') +
      mBody('Your plan is set to change to <strong>' + esc(newTier) + '</strong> on <strong>' +
            esc(at) + '</strong>. Keep your ' + esc(tier) + ' plan and that change will not happen, ' +
            'so nothing about your account or your bill will alter.') +
      mFooter('Keep my ' + esc(tier) + ' plan', { secondary: 'Leave the change in place' }));

    wireConfirm(async function () {
      // Not instant, and it used to look broken. This releases a Stripe schedule and then writes the
      // account document, so it is a multi-second round trip during which the modal sat there with a
      // live-looking button: no spinner, no disable, and a second click would fire a second release.
      // Every other action in this file marks itself busy first.
      busy('Keeping your planâ¦');

      const r = await post('/api/billing/keep-plan', { assetId: d.bpAsset });
      closeModal();
      // Shares the same result handling as every other action here, so the server's own message wins
      // and a 403 from a flag being switched off mid-session reads correctly instead of as a fault.
      if (!handleResult(r, 'You are staying on your current plan.', 'Keeping your plan')) return;
      holdThenReload(1600, 'Keeping your current planâ¦');
    });
  }

  // ââ Add additional âââââââââââââââââââââââââââââââââââââââââââââââââ
  // Reuses the marketplace add-on checkout that already puts purchases onto an existing
  // subscription in production. The hosted page charges the prorated remainder of this
  // cycle (with tax); the webhook lands the item on the plan, so it renews with the rest.
  function openAdd(name, type, priceId, plan, cycle) {
    if (!priceId) { toast('This product canât be added again from here. Please contact support.'); return; }
    openModal(mHead('copy-plus', 'Add additional ' + (name || 'product')) +
      mBody(`We'll add another <strong style="color:var(--ae-ink-700)">${esc(name)}</strong> to your subscription. You'll pay the prorated amount for the rest of this billing cycle today, and it renews with the rest of your plan.`) +
      mFooter('Continue to payment', { secondary: 'Not now' }));
    wireConfirm(async () => {
      busy('Opening paymentâ¦');
      const r = await post('/api/marketplace/checkout', {
        priceId: priceId,
        productType: type,
        plan: plan || '',
        billingType: cycle || 'monthly',
        isUpgrade: false,
        productName: 'Additional ' + (name || 'product')
      });
      if (r.ok && r.data && r.data.checkoutUrl) { window.location.href = r.data.checkoutUrl; return; }
      closeModal();
      handleResult(r, '', 'Adding a product');
    });
  }

  // ââ Relaunch / undo ââââââââââââââââââââââââââââââââââââââââââââââââ
  // Two different transactions share this modal, so the copy must not blur them:
  //  - isPending: the cancellation hasn't taken effect. Undoing is free and changes nothing.
  //  - otherwise: the product already ended, so coming back is a new subscription (a new charge).
  function openRelaunch(assetId, name, isPending) {
    const label = name || 'product';
    if (isPending) {
      openModal(mHead('refresh-cw', 'Keep ' + label + '?') +
        mBody("We'll cancel the cancellation, so nothing changes. You keep this product and everything in it, your billing stays exactly as it is, and there's no charge today.") +
        mFooter('Keep my product', { secondary: 'Not now' }));
    } else {
      openModal(mHead('refresh-cw', 'Relaunch ' + label + '?') +
        mBody("Good news, we saved everything. We'll restore your settings and data and add this product back to your subscription.") +
        mFooter('Relaunch product', { secondary: 'Not now' }));
    }
    wireConfirm(async () => {
      busy(isPending ? 'Restoringâ¦' : 'Relaunchingâ¦');
      const r = await post('/api/billing/relaunch-product', { assetId });
      closeModal();
      handleResult(r,
        isPending ? 'Your cancellation has been undone.' : 'Relaunch started. Welcome back!',
        isPending ? 'Undo cancellation' : 'Relaunch');
      if (r.ok) holdThenReload(1200, 'Updating your planâ¦');
    });
  }

  // ââ Save-flow measurement âââââââââââââââââââââââââââââââââââââââââââ
  // The steps only the page witnesses: which reason was picked, which card was turned down, and whether
  // the modal ended in a cancellation or was simply closed. The server sees the ladder being fetched and
  // an offer being accepted, which is the flow's wins and nothing else; without these four calls there is
  // no denominator and no way to tell a working card from a card nobody ever gets past.
  //
  // Nothing here changes what the customer sees, and nothing waits on it. Every call is fire and forget
  // against an endpoint that answers 204 whatever happens, so a measurement that fails is a missing row
  // and never an error in front of somebody who is already on their way out.

  // The walk whose modal is currently open, or null once it has settled into an accept or a cancel.
  // Holding the context rather than a flag is what lets closeModal record an abandonment from a screen
  // several steps away from where the walk began.
  let activeWalk = null;

  function saveTrack(ctx, step, extra) {
    // No flow id means no ladder was served (an outage, or billing access lost mid-session), so there is
    // nothing to attribute the step to.
    if (!ctx || !ctx.flowId) return;
    const body = {
      flowId: ctx.flowId,
      step: step,
      assetId: ctx.assetId || null,
      scope: ctx.scope || null,
      reason: ctx.reason,
      subReason: ctx.subReason,
      // The card the step is about, falling back to the last one rendered. That fallback is what makes an
      // abandonment worth reading: closeModal fires from wherever the customer was, and knowing which
      // card lost them is the whole point of recording it. The server reads this field for the declined
      // and abandoned steps only.
      offerId: (extra && extra.offerId) || ctx.lastOfferId || null,
      wasFinal: !!(extra && extra.wasFinal)
    };
    try {
      // keepalive, because the two most interesting steps happen as things are going away: the modal
      // closing, and in the tab-close case the document itself. A plain fetch is cancelled in both, which
      // would lose exactly the outcome this exists to see.
      fetch('/api/billing/save-flow/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
        body: JSON.stringify(body)
      }).catch(function () {});
    } catch (_) { /* measurement must never surface */ }
  }

  // Settles the open walk with its outcome. Calling it twice is harmless: the second call has nothing
  // left to record, which is what stops a cancellation or an accept also counting as an abandonment when
  // the modal closes a moment later.
  function endWalk(step, extra) {
    const ctx = activeWalk;
    activeWalk = null;
    if (ctx && step) saveTrack(ctx, step, extra);
  }

  // Closes the walk WITHOUT an outcome, for the one case where we know the customer did not choose
  // anything: the cancellation failed on our side. Left to closeModal it would have been recorded as
  // "closed the box", which reads as a customer thinking better of it, so a Stripe outage would have
  // shown up in the report as a week of people changing their minds. Our own failures must never be
  // counted as customer behaviour, least of all as the flattering kind. With no row the walk lands in
  // "never finished a step", which is honest: we know what we did, not what they did next.
  function discardWalk() { activeWalk = null; }

  // ââ Cancel: the save flow, driven entirely by configuration ââââââââ
  // Every word the customer reads, which offers they are shown, in what order, and what each
  // button does comes from GET /api/billing/save-flow/{assetId}. This file holds no copy, no
  // reason list and no per-product rules: a wrong card is wrong in SaveFlowCatalog.cs or in the
  // AE Admin copy overlay, never here. Offers we cannot honour are filtered out server-side, so
  // anything rendered below is something the application can actually do.
  // Safe JSON parse for a data- attribute. A malformed blob must never take the menu down.
  function parseList(raw) {
    if (!raw) return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }

  // What the plan costs once this cancellation lands. Server-computed and passed through, never derived
  // here: the arithmetic has to match TotalDisplay exactly (annual vs monthly basis, quantities, the fee
  // lines that leave with their anchor) and none of that is recoverable from the price strings on screen.
  // Omitted when the server had no figure to give, rather than guessed at.
  const newTotalRow = (amount, topBorder) => !amount ? '' :
    `<div style="display:flex;justify-content:space-between;gap:12px;padding:11px 0 20px${topBorder ? ';margin-top:6px;border-top:1px solid var(--ae-gray-200)' : ''}">
       <span style="font:700 14.5px var(--ae-font-body);color:var(--ae-ink-700)">Your new subscription total</span>
       <span style="font:800 15px var(--ae-font-display);color:var(--ae-ink-700)">${esc(amount)}</span>
     </div>`;

  // What ELSE ends, in one sentence. Both halves are silent surprises otherwise: the fee lines that
  // cannot outlive this product, and the case where this product is the last billable thing on the plan
  // so cancelling it ends the subscription outright. This used to sit on the old single offer screen.
  // The ladder has no single screen every customer sees, so it moved to the confirmation, which is the
  // one screen a cancellation cannot avoid.
  function alsoEndsSentence() {
    let out = '';
    if (cancelCtx.dependents && cancelCtx.dependents.length)
      out += ' The ' + cancelCtx.dependents.map(esc).join(' and the ') + ' will end with it.';
    if (cancelCtx.endsAll)
      out += ' This is the last product on your plan, so cancelling it ends your entire subscription'
           + ' at the end of the billing cycle.';
    return out;
  }

  let cancelCtx = null;   // { assetId, name, flow, reason, subReason, dependents[], endsAll, newTotal }

  // The row's product type is no longer read for copy: the server resolves it from the asset, so the page
  // cannot disagree with the row that was clicked. The argument stays for the dispatcher's call shape.
  async function openCancel(assetId, _type, name, dependentsRaw, endsAll, newTotal) {
    cancelCtx = { assetId: assetId, name: name || 'this product', flow: null, reason: null, subReason: null,
                  dependents: parseList(dependentsRaw), endsAll: !!endsAll, newTotal: newTotal || '' };
    openWalkModal(mHead('x-circle', 'Cancel ' + cancelCtx.name + '?') +
      mBody('Just a moment while we look at your account.'));
    const epoch = modalEpoch;

    const r = await getJson('/api/billing/save-flow/' + encodeURIComponent(assetId));
    if (epoch !== modalEpoch) return;   // dismissed while we were waiting

    if (r.ok && r.data && r.data.reasons && r.data.reasons.length) {
      cancelCtx.flow = r.data;
      // Minted by the server when it served the ladder, so every step of this walk joins on one id that
      // the page did not choose.
      cancelCtx.flowId = r.data.flowId || null;
      activeWalk = cancelCtx;
      if (r.data.productName) cancelCtx.name = r.data.productName;
      renderReasonStep();
    } else {
      // No flow available (outage, billing read failed, or billing access lost mid-session). Cancelling
      // must still work, and inventing offers here would be worse than offering none.
      renderPlainCancel();
    }
  }

  // Step 1: why are you leaving.
  function renderReasonStep() {
    const rows = cancelCtx.flow.reasons.map(r =>
      `<button type="button" class="bp-reason" data-reason="${esc(r.id)}" style="${rowOff}">
         <span style="font:600 14.5px var(--ae-font-body);color:var(--ae-ink-700)">${esc(r.label)}</span>
         <span class="bp-reason-check" style="display:none">${checkIcon.replace('20px', '19px')}</span>
       </button>`).join('');
    const contOff = S_PRIMARY + ';background:var(--ae-gray-200);color:var(--ae-fg-3);cursor:not-allowed';
    const contOn = S_PRIMARY + ';background:var(--ae-action)';

    openWalkModal(mHead('x-circle', 'Cancel ' + cancelCtx.name + '?') +
      mBody('Sorry to see you thinking about leaving. Why are you cancelling ' + esc(cancelCtx.name) +
            '? Your answer helps us make it right.') +
      `<div style="display:flex;flex-direction:column;gap:9px;margin:0 0 22px">${rows}</div>
       <div style="display:flex;justify-content:flex-end;gap:10px">
         <button type="button" style="${S_SECONDARY}" class="bp-hg" data-bp-close>Never mind</button>
         <button type="button" id="bpReasonContinue" style="${contOff}" disabled>Continue</button>
       </div>`);

    wirePicker('.bp-reason', 'data-reason', 'bpReasonContinue', contOn, id => {
      cancelCtx.reason = id;
      cancelCtx.subReason = null;
      const reason = currentReason();
      if (reason && reason.subReasons && reason.subReasons.length) renderSubReasonStep();
      else {
        // Recorded once the routing is settled, so a reason that asks a follow-up question is counted at
        // the sub-reason step instead of twice. One row per walk either way.
        saveTrack(cancelCtx, 'reason_chosen');
        renderLadder(reason ? reason.cards : [], 0);
      }
    });
  }

  // Step 1b: "Tell us a bit more", shown only for the reason configured to ask.
  function renderSubReasonStep() {
    const reason = currentReason();
    const rows = reason.subReasons.map(s =>
      `<button type="button" class="bp-sub" data-sub="${esc(s.id)}" style="${rowOff}">
         <span style="font:600 14.5px var(--ae-font-body);color:var(--ae-ink-700)">${esc(s.label)}</span>
         <span class="bp-reason-check" style="display:none">${checkIcon.replace('20px', '19px')}</span>
       </button>`).join('');
    const contOff = S_PRIMARY + ';background:var(--ae-gray-200);color:var(--ae-fg-3);cursor:not-allowed';
    const contOn = S_PRIMARY + ';background:var(--ae-action)';

    openWalkModal(mHead('message-circle', 'Tell us a bit more') +
      mBody('Anything you can tell us helps. This goes to the team, not a form.') +
      `<div style="display:flex;flex-direction:column;gap:9px;margin:0 0 22px">${rows}</div>
       <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
         ${backButton('bpSubBack')}
         <button type="button" id="bpSubContinue" style="${contOff}" disabled>Continue</button>
       </div>`);

    modalEl.querySelector('#bpSubBack').addEventListener('click', renderReasonStep);
    wirePicker('.bp-sub', 'data-sub', 'bpSubContinue', contOn, id => {
      cancelCtx.subReason = id;
      saveTrack(cancelCtx, 'reason_chosen');
      const sub = reason.subReasons.find(s => s.id === id);
      renderLadder(sub ? sub.cards : [], 0, sub ? sub.alternatives : []);
    });
  }

  // Step 2: the offer ladder. One card at a time, exactly as the flow ordered them.
  //
  // Whether the exit cancels is the SERVER's answer (card.declineCancels), not a length check here. The
  // label and the consequence travel together for a reason: while this file worked out "last card"
  // itself, every card's exit read "No thanks, cancel anyway" and only the final one did that, so the
  // customer was pressing a button that told them the wrong thing.
  function renderLadder(cards, index, alternatives) {
    if (!cards || index >= cards.length) return renderCancelConfirm(null);
    const card = cards[index];
    const declineCancels = card.declineCancels !== false;
    // How far the customer got, so an abandonment says which card they were looking at when they closed.
    cancelCtx.lastOfferId = card.offerId;

    const line = (text, style) => text ? `<div style="${style}">${esc(text)}</div>` : '';
    const alts = (alternatives && alternatives.length && index === 0)
      ? `<div style="font:400 12.5px/1.6 var(--ae-font-body);color:var(--ae-fg-3);margin:0 0 16px">`
        + 'If you go, that means ' + alternatives.map(a => esc(a.toLowerCase())).join(' or ') + '.'
        + '</div>'
      : '';

    const textarea = card.needsText
      ? `<textarea id="bpSaveText" rows="4" maxlength="4000" placeholder="What happened?"
           style="width:100%;border:1px solid var(--ae-gray-300);border-radius:var(--ae-radius);padding:11px 13px;font:400 14px var(--ae-font-body);color:var(--ae-ink-700);resize:vertical;margin:0 0 18px"></textarea>`
      : '';

    // A video offer, authored in the admin sheet. Only sheet offers carry a url; the board's own cards
    // have none, so nothing existing renders a player.
    //
    // controls, no autoplay: a video that starts talking at someone who came to cancel is worse than no
    // video. preload="metadata" so the poster frame and duration appear without pulling the whole file
    // for the customers who never press play.
    //
    // The url is written into the src attribute, so it is escaped here AND validated to be absolute
    // https server-side before it is ever stored. Both, because this value originates in a spreadsheet.
    const video = card.videoUrl
      ? `<video src="${esc(card.videoUrl)}" controls preload="metadata" playsinline
           style="width:100%;border-radius:var(--ae-radius);background:#000;margin:0 0 18px;display:block"></video>`
      : '';

    openWalkModal(mHead('heart-handshake', 'Before you go') +
      `<div style="display:flex;flex-direction:column;gap:7px;margin:0 0 18px">
         ${line(card.eyebrow, 'font:400 14px var(--ae-font-body);color:var(--ae-fg-2)')}
         ${line(card.headline, 'font:700 25px/1.15 var(--ae-font-display);color:var(--ae-blue-600);letter-spacing:-0.02em')}
         ${line(card.caption, 'font:400 12.5px var(--ae-font-body);color:var(--ae-fg-3)')}
         ${line(card.body, 'font:400 14.5px/1.6 var(--ae-font-body);color:var(--ae-ink-700);margin-top:4px')}
         ${line(card.subtext, 'font:400 13px/1.55 var(--ae-font-body);color:var(--ae-fg-3)')}
       </div>
       ${alts}
       ${video}
       ${textarea}
       <button type="button" id="bpSaveAccept" style="${S_PRIMARY};background:var(--ae-action);width:100%;justify-content:center">${esc(card.primaryCta)}</button>
       <div style="display:flex;flex-direction:column;align-items:center;gap:7px;border-top:1px solid var(--ae-gray-200);margin-top:18px;padding-top:14px">
         <button type="button" id="bpSaveDecline" style="background:none;border:none;color:var(--ae-fg-2);font:600 13.5px var(--ae-font-body);cursor:pointer;text-decoration:underline">${esc(card.declineLabel)}</button>
         ${card.showContactRep
           ? `<button type="button" id="bpSaveRep" style="background:none;border:none;color:var(--ae-fg-2);font:600 13.5px var(--ae-font-body);cursor:pointer;text-decoration:underline">Talk to a representative</button>`
           : ''}
       </div>
       <div style="margin-top:14px">${backButton('bpSaveBack')}</div>`);

    modalEl.querySelector('#bpSaveAccept').addEventListener('click', () => card.needsConfirm
      ? renderAnnualConfirm(card, null, () => renderLadder(cards, index, alternatives))
      : acceptOffer(card));

    // Back was missing from this step entirely: a customer who picked a reason could only accept,
    // escalate or cancel. Earlier rungs are reachable again, and the first rung returns to the picker.
    modalEl.querySelector('#bpSaveBack').addEventListener('click', () => {
      if (index > 0) renderLadder(cards, index - 1, alternatives);
      else if (cancelCtx.subReason) renderSubReasonStep();
      else renderReasonStep();
    });

    modalEl.querySelector('#bpSaveDecline').addEventListener('click', () => {
      // Turning a card down is the signal the flow most needs and least had: an offer nobody accepts and
      // an offer nobody is ever shown look identical without it.
      saveTrack(cancelCtx, 'offer_declined', { offerId: card.offerId, wasFinal: declineCancels });
      // On the last rung the exit is the cancellation, so it goes through the same confirmation the
      // no-offers path uses. Cancelling on a single click of a footer link was the weakest confirmation
      // in the flow, on its most consequential button.
      if (declineCancels) renderCancelConfirm(() => renderLadder(cards, index, alternatives));
      else renderLadder(cards, index + 1, alternatives);
    });

    const rep = modalEl.querySelector('#bpSaveRep');
    if (rep) rep.addEventListener('click', () =>
      acceptOffer({ offerId: 'contact_rep', primaryCta: 'Talk to a representative' }, rep));
  }

  // The annual switch is the only rung that moves money, and it moves ALL of it: the endpoint converts
  // every item on the subscription and invoices the difference immediately. Two reasons this needs its
  // own step rather than firing off the card's CTA. A single click is too thin a confirmation for a
  // charge, and the customer reached this screen by cancelling ONE product, so an offer about annual
  // billing reads as being about that product. The flow this replaced had the same second step; going
  // straight to the charge would have been a regression, not a simplification.
  //
  // Driven by the server's needsConfirm flag, not by the offer id, so a money-moving offer added later
  // cannot ship without landing here.
  function renderAnnualConfirm(card, scope, onBack) {
    const saveInline = pane.getAttribute('data-bp-annual-save') || '';
    const monthlyNow = pane.getAttribute('data-bp-cyc-m') || '';
    const annualAfter = pane.getAttribute('data-bp-cyc-a') || '';
    const saveNote = pane.getAttribute('data-bp-cyc-save') || '';
    const trialing = pane.getAttribute('data-bp-trialing') === 'true';
    const trialEnds = pane.getAttribute('data-bp-trial-ends') || '';
    const wholePlan = scope === 'subscription';
    const name = (cancelCtx && cancelCtx.name) || 'this product';

    // Named plainly. On the product route the point is that this is BIGGER than what they clicked.
    const scopeLine = wholePlan
      ? 'Every product on your subscription moves to annual billing.'
      : 'Every product on your subscription moves to annual billing, not just ' + esc(name) + '.';

    // Before and after, from the same figures the billing cycle picker shows, so the two screens
    // cannot quote different numbers. Each row is omitted rather than guessed at when the server had
    // nothing to give: a blank "After" is better than one we made up.
    // A row only earns its place if it carries a figure. "Billed once a year" with no amount is the
    // screen this replaced: the server withholds the card entirely when it cannot quote a yearly price,
    // so this should be unreachable, and a price row that silently loses its price is worth two lines
    // of defence rather than one.
    const hasAmount = (v) => /[0-9]/.test(v || '');
    const row = (k, v, strong) => !hasAmount(v) ? '' :
      `<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0">
         <span style="font:${strong ? '700' : '400'} 13px var(--ae-font-body);color:var(--ae-fg-2)">${esc(k)}</span>
         <span style="font:${strong ? '700' : '600'} 13px var(--ae-font-body);color:var(--ae-ink-700);text-align:right">${esc(v)}</span>
       </div>`;
    const summary = (hasAmount(monthlyNow) || hasAmount(annualAfter))
      ? `<div style="border:1px solid var(--ae-gray-200);border-radius:var(--ae-radius);padding:6px 14px;margin:0 0 18px">
           ${row('Now', monthlyNow)}
           ${row('After this change', annualAfter, true)}
           ${row('You save', saveNote)}
         </div>`
      : '';

    // What is being agreed to. This used to BE the gate, as a checkbox with the sentence for a label;
    // it is now the sentence alone, above the typed field that replaced the box. Nothing is lost by the
    // swap - the disclosure is the words, and they are still here, now as copy nobody can tick past
    // without reading the line underneath it - and a prepaid term that cannot be handed back is exactly
    // the kind of commitment a tick is too cheap for.
    const consent = trialing
      ? 'I agree to move my whole subscription to annual billing at the new rate, starting when my free '
        + 'trial ends.'
      : 'I agree to move my whole subscription to annual billing, to the immediate prorated charge, and '
        + 'to the new annual rate. I acknowledge that once charged, this transaction is non-refundable.';

    openWalkModal(mHead('calendar', 'Switch your whole subscription to annual?') +
      mBodySm('<strong>' + scopeLine + '</strong> Your plan and products stay exactly the same'
        + (saveInline && !summary ? ', and you save ' + esc(saveInline) : '') + '.') +
      summary +
      // While a free trial runs nothing is charged: the price changes now and the annual amount is
      // billed when the trial ends. Promising a charge today would be wrong for those customers.
      mBodySm(trialing
        ? '<strong>Nothing is charged today</strong> and your free trial keeps running'
          + (trialEnds ? ' until ' + esc(trialEnds) : '')
          + '. Your annual rate starts after that.'
        : 'We switch you right now and <strong>charge the prorated difference today</strong>, crediting '
          + 'the unused part of your current month.') +
      `<p style="font:400 12.5px/1.55 var(--ae-font-body);color:var(--ae-fg-2);margin:0 0 16px">${esc(consent)}</p>` +
      // Not the danger tone: this arms the blue button, and a field that turns red over a switch onto a
      // cheaper term would be telling the customer something the screen does not mean.
      gateField(gate.PHRASE.SWITCH_CYCLE, SIGNED_ACTION) +
      (onBack ? '<div style="margin:0 0 16px">' + backButton('bpAnnualBack') + '</div>' : '') +
      mFooter('Switch to annual', { secondary: 'Not now', compact: true, locked: true }));

    const go = modalEl.querySelector('[data-bp-confirm]');
    const typed = gateWire(gate.PHRASE.SWITCH_CYCLE, SIGNED_ACTION);

    // Not wireConfirm: its once-only latch would be spent by a click that arrived before the word was
    // typed, and the real confirmation would then do nothing. This latches only on the click that
    // actually goes through.
    let fired = false;
    go.addEventListener('click', () => {
      // Staff first, so a press that gets this far can only ever produce the refusal. Inside the walk,
      // so the refusal screen must keep it alive rather than filing an abandonment.
      if (signatureRefused()) return renderSignatureRefused(
        function () { renderAnnualConfirm(card, scope, onBack); },
        { what: 'A move to annual billing', walk: true });
      // Re-read rather than trusting the disabled button, which is one devtools edit from being untrue.
      if (fired || !typed()) return;
      fired = true;
      acceptOffer(card, go, scope, signedValue());
    });

    const back = modalEl.querySelector('#bpAnnualBack');
    if (back) back.addEventListener('click', onBack);
  }

  // The offer id is all we send. The server looks it up, re-checks that it is still available, and
  // performs whatever the catalog says it does, so the page cannot invent or replay an action.
  // `pressed` is the button to show progress on, so the representative link does not relabel the
  // primary CTA above it. Defaults to the primary, which is what accepting a card presses.
  // `scope` is 'subscription' when the customer came from the total row, so the server re-checks the
  // offer against the whole-plan ladder rather than a product's. Reason and sub-reason are read from
  // whichever context is running, because the two routes keep their own.
  // `signature` is what the customer typed on a card that gated itself. Only the annual-switch card
  // does today; every other offer is a discount or a pause, which take something away from us rather
  // than from them, so there is nothing for the customer to sign.
  async function acceptOffer(card, pressed, scope, signature) {
    const ctx = scope === 'subscription' ? cancelAllCtx : cancelCtx;
    const btn = pressed || modalEl.querySelector('#bpSaveAccept');
    const text = card.needsText ? (val('bpSaveText') || '').trim() : null;
    if (card.needsText && !text) {
      const box = modalEl.querySelector('#bpSaveText');
      if (box) { box.style.borderColor = 'var(--ae-danger)'; box.focus(); }
      return;
    }
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'One momentâ¦'; }
    const epoch = modalEpoch;

    const r = await post('/api/billing/save-flow/accept', {
      assetId: scope === 'subscription' ? null : ctx.assetId,
      scope: scope === 'subscription' ? 'subscription' : null,
      // So the win joins the walk that produced it. The server records the accept either way.
      flowId: ctx.flowId || null,
      offerId: card.offerId,
      reason: ctx.reason,
      subReason: ctx.subReason,
      text: text,
      signature: signature || null
    });
    if (epoch !== modalEpoch) {
      // Dismissed mid-request. Do not resurrect the modal, but if the subscription really moved the
      // page is now stale and has to be refreshed anyway.
      if (r.ok && r.data && r.data.reload) window.location.reload();
      return;
    }

    if (r.ok && r.data) {
      // "Send and continue" continues. The free-text card takes the customer's words and then hands the
      // walk on to the cancellation, so the modal stays open on the next step rather than closing with a
      // retention toast over a product that is still active. Closing there is what made one customer
      // press the button eight times and open eight tickets.
      // A downgrade offer hands off rather than mutating. The server has recorded the accept; the plan
      // change itself happens in the picker, which is where the customer is shown the date they keep
      // their current plan until, that nothing is charged today and that there is no refund. Committing
      // them to a period-end swap from inside a retention modal would skip every one of those.
      if (r.data.openChangePlan) {
        closeModal();
        const row = pane.querySelector('[data-bp-action="change-plan"][data-bp-asset="'
          + (r.data.assetId || '') + '"]')
          || pane.querySelector('[data-bp-action="change-plan"]');
        if (row) { row.click(); return; }
        // No picker on the page for this asset, which means the row is not rendering a Change Plan item.
        // Say so rather than closing on silence and leaving them where they started.
        toast('Your Concierge team can move you to a smaller plan. We have noted your request.');
        return;
      }

      if (r.data.continueToCancel) {
        toast(r.data.message || "Thanks, that's with our team.");
        if (scope === 'subscription') renderCancelAllSave2();
        else renderCancelConfirm(null);
        return;
      }

      // Settled before the modal closes, so the accept the server already recorded is not also counted
      // as an abandonment by closeModal. No row from here: the server wrote the accept itself.
      discardWalk();
      closeModal();
      if (r.data.redirect) { window.location.href = r.data.redirect; return; }
      toast(r.data.message || 'Thanks for staying.');
      // Only when the server says the subscription moved. The value-proof and request cards change
      // nothing, and reloading after them flashed the page for no reason.
      if (r.data.reload) setTimeout(() => window.location.reload(), 1600);
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = label || card.primaryCta; }
    handleResult(r, '', 'That offer');
  }

  // ââ Type-to-confirm ââââââââââââââââââââââââââââââââââââââââââââââââ
  //
  // Customers were reaching a scheduled cancellation without having registered that they asked for one.
  // The reason is structural rather than a wording problem: every screen in the save flow advances on a
  // primary button, so by the last one the customer is pressing the primary button, not reading it. A
  // sequence of buttons can be walked on autopilot. Typing a word cannot.
  //
  // The field, the matching and the signature rules now live in wwwroot/js/confirm-gate.js, because the
  // plan picker's downgrade review needs exactly the same gate and a second copy of the matching is a
  // second place for it to drift. This file keeps only what is specific to a cancellation: which word,
  // and what a staff member is told when they try to sign one.
  //
  // It is NOT a security control and must never be mistaken for one. See the header of confirm-gate.js.
  //
  // The stand-in is for the one case where confirm-gate.js did not load: a cache miss on a stale
  // asp-append-version hash, a blocked request, a layout that forgot the tag. Reading a method off
  // `undefined` here would throw at the top of this IIFE and take out every listener in the file, so
  // the billing panel would lose its menus and its modals over a missing confirmation field. It fails
  // the way the gate itself fails when the field is absent: towards the screens we shipped for years,
  // which is a confirmation with no typing rather than a page that does nothing.
  const gate = window.aeConfirmGate || {
    PHRASE: {},
    signer: function () { return { name: '', staffRole: '' }; },
    field: function () { return ''; },
    wire: function (o) {
      // No field was rendered, so nothing exists that could ever unlock the button. Releasing it here
      // is the whole point of the stand-in: a footer asked for `locked: true` paints the primary
      // disabled from its first frame, and without this the customer meets a confirmation that cannot
      // be completed at all, which is a support ticket and a refund.
      if (o && o.button) {
        o.button.disabled = false;
        if (typeof o.onLock === 'function') o.onLock(o.button, false);
      }
      return function () { return true; };
    }
  };

  // Signature mode (Features:SelfServiceCancelSignature, server side). When it is on and the signed-in
  // user's claims carry a first and last name, they sign that name instead of typing a word.
  //
  // EVERY gated screen on this page signs. It did not always: the first cut kept signing for the two
  // cancellations, on the argument that the staff refusal would otherwise stop support helping a
  // customer onto a cheaper term. That was overruled once the gates were seen working, and for a good
  // reason - a staff member could move a customer's whole subscription onto a two-year prepaid term by
  // typing SWITCH, and a word anybody can type records nothing about who agreed to it. Support losing
  // these six screens while the flag is on is the accepted cost.
  //
  // Two shapes, differing only in the matched-field tint: danger for the screens whose primary button
  // is red, so the field turns the colour of the button it just armed.
  const SIGNED = { sign: true, tone: 'danger' };
  const SIGNED_ACTION = { sign: true };

  // The signed-in user's internal role (admin / tech / css / marketing), or empty for a client. Only
  // ever set while signature mode is on.
  //
  // Staff are deliberately NOT stopped from reaching this screen, or from typing, or from pressing the
  // button. They are stopped at the press, and told why. Hiding the button would leave somebody hunting
  // for a cancel that is plainly on the account; refusing at the press answers the question they were
  // about to ask. It also means nothing about the ordinary confirmation changes for them.
  //
  // This governs the SIGNATURE, not the action. Staff can still do all six things - with the flag off,
  // and through the API either way. What they cannot do while it is on is put their own name on a line
  // that is supposed to carry the customer's assent.
  //
  // Not conditioned on a name having resolved. The server only sets the attribute while the flag is on,
  // so its presence already means "this page's actions are signed". A staff member whose claims carry
  // no first and last name would otherwise fall back to the plain word and walk straight through the
  // very requirement the flag exists to impose - thin claims must not be the way around a signature.
  const signerStaffRole = () => gate.signer().staffRole;
  const signatureRefused = () => !!signerStaffRole();

  // The gate's field and wiring, with the two things every confirmation in THIS file needs and the
  // shared component has no business knowing: the modal to look in, and how to paint a button whose
  // styling is inline rather than in a stylesheet.
  //
  // mFooter's `locked` option parks the live style on data-bp-live-style and paints the button greyed
  // from its first frame, so the button is never briefly pressable while the field is empty.
  function gateField(phrase, opts) {
    return gate.field(Object.assign({ phrase: phrase }, opts || {}));
  }
  // What is currently in the type-to-confirm box, for the audit record the server keeps of who signed a
  // cancellation. Read BEFORE busy(), which disables the field: reading it after would send an empty
  // signature for every cancellation that actually had one.
  //
  // Sent as a claim and nothing more. The server re-derives the expected name from the signed-in user's
  // own claims and forms its own opinion of whether this matches, because a signature the page supplied
  // both halves of would not be worth storing.
  function signedValue() {
    const input = modalEl.querySelector('#aeTtcInput');
    return input ? input.value : '';
  }

  function gateWire(phrase, opts) {
    const btn = modalEl.querySelector('[data-bp-confirm]');
    const live = btn ? (btn.getAttribute('data-bp-live-style') || btn.getAttribute('style') || '') : '';
    return gate.wire(Object.assign({
      phrase: phrase,
      scope: modalEl,
      button: btn,
      onLock: function (b, locked) { b.setAttribute('style', locked ? live + ';' + S_LOCKED : live); }
    }, opts || {}));
  }

  // The refusal a staff member meets when they press the button. Rendered in place of the cancellation,
  // so nothing is sent and nothing on the account moves.
  //
  // It names the role, because "you are staff" is a worse message than "you are signed in as tech" to
  // somebody who did not expect to be either - an AE address picked up a role at some point and nobody
  // told them. It also says what CAN happen next, since a support person reading this is usually
  // mid-call with the customer who actually wants to cancel.
  //
  // `onBack` returns to the confirmation rather than closing: they are allowed to be here, they are just
  // not allowed to sign, and dumping them out of the modal would read as a crash.
  //
  // `what` names the thing being refused, so the screen says "A cancellation here is signed" or "A
  // billing cycle change here is signed" rather than one sentence that fits none of the six. `walk` is
  // true only inside the cancellation save flow: openWalkModal keeps the walk alive across the swap,
  // and using it outside that flow would file an abandonment against a walk that was never running.
  function renderSignatureRefused(onBack, opts) {
    opts = opts || {};
    const what = opts.what || 'This';
    const open = opts.walk ? openWalkModal : openModal;
    open(mHead('shield-alert', 'Only the customer can sign this') +
      mBodySm('You are signed in as <strong>' + esc(signerStaffRole()) + '</strong>, which is an Agent '
          + 'Elite staff role rather than a customer on this account. ' + esc(what) + ' is signed, and a '
          + 'signature from one of us is not the customer\'s agreement, so this one has to be completed '
          + 'by them while they are signed in themselves.') +
      `<div style="margin:0 0 16px">${backButton('bpSignRefusedBack')}</div>` +
      mFooter('Close', { noSecondary: true, compact: true }));
    wireConfirm(closeModal);
    const back = modalEl.querySelector('#bpSignRefusedBack');
    if (back) back.addEventListener('click', onBack);
  }

  // The one confirmation, used by both routes into a cancellation: the last rung of the ladder, and the
  // no-flow path where there was never a ladder. `onBack`, when given, returns to the card behind it.
  function renderCancelConfirm(onBack) {
    openWalkModal(mHead('x-circle', 'Cancel ' + cancelCtx.name + '?') +
      mBodySm('This schedules ' + esc(cancelCtx.name) + ' to end at the close of your current billing '
          + 'cycle. You keep it until then, and you can undo this at any point before it takes effect.'
          // The dependent fee lines, and the case where this is the last product on the plan. Both used
          // to sit on the single offer screen the ladder replaced, and both are silent surprises if the
          // customer only meets them on the invoice.
          + alsoEndsSentence()) +
      (onBack ? `<div style="margin:0 0 16px">${backButton('bpConfirmBack')}</div>` : '') +
      // What they will pay afterwards, not only what they are losing. Server-computed, omitted when
      // there was no figure to give. Left at full size on purpose: it is the figure the customer is
      // deciding against, and the only thing on this screen that should carry weight.
      newTotalRow(cancelCtx.newTotal, true) +
      gateField(gate.PHRASE.CANCEL_PRODUCT, SIGNED) +
      mFooter('Cancel ' + cancelCtx.name,
              { secondary: 'Never mind', danger: true, compact: true, locked: true }));
    const typed = gateWire(gate.PHRASE.CANCEL_PRODUCT, SIGNED);
    // The guard runs again here rather than trusting the disabled button alone. wireConfirm's once-only
    // latch means a rejected click cannot be retried, and that is the right direction to fail: the modal
    // is still open, Never mind still works, and reopening it costs one click.
    //
    // The staff refusal is checked at the press, not at render, so they reach it by doing exactly what a
    // customer would do: they sign, they press, and the answer comes back. It sits ahead of the typed
    // guard so that a press which gets this far can only ever produce the refusal, never a silent
    // no-op - the button is disabled until something is typed either way, so this is about which of the
    // two answers wins, not about skipping the field.
    wireConfirm(function () {
      if (signatureRefused()) return renderSignatureRefused(
        function () { renderCancelConfirm(onBack); },
        { what: 'A cancellation here', walk: true });
      if (typed()) return finalizeCancel();
    });
    const back = modalEl.querySelector('#bpConfirmBack');
    if (back) back.addEventListener('click', onBack);
  }

  // No save flow available: an outage, a failed billing read, or billing access lost mid-session.
  function renderPlainCancel() { renderCancelConfirm(null); }

  async function finalizeCancel() {
    const ctx = cancelCtx;
    const signature = signedValue();
    // The confirmation's primary button, so the default [data-bp-confirm] selector finds it. The old
    // flow needed '#bpFinalizeCancel' because its cancel was a footer link; the ladder routes every
    // cancellation through the confirmation screen instead, and that button must not stay clickable.
    busy('Cancellingâ¦');
    const r = await post('/api/billing/cancel-product', {
      assetId: ctx.assetId,
      // The reason recorded is still the one the customer picked, unchanged in meaning from the
      // ids the shipped flow has always written.
      reason: ctx.reason,
      // The "Tell us a bit more" answer. It was collected, used to route the ladder, and then thrown
      // away: the cancellation record kept the reason alone, so "Something else" was as much as anyone
      // reading it afterwards ever learned.
      subReason: ctx.subReason,
      // Who signed, and what they wrote. The server verifies and records it; it never gates on it.
      signature: signature
    });
    if (r.ok) {
      // Recorded only once the cancellation really landed. Sending it before the call would have marked
      // a walk lost that a Stripe failure left running.
      endWalk('cancelled');
      renderCancelDone(ctx.name, r.data && r.data.effectiveAt);
    } else {
      // Before closeModal, which would otherwise record this as an abandonment.
      discardWalk();
      closeModal();
      handleResult(r, '', 'Cancellation');
    }
  }

  // ââ Cancel subscription: the strongest alternative, then the save flow, then the warning ââââââââ
  //
  // Sequence: "cancel one product instead" (structural, and reason-independent, so it comes first) ->
  // why are you leaving -> the whole-plan offer ladder -> the visibility warning -> confirm.
  //
  // The ladder is GET /api/billing/save-flow/subscription, which resolves the catalog's `subscription`
  // key. That key deliberately carries none of the product-specific cards: a card naming listings or
  // home search is about one product, and this customer is ending all of them. What is left is the
  // commercial ladder plus the generic deterrent. The annual switch is available here even on a
  // multi-product plan, because from this button the customer is already acting on the whole plan.
  //
  // This file still holds no copy and no rules for it. If the flow returns nothing, the sequence is the
  // two save attempts it always was.
  let cancelAllCtx = null; // { products[], newTotal, flow, reason, subReason }

  async function openCancelAll(productsRaw, newTotal) {
    cancelAllCtx = { products: parseList(productsRaw), newTotal: newTotal || '',
                     flow: null, reason: null, subReason: null,
                     // No asset: this walk is about the plan. The scope travels with the context so every
                     // step is attributed to the whole-plan ladder rather than to a product.
                     assetId: null, scope: 'subscription', flowId: null };
    renderCancelAllSave1();
    const epoch = modalEpoch;

    // Fetched in the background: save1 needs none of it, and by the time the customer has read the
    // product list and pressed Continue it has almost always landed. Nothing waits on it.
    const r = await getJson('/api/billing/save-flow/subscription');
    // Dismissed while the ladder was in flight. Returning here matters for more than the render: marking
    // a walk active after its modal has closed would leave it live to be recorded as an abandonment by
    // whichever unrelated modal closes next.
    if (epoch !== modalEpoch) return;
    if (r.ok && r.data && r.data.reasons && r.data.reasons.length) {
      cancelAllCtx.flow = r.data;
      cancelAllCtx.flowId = r.data.flowId || null;
      // Only now. Before the ladder lands there is no flow id, so an abandonment on the first screen has
      // nothing to join to and is better left unrecorded than recorded as an orphan.
      activeWalk = cancelAllCtx;
    }
  }

  // Step 2: why are you leaving. Skipped entirely when no flow arrived.
  function renderCancelAllReasonStep() {
    if (!cancelAllCtx.flow) return renderCancelAllSave2();
    const rows = cancelAllCtx.flow.reasons.map(r =>
      `<button type="button" class="bp-areason" data-reason="${esc(r.id)}" style="${rowOff}">
         <span style="font:600 14.5px var(--ae-font-body);color:var(--ae-ink-700)">${esc(r.label)}</span>
         <span class="bp-reason-check" style="display:none">${checkIcon.replace('20px', '19px')}</span>
       </button>`).join('');
    const contOff = S_PRIMARY + ';background:var(--ae-gray-200);color:var(--ae-fg-3);cursor:not-allowed';
    const contOn = S_PRIMARY + ';background:var(--ae-action)';

    openWalkModal(mHead('x-circle', 'Before you close your account') +
      mBody('Why are you cancelling? Your answer helps us make it right, and it decides what we can '
          + 'offer you next.') +
      `<div style="display:flex;flex-direction:column;gap:9px;margin:0 0 22px">${rows}</div>
       <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
         ${backButton('bpAReasonBack')}
         <button type="button" id="bpAReasonContinue" style="${contOff}" disabled>Continue</button>
       </div>`);

    modalEl.querySelector('#bpAReasonBack').addEventListener('click', renderCancelAllSave1);
    wirePicker('.bp-areason', 'data-reason', 'bpAReasonContinue', contOn, id => {
      cancelAllCtx.reason = id;
      cancelAllCtx.subReason = null;
      const reason = cancelAllCtx.flow.reasons.find(r => r.id === id) || null;
      if (reason && reason.subReasons && reason.subReasons.length) renderCancelAllSubReasonStep();
      else {
        saveTrack(cancelAllCtx, 'reason_chosen');
        renderCancelAllLadder(reason ? reason.cards : [], 0);
      }
    });
  }

  function renderCancelAllSubReasonStep() {
    const reason = cancelAllCtx.flow.reasons.find(r => r.id === cancelAllCtx.reason);
    const rows = reason.subReasons.map(s =>
      `<button type="button" class="bp-asub" data-sub="${esc(s.id)}" style="${rowOff}">
         <span style="font:600 14.5px var(--ae-font-body);color:var(--ae-ink-700)">${esc(s.label)}</span>
         <span class="bp-reason-check" style="display:none">${checkIcon.replace('20px', '19px')}</span>
       </button>`).join('');
    const contOff = S_PRIMARY + ';background:var(--ae-gray-200);color:var(--ae-fg-3);cursor:not-allowed';
    const contOn = S_PRIMARY + ';background:var(--ae-action)';

    openWalkModal(mHead('message-circle', 'Tell us a bit more') +
      mBody('Anything you can tell us helps. This goes to the team, not a form.') +
      `<div style="display:flex;flex-direction:column;gap:9px;margin:0 0 22px">${rows}</div>
       <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
         ${backButton('bpASubBack')}
         <button type="button" id="bpASubContinue" style="${contOff}" disabled>Continue</button>
       </div>`);

    modalEl.querySelector('#bpASubBack').addEventListener('click', renderCancelAllReasonStep);
    wirePicker('.bp-asub', 'data-sub', 'bpASubContinue', contOn, id => {
      cancelAllCtx.subReason = id;
      saveTrack(cancelAllCtx, 'reason_chosen');
      const sub = reason.subReasons.find(s => s.id === id);
      renderCancelAllLadder(sub ? sub.cards : [], 0, sub ? sub.alternatives : []);
    });
  }

  // Step 3: the ladder. Same contract as the per-product one, including the server's declineCancels:
  // declining the last rung moves on to the visibility warning rather than cancelling outright, because
  // on this route there is still something left to say.
  function renderCancelAllLadder(cards, index, alternatives) {
    if (!cards || index >= cards.length) return renderCancelAllSave2();
    const card = cards[index];
    const isFinalRung = card.declineCancels !== false;
    cancelAllCtx.lastOfferId = card.offerId;

    const line = (text, style) => text ? `<div style="${style}">${esc(text)}</div>` : '';
    const alts = (alternatives && alternatives.length && index === 0)
      ? `<div style="font:400 12.5px/1.6 var(--ae-font-body);color:var(--ae-fg-3);margin:0 0 16px">`
        + 'If you go, that means ' + alternatives.map(a => esc(a.toLowerCase())).join(' or ') + '.'
        + '</div>'
      : '';
    const textarea = card.needsText
      ? `<textarea id="bpSaveText" rows="4" maxlength="4000" placeholder="What happened?"
           style="width:100%;border:1px solid var(--ae-gray-300);border-radius:var(--ae-radius);padding:11px 13px;font:400 14px var(--ae-font-body);color:var(--ae-ink-700);resize:vertical;margin:0 0 18px"></textarea>`
      : '';

    openWalkModal(mHead('heart-handshake', 'Before you go') +
      `<div style="display:flex;flex-direction:column;gap:7px;margin:0 0 18px">
         ${line(card.eyebrow, 'font:400 14px var(--ae-font-body);color:var(--ae-fg-2)')}
         ${line(card.headline, 'font:700 25px/1.15 var(--ae-font-display);color:var(--ae-blue-600);letter-spacing:-0.02em')}
         ${line(card.caption, 'font:400 12.5px var(--ae-font-body);color:var(--ae-fg-3)')}
         ${line(card.body, 'font:400 14.5px/1.6 var(--ae-font-body);color:var(--ae-ink-700);margin-top:4px')}
         ${line(card.subtext, 'font:400 13px/1.55 var(--ae-font-body);color:var(--ae-fg-3)')}
       </div>
       ${alts}
       ${textarea}
       <button type="button" id="bpSaveAccept" style="${S_PRIMARY};background:var(--ae-action);width:100%;justify-content:center">${esc(card.primaryCta)}</button>
       <div style="display:flex;flex-direction:column;align-items:center;gap:7px;border-top:1px solid var(--ae-gray-200);margin-top:18px;padding-top:14px">
         <button type="button" id="bpSaveDecline" style="background:none;border:none;color:var(--ae-fg-2);font:600 13.5px var(--ae-font-body);cursor:pointer;text-decoration:underline">${isFinalRung ? 'No thanks, continue cancelling' : esc(card.declineLabel)}</button>
         ${card.showContactRep
           ? `<button type="button" id="bpSaveRep" style="background:none;border:none;color:var(--ae-fg-2);font:600 13.5px var(--ae-font-body);cursor:pointer;text-decoration:underline">Talk to a representative</button>`
           : ''}
       </div>
       <div style="margin-top:14px">${backButton('bpASaveBack')}</div>`);

    modalEl.querySelector('#bpSaveAccept').addEventListener('click', () => card.needsConfirm
      ? renderAnnualConfirm(card, 'subscription', () => renderCancelAllLadder(cards, index, alternatives))
      : acceptOffer(card, null, 'subscription'));
    modalEl.querySelector('#bpASaveBack').addEventListener('click', () => {
      if (index > 0) renderCancelAllLadder(cards, index - 1, alternatives);
      else if (cancelAllCtx.subReason) renderCancelAllSubReasonStep();
      else renderCancelAllReasonStep();
    });
    modalEl.querySelector('#bpSaveDecline').addEventListener('click', () => {
      // wasFinal is the ladder's own last rung, not the end of this route: on the whole-plan path the
      // visibility warning still follows, so declining here is not yet a cancellation.
      saveTrack(cancelAllCtx, 'offer_declined', { offerId: card.offerId, wasFinal: isFinalRung });
      if (isFinalRung) renderCancelAllSave2(); else renderCancelAllLadder(cards, index + 1, alternatives);
    });
    const rep = modalEl.querySelector('#bpSaveRep');
    if (rep) rep.addEventListener('click', () =>
      acceptOffer({ offerId: 'contact_rep', primaryCta: 'Talk to a representative' }, rep, 'subscription'));
  }

  function renderCancelAllSave1() {
    const rows = cancelAllCtx.products.map(p =>
      `<div style="display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--ae-gray-200)">
         <span style="font:500 14px var(--ae-font-body);color:var(--ae-ink-700)">${esc(p.name)}</span>
         <span style="font:600 14px var(--ae-font-body);color:var(--ae-fg-2);white-space:nowrap">${esc(p.price)}</span>
       </div>`).join('');
    openWalkModal(mHead('x-circle', 'Cancel your subscription?') +
      mBody('Wait! You can cancel just one product instead of the entire subscription. '
        + 'Cancelling everything ends every product below at the end of your current billing cycle.')
        .replace('margin:0 0 22px', 'margin:0 0 14px') +
      `<div style="margin:0 0 6px">${rows}</div>` +
      // Was "You would give up <current total>", which named the amount they were losing and left them to
      // work out what was left. The rows above already say what is going; this says what stays.
      newTotalRow(cancelAllCtx.newTotal, false) +
      mFooter('Continue to cancel', { danger: true, secondary: 'Cancel just one product instead' }));
    // Exit lands them back on the rows, where each product carries its own Cancel.
    wireConfirm(renderCancelAllReasonStep);
  }

  function renderCancelAllSave2() {
    openWalkModal(mHead('alert-triangle', 'Your SEO and online visibility is at risk') +
      mBody('Search rankings build slowly and drop quickly. Cancelling everything takes down your '
        + 'website, your home search, and your listings across Google, Maps and AI search. '
        + 'Rebuilding that presence later takes months, and the leads you would have captured in '
        + 'the meantime are gone for good.') +
      mFooter('Continue to cancel', { danger: true, secondary: 'Keep improving my visibility' }));
    wireConfirm(renderCancelAllConfirm);
  }

  // The same confirmation the per-product flow ends on, for the whole-subscription cancel. Until now
  // "Continue to cancel" on the warning above went straight to the endpoint: no statement of what was
  // being scheduled, no mention that it can be undone, and no way back. The strongest cancellation in
  // the panel had the weakest confirmation.
  function renderCancelAllConfirm() {
    const n = cancelAllCtx.products.length;
    const what = n ? (n === 1 ? 'your one remaining product' : 'all ' + n + ' products on your plan')
                   : 'everything on your plan';
    openWalkModal(mHead('x-circle', 'Cancel your subscription?') +
      mBodySm('This schedules ' + what + ' to end at the close of your current billing cycle. You keep '
            + 'everything until then, and you can undo this at any point before it takes effect.') +
      `<div style="margin:0 0 16px">${backButton('bpCancelAllBack')}</div>` +
      newTotalRow(cancelAllCtx.newTotal, true) +
      gateField(gate.PHRASE.CANCEL_SUBSCRIPTION, SIGNED) +
      mFooter('Cancel my subscription',
              { secondary: 'Never mind', danger: true, compact: true, locked: true }));
    const typed = gateWire(gate.PHRASE.CANCEL_SUBSCRIPTION, SIGNED);
    wireConfirm(function () {
      if (signatureRefused()) return renderSignatureRefused(
        renderCancelAllConfirm, { what: 'A cancellation here', walk: true });
      if (typed()) return finalizeCancelAll();
    });
    modalEl.querySelector('#bpCancelAllBack').addEventListener('click', renderCancelAllSave2);
  }

  async function finalizeCancelAll() {
    // Before busy(), which disables the field. See signedValue.
    const signature = signedValue();
    busy('Cancellingâ¦');
    // Both were collected by the ladder and neither was sent: the whole-plan cancel posted an empty body,
    // so a subscription cancellation recorded no reason at all while a single-product one recorded its
    // reason. The two records now say the same kind of thing.
    const r = await post('/api/billing/cancel-subscription', {
      reason: cancelAllCtx && cancelAllCtx.reason,
      subReason: cancelAllCtx && cancelAllCtx.subReason,
      // Who signed, and what they wrote. The server verifies and records it; it never gates on it.
      signature: signature
    });
    if (r.ok) endWalk('cancelled'); else discardWalk();
    closeModal();
    if (r.ok) {
      const when = fmtDate(r.data && r.data.effectiveAt);
      const onWhen = when === 'the end of your billing cycle' ? 'at ' + when : 'on ' + when;
      toast('Your subscription is scheduled to cancel ' + onWhen
        + '. You keep everything until then, and you can undo this from any product.');
      holdThenReload(1800, 'Scheduling your cancellationâ¦');
    } else {
      handleResult(r, '', 'Cancellation');
    }
  }

  // ââ Undo the whole-subscription cancellation ââââââââââââââââââââââââ
  // Its own endpoint, not a loop over relaunch-product. When the cancel was applied through a
  // Subscription Schedule the per-product undo restores only the product it was asked about, so
  // undoing row by row would leave every other product still dropping at the boundary.
  function openUndoAll() {
    openModal(mHead('refresh-cw', 'Keep your subscription?') +
      mBody("We'll cancel the cancellation. Every product on your plan keeps running, nothing "
        + 'changes on your bill, and you keep the settings and data you already have.') +
      mFooter('Keep my subscription', { secondary: 'Not now' }));
    wireConfirm(async () => {
      busy('Restoringâ¦');
      const r = await post('/api/billing/relaunch-subscription', {});
      closeModal();
      if (handleResult(r, 'Your cancellation has been undone.', 'Undo cancellation')) {
        holdThenReload(1400, 'Restoring your subscriptionâ¦');
      }
    });
  }

  // Shared: single-select list wired to a Continue button.
  function wirePicker(rowSelector, attr, continueId, contOnStyle, onContinue) {
    let picked = null;
    modalEl.querySelectorAll(rowSelector).forEach(o => o.addEventListener('click', () => {
      picked = o.getAttribute(attr);
      modalEl.querySelectorAll(rowSelector).forEach(x => {
        const on = x === o;
        x.setAttribute('style', on ? rowOn : rowOff);
        x.querySelector('.bp-reason-check').style.display = on ? '' : 'none';
      });
      const c = modalEl.querySelector('#' + continueId);
      c.disabled = false; c.setAttribute('style', contOnStyle);
      drawIcons();
    }));
    modalEl.querySelector('#' + continueId).addEventListener('click', () => {
      if (picked) onContinue(picked);
    });
  }

  const backButton = (id) =>
    `<button type="button" id="${id}" style="background:none;border:none;color:var(--ae-fg-2);font:600 14px var(--ae-font-body);cursor:pointer;display:inline-flex;align-items:center;gap:6px"><i data-lucide="chevron-left" style="width:15px;height:15px"></i>Back</button>`;

  function currentReason() {
    if (!cancelCtx.flow) return null;
    return cancelCtx.flow.reasons.find(r => r.id === cancelCtx.reason) || null;
  }

  // Fmt an ISO date as "Aug 22, 2026"; blank/invalid â "the end of your billing cycle".
  function fmtDate(iso) {
    if (!iso) return 'the end of your billing cycle';
    const d = new Date(iso);
    return isNaN(d) ? 'the end of your billing cycle'
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ââ Cancel success ââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Deliberately quiet: a toast plus reload, no follow-up modal. The reloaded row's
  // "Cancels at period end" state is the confirmation. The CRM handoff still happens
  // server-side (the CX notify ticket); it is not surfaced to the customer.
  function renderCancelDone(name, effectiveAt) {
    closeModal();
    const when = fmtDate(effectiveAt);
    const onWhen = when === 'the end of your billing cycle' ? 'at ' + when : 'on ' + when;
    toast(name + ' is scheduled to cancel ' + onWhen + '. You can undo this any time before then.');
    holdThenReload(1600, 'Scheduling your cancellationâ¦');
  }

  // ââ shared helpers âââââââââââââââââââââââââââââââââââââââââââââââââ
  function wireConfirm(fn) {
    const btn = modalEl.querySelector('[data-bp-confirm]');
    // Once only. busy() disables the button synchronously so a second CLICK cannot get through, but a
    // handler bound twice would run twice off a single click, and for these endpoints that is a second
    // Stripe mutation rather than a retry.
    let fired = false;
    if (btn) btn.addEventListener('click', function (ev) {
      if (fired) return;
      fired = true;
      return fn(ev);
    });
  }
  function val(id) { const e = document.getElementById(id); return e ? e.value : ''; }

  // Prefill contact fields when the modal is opened (values live in the DOM head card).
  // (Simple: left blank; production can hydrate from a details endpoint.)

  // ââ Grace countdown ââââââââââââââââââââââââââââââââââââââââââââââââ
  const deadline = parseInt(pane.getAttribute('data-bp-grace') || '0', 10);
  const countEl = document.getElementById('bpCountdown');
  if (deadline > 0 && countEl) {
    const tick = () => {
      let ms = Math.max(0, deadline - Date.now());
      const d = Math.floor(ms / 86400000); ms -= d * 86400000;
      const h = Math.floor(ms / 3600000); ms -= h * 3600000;
      const m = Math.floor(ms / 60000); ms -= m * 60000;
      const s = Math.floor(ms / 1000);
      countEl.textContent = `${d}d ${h}h ${m}m ${s}s`;
    };
    tick();
    setInterval(tick, 1000);
  }
})();
