# LVR / GLVAR feed agreement and rule sources

Checked on 10 October 2026. These sources support the next integration review; they are not an approved production DisplayPolicy.

| Information | Location | Verified scope |
| --- | --- | --- |
| Approved connection and executed agreements | [Trestle LVR connection](https://trestle.corelogic.com/TP/Connections/MLODetails/23048), Contracts tab | Connection and contract approval states were observed in the owner's authenticated portal. Executed agreement text has not been saved or reviewed for field/display/retention clauses. |
| Actual available Property fields and navigation resources | Ignored `.local/trestle-metadata.xml` in this scaffold checkout; local single-listing `report.json` includes an extracted inventory | Authenticated schema contains 758 Property fields and 14 navigation resources. Schema availability is not permission to display every field. |
| Full MLS rules, including applicable IDX policies | [LVR MLS department](https://members.lasvegasrealtor.com/mls/index.php), member login required | The public rulebook PDF link referenced by LVR's attribution notice returned HTTP 404 during this check. Obtain the applicable version through member access or the executed agreement. No archived rulebook is treated as current approval. |
| Published listing attribution guidance | [LVR IDX Listing Attribution Policy](https://members.lasvegasrealtor.com/news/article/idx-listing-attribution-policy) | Official notice dated 29 August 2022 discusses listing-firm identification and participant-provided contact information. Confirm the current agreement/rulebook version before implementing it. |
| Later IDX status update | [LVR Coming Soon IDX bulletin](https://members.lasvegasrealtor.com/news/article/coming-soon-idx-syndication-matrix-listing-manager) | Official notice dated 22 May 2026 describes Coming Soon syndication effective 3 June 2026. The current adapter and diagnostic still restrict their implemented statuses; this notice alone does not enable another status. |
| Trestle protocol/query behavior | [WebAPI documentation](https://trestle-documentation.corelogic.com/web-api/) and [query reference](https://trestle-documentation.corelogic.com/web-api/reference/) | Transport, metadata, Property queries and related-resource expansion; not MLS-specific usage rights. |

The owner-supplied files `C:/Users/Monar/Downloads/Trestle for Technology Providers Release v3.pdf` and `C:/Users/Monar/Downloads/Trestle for Multiple Listing Managers Release v3.pdf` are platform guides, not the executed LVR agreement. They are not redistributed here.

No verified feed-specific rule file currently establishes the allowed field projection, address/location treatment, exact attribution, refresh deadline, retention/deletion interval, media storage, cache, alert or AI rights. Those remain unknown in the application policy until the executed agreement and applicable MLS rules are reviewed. The separately authorized local one-listing diagnostic does not fill those gaps or activate the application provider. Keep credentials in the existing ignored environment file.
