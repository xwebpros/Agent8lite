# W07 participant attribution contact integration

Shared prerequisite `f13ca01` / ADR-022 is imported before consumers. It permits only the reviewed optional nullable generated `Attribution.contact` email/phone object. The [official LVR attribution notice](https://members.lasvegasrealtor.com/news/article/idx-listing-attribution-policy) requires the listing firm and participant-provided contact beside primary listing facts, in readily visible color/type no smaller than the medium listing text.

Owned native mock reads accept the closed canonical attribution fields `brokerage`, `agent`, `disclaimer`, plus optional `contact` validated against the reviewed generated contract schema. Old records lacking contact and explicit null remain valid. Unknown properties or malformed contacts suppress the malformed source record. Projection includes a supplied contact only when **both** current native rights and display policy include exactly `attribution.contact`. No application member, listing agent, owner, office or unrelated canonical field provides a fallback.

List and detail place escaped firm/contact text immediately beside price/facts, using body-sized 1rem ink-colored text. Contacts are plain text, with no email/phone links, inquiry routing, media/logo guessing or delivery. Footer retains permitted agent, disclaimer and source freshness. Existing current refresh, tenant context, withdrawal and expiry handling remain unchanged.

## Proposed coordinator seed fixture change

Do not edit shared `packages/db/seed.ts` in this worktree. For the coordinator-reviewed synthetic mock read fixtures only, add `attribution.contact` to both approved field lists and supply these conspicuously fictional contacts in `brokerage_attribution` JSON:

- Email: `kind=email`, `value=attribution@fictional-brokerage.example.invalid`.
- Phone: `kind=phone`, `value=+1 702 555 0100` (fictional reserved sample number).

Owned disposable test fixtures use those values explicitly. Other existing fixtures remain absent/null; adding the schema property does not grant rights. Preserve existing feed/tenant IDs, original policy approval, ingestion/expiry, withdrawal and revisions. Do not broadly renew or overwrite existing seed data to expose the new field; root reviews any narrowly synthetic fixture update. No live provider implementation is changed here; root owns the Trestle mapping and mandatory live firm/contact suppression.

## Acceptance and limits

Verify supplied email/phone/null/absent, malformed/extra field rejection, independent rights omission, no unrelated-contact fallback, source-change cursor invalidation, tenant separation, withdrawal/expiry and escaped prominent static list/detail output. Run actual disposable PostgreSQL runtime-role repository/API tests, owned source suites, generated contracts, type/format checks and browser source bundling. Static rendering and CSS review are not browser/device accessibility or M5 acceptance. Live activation and exact current logo/disclaimer rights remain pending.
