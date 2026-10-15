// Generic click telemetry. Any element with [data-track-event] auto-fires a
// beacon to /api/track/click when clicked. Browser delivers the beacon
// asynchronously, even if the click navigates away â so external links
// ("View Site") and target=_blank flows are captured.
//
// Usage in markup:
//
//   <a href="https://example.com" target="_blank"
//      data-track-event="WEBSITE_VIEW_CLICKED"
//      data-track-payload='{"asset_id":"abc","site_url":"https://example.com"}'>
//     View Site
//   </a>
//
// data-track-payload is optional. If present it must be valid JSON. If you
// need dynamic values, set them server-side when rendering the attribute.
(function () {
    'use strict';

    function fireBeacon(eventName, payload) {
        if (!eventName) return;
        var body = JSON.stringify({
            event_name: eventName,
            payload: payload || null
        });
        try {
            // sendBeacon survives page navigation â ideal for clickânavigate flows.
            var ok = navigator.sendBeacon
                && navigator.sendBeacon('/api/track/click',
                    new Blob([body], { type: 'application/json' }));
            if (!ok) {
                // Fallback for old browsers / blocked beacons: keepalive fetch.
                fetch('/api/track/click', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: body,
                    keepalive: true
                }).catch(function () { /* swallow */ });
            }
        } catch (e) {
            // Telemetry must never break the page.
        }
    }

    function parsePayload(el) {
        var raw = el.getAttribute('data-track-payload');
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return { raw: raw }; }
    }

    // Delegated click listener â works for elements added after page load.
    document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest
            ? e.target.closest('[data-track-event]')
            : null;
        if (!el) return;
        fireBeacon(el.getAttribute('data-track-event'), parsePayload(el));
    }, true);

    // Expose a programmatic API for JS-driven events (modal opens, tab switches,
    // search submissions, etc.) that aren't tied to a click element.
    window.AETrack = function (eventName, payload) {
        fireBeacon(eventName, payload);
    };
})();
