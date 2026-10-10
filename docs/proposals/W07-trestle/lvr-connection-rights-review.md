# LVR connection23048 — implementation evidence and remaining gates

Reviewed locally on2026-10-10. This is an implementation mapping, not an activation approval. The original signed PDFs, extracted text and rendered pages remain in ignored `.local/trestle-contracts`; no signatures, personal contact details or credentials belong in Git.

## Evidence

Authenticated Trestle Contracts shows contract137415 approved/signing approved (execution2026-09-09) and contract136671 approved/signing approved (execution2026-08-24). Owner-supplied files were read, with signature/use-location page5 of the participant agreement visually inspected. Sources:

- Participant Data Access Agreement (2020 form),9pages, SHA-256 `2da887483403c6097b48aebfa57cfd13ad567fc28c16d3388aa3af60bf3f31b7`. Executed participant/subscriber selection is IDX and the named use domain is `jepsonrealestate.com`. General use checkboxes alone are not the selection evidence. Its attached Trestle exhibit identifies IDX Plus/WebAPI and a web product. This does not grant a blanket license for other SaaS organizations, participants or sites.
- Participant DLA/Subcontractor Addendum packet,19pages, SHA-256 `edf26c488f97b2f6e57c2e73d1900f0fc674646072c97d64b82fc64563c307c2`. Its PDL body refers actual permitted uses to the executed signature/exhibit and current MLS policies; the attached subcontractor terms do not expand the selected IDX use.
- Existing authorized metadata XML, SHA-256 `5bbed57d488d06e21bbb92bbfa63865944f35a34d15063aa40c5febe6652f103`, describes fields including AttributionContact, ListOfficeName, ListOfficePhone and Internet display flags. Field presence is not permission or a verified originating-system value.

## Boundaries to enforce

The participant agreement paragraphs4–5/12 and the PDL sections2.4/4.1/4.3/6.3 bind use to current MLS policies, named parties and approved use locations. A live resolver must derive the real tenant/feed/site from verified server context, match that site's approved origin and recheck current participant/subscriber affiliation at least daily. One approved customer must not authorize another customer's feed. Local synthetic organizations are not the licensed party. The application remains on mock listings.

PDL sections2.4/4.7/6.1/6.8 require express MLS-policy permission for AI use and licensed-data third-party/subprocessor access. AI, training, embeddings, alerts, media copying, public APIs, unrestricted caching and unspecified retention remain denied/unknown until the exact rights are verified. Compensation data from other participants is excluded by section2.5. Current termination/suspension must withdraw all derived displays; section9.5 calls for deleting licensed copies/derivatives on termination. Operational deletion and affiliation verification are not implemented merely by having credentials.

The [official IDX attribution notice](https://members.lasvegasrealtor.com/news/article/idx-listing-attribution-policy) requires the listing firm and participant-provided email or phone prominently alongside listing information. The current frozen ListingAttribution and canonical mapper do not represent that contact separately. This needs a reviewed contract/projection/rendering decision before live display; the current scaffold alone is insufficient. The [2026 Coming Soon bulletin](https://members.lasvegasrealtor.com/news/article/coming-soon-idx-syndication-matrix-listing-manager) changes eligible status handling but does not supply all current IDX rules; unsupported statuses remain suppressed by this bounded adapter.

## Remaining prerequisites

The public indexed March2025 rule PDF returned404; the MLS department redirects to member sign-in. Obtain the current complete MLS rules/IDX policy and any connection-specific field/display/retention instructions, including refresh interval, address/location, logo/disclaimer and attribution-contact semantics. Do not infer those values from older indexed rules, a platform guide or the metadata. Approval/exhibit scope must be bound to the exact real customer/site, never the mock fixture IDs. Preserve originals and resolve any uncertainty through the owner-approved rules; unknown rights deny.

Root must review the current rules, adopt the required attribution/site-eligibility contracts, implement server-side current authorization and secret resolution, prove revocation/withdrawal/freshness/tenant separation and approve the bounded activation gate. No new Property request or live application registration was performed during this review. The imported manual metadata probe remains a separate operator-only diagnostic, not a production policy store.
