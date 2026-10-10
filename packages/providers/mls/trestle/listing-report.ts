import type { ListingInspection } from "./listing-probe";

const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
  );
const format = (value: unknown) => (value === undefined ? "NOT RETURNED" : JSON.stringify(value, null, 2));

/** No scripts, image fetches or clickable provider URLs; raw values remain local. */
export function listingInspectionHtml(result: ListingInspection): string {
  const fields = result.schema.fields
    .map(
      ({ name, type }) =>
        `<tr><th>${escape(name)}<small>${escape(type)}</small></th><td><pre>${escape(format(result.listing[name]))}</pre></td></tr>`,
    )
    .join("");
  const related = result.summary.related
    .map(
      ({ name, records, complete }) =>
        `<details><summary>${escape(name)} · ${records ?? "not returned"} records · ${complete ? "complete" : "incomplete"}</summary><pre>${escape(format(result.listing[name]))}</pre></details>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Local MLS listing inspection</title><style>body{font:16px system-ui;background:#f3f5f8;color:#17233a;margin:0}main{max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:30px}p{line-height:1.6}.notice{padding:16px;background:#fff1ce;border-radius:8px}.stats{display:flex;flex-wrap:wrap;gap:16px}.stats p{padding:20px;background:white;border-radius:8px;flex:1}.stats strong{display:block;font-size:28px}table{width:100%;border-collapse:collapse;background:white}th,td{padding:12px;border-bottom:1px solid #e1e5ed;text-align:left;vertical-align:top}th{width:35%;overflow-wrap:anywhere}small{display:block;color:#56647b;font-weight:400;margin-top:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:13px/1.6 monospace}details{background:white;padding:16px;margin:12px 0}summary{cursor:pointer;font-weight:600}details pre{margin-top:16px}@media(max-width:600px){main{padding:0 12px}th,td{padding:8px}h1{font-size:24px}}</style></head><body><main><h1>Local MLS listing inspection</h1><p>Retrieved ${escape(result.retrievedAtUtc)} · One active listing from the approved feed</p><p class="notice">Private operator diagnostic. Contains licensed feed data. Keep this file local. This report does not authorize public display or use in AI. Media URLs are text only; no photos or remote assets are downloaded.</p><div class="stats"><p><strong>${result.summary.returnedFieldCount}</strong>Property fields returned</p><p><strong>${result.summary.populatedFieldCount}</strong>Fields with values</p><p><strong>${result.summary.related.length}</strong>Related resources requested</p></div><p>Schema: ${result.summary.schemaFieldCount} fields. ${result.summary.complete ? "All described fields and related collections were returned within the test limits." : "Some fields or related data were omitted or limited; inspect the JSON completeness summary."} Null means the feed returned no value; NOT RETURNED means the field was omitted.</p><h2>Related resources</h2>${related}<h2>Property fields</h2><table><thead><tr><th scope="col">Field / type</th><th scope="col">Feed value</th></tr></thead><tbody>${fields}</tbody></table></main></body></html>`;
}
