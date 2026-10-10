# Agent8lite

Agent8lite is an in-progress real estate SaaS web application, designed to work as an installable iPhone and Android PWA without app-store distribution. The selected MLS provider is Cotality/CoreLogic Trestle.

## Application workstreams

- [Committed application foundation](https://github.com/xwebpros/Agent8lite/tree/feat/W01-foundation): runtime, database, API, web/PWA and tested implementation checkpoints. Read that branch's `IMPLEMENTATION_STATUS.md` for verified outcomes and remaining gates.
- [Trestle Web API scaffold](https://github.com/xwebpros/Agent8lite/tree/feat/W07-trestle-scaffold): disabled server adapter, OAuth, policy-bound listing mapping, mocked tests and a separately enabled read-only metadata probe. The [runbook](https://github.com/xwebpros/Agent8lite/blob/feat/W07-trestle-scaffold/docs/runbooks/trestle-feed.md) describes secure local setup.

Feature branches preserve ongoing work for coordinator review. Publication is not a production release or a claim that all requirements have been implemented. Active uncommitted owner changes are not included in these checkpoints; no automatic merge or live-provider activation occurs.

## Requirements and reference artifacts

- [Executive requirements PDF](reports/executive/Agent8lite-Application-Requirements-and-Features-2026-10-10.pdf) and [editable Word document](reports/executive/Agent8lite-Application-Requirements-and-Features-2026-10-10.docx).
- [Technical design](docs/tdd/) and [implementation blueprint](blueprint/).
- [Technical design package](Competitive-Real-Estate-SaaS-TDD-2026-10-10.zip).
- [Agent Elite audit package](Agent-Elite-Audit-2026-10-10.zip), [audit source](Agent-Elite-Audit-2026-10-10/) and [sanitized reference evidence](evidence/).
- [Reports and document-generation sources](reports/).

The audit is reference evidence about the observed platform, not permission to reuse proprietary functionality or a statement that inferred internal architecture is known. The blueprint describes planned behavior. The executive document is the forward-facing product requirements artifact.

See [publication notes](PUBLICATION_NOTES.md) for the archive redaction and reference-integrity boundary. Local environments, credentials, source Trestle PDF manuals, dependencies, databases, rendering QA and transient caches are excluded.
