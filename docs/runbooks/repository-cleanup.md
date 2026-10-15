# Repository cleanup and preserved references

The owner requested cleanup on 2026-10-13. Application source, approved contracts,
migrations and design documents remain at their existing paths. This maintenance
does not establish feature, milestone or production acceptance.

## Cleanup checkpoint

The starting checkpoint was `a3ed194` on `feat/W01-foundation`. Another owner's
unfinished `apps/api/src/crm-service.ts` edit was preserved and excluded from the
cleanup commit. Separate Git worktrees and the GoDaddy demo history were untouched.

The external archive is:

```text
C:/Users/Monar/Agent8lite-archive/cleanup-20261013-015110/
  checkpoint-before.json
  work-in-progress-before.patch
  cleanup-plan.json
  actions.jsonl
  cleanup-actions.ps1
  preserved/
```

`cleanup-plan.json` records original and archive-relative paths, byte/file counts,
SHA-256 hashes for 422 reference files, retained blueprint asset hashes and the
database version marker. `actions.jsonl` records each completed move/removal.
The patch is a recovery checkpoint, not authority to overwrite newer work.

29 archive targets (approximately 2,140 MiB) were moved, including:

- Root audit/TDD ZIPs and extracted packages.
- Root `evidence/` and `reports/`, including their unique planning/report outputs.
- `check-inquiry.mjs`, `collect-public-evidence.ps1` and
  `scripts/test-media-insert.mjs`.
- Old local GoDaddy installation/source snapshots, compatibility downloads,
  report-generation probes, QA output and stopped-development process metadata.

11 disposable targets (approximately 795 MiB) were removed: Next development and
production output, the older task-build snapshot, compiled runtime output,
Playwright results, incremental TypeScript state, the owned portable-tool smoke
cache and empty disposable test directories. Minimal generated route types may
be recreated by `next typegen`; installed dependencies are retained.

The archive contains historical evidence and local probes. Keep it private and
outside recipient packages. Archiving reduced the working tree's contents;
archived files still occupy disk space.

## Retained and protected

| Path | Purpose |
| --- | --- |
| `apps/`, `packages/`, `tests/`, `scripts/` | Implementation and verification source. |
| `docs/tdd/`, `docs/adr/`, `docs/proposals/` | Approved scope, decisions and module coordination. |
| `blueprint/` | Original contracts, fixtures, diagrams and immutable design provenance. |
| `CLAUDE_COMPLETE_PROJECT.md`, `HANDOFF-CLAUDE-CODE.md` | Dated continuation instructions with maintenance notices. |
| `Start-Agent8lite.cmd`, `scripts/bootstrap/`, `docs/runbooks/bootstrap-windows.md` | Recipient setup tooling and documentation. |
| `.git/`, separate worktrees | Repository history and independent work. |
| `node_modules/` | Installed pinned dependencies; regenerate only when needed. |
| `.local/pgdata/`, `.local/postgres/`, `.local/postgis/` | Existing database and its native runtime. |
| `.local/private-objects/` | Existing private uploads. |
| `.local/trestle-contracts/`, `.local/trestle-docs/`, private environment files | Provider evidence/configuration; never commit or distribute. |

The canonical `blueprint/reference/Agent-Elite-Audit-2026-10-10.zip` and
`blueprint/report-preview.png` are retained because the original bundle manifest
references them. Root duplicates were archived. The raw audit ZIP is explicitly
Git-ignored; the preview is documentation. No blueprint manifest or original
contract was amended to accommodate housekeeping.

The owner's PostgreSQL shutdown remains in effect. The original development
launcher and its verified Node descendants were stopped before removing their
caches. This cleanup did not restart PostgreSQL, run migrations, seed data or
start application services. Other agents/processes were not terminated.

The owner subsequently requested **all project servers and databases remain
stopped until ZIP creation finishes**. The separate synthetic probe API on port
59999 was stopped, and the dedicated Memurai Redis-compatible service on port
6379 was stopped with `SHUTDOWN SAVE`. The owner's later explicit restart request
on 2026-10-13 ended this maintenance hold. The native database, Memurai, API, web
and synthetic reference worker have resumed; see the newest implementation-status
entry for startup checks. This runbook records cleanup's historical stopped state.

## Bounded verification

- Archived reference SHA-256 comparison: 422/422 pass; all 29 archive targets
  present at their recorded destinations. Original targets were removed; new
  scratch work created afterward is preserved separately.
- Canonical blueprint assets and existing database version marker: unchanged.
- All 31 files in the original blueprint SHA-256 manifest: pass.
- Bootstrap unit/boundary suite: 77/77 pass; no application/database service
  started by this suite.
- Exact original-plus-approved-amendment/generated contracts: 173 operations,
  174 schemas, pass.
- Next route types regenerated with `next typegen`, without a build or server.
- Root and web TypeScript: pass. Web validation used `--incremental false` to
  avoid regenerating the removed incremental cache.
- Scoped bootstrap Biome, PowerShell AST and Git diff whitespace: pass.

Fresh ignored scratch files created by other owners after the archive checkpoint
are not old cleanup targets; they are preserved. In particular, a newly recreated
`.local/generated-check.ts` is separate from its archived historical copy.

No migration, seed, database integration test, production build or browser
acceptance was executed for this cleanup. Compiled launch output must be rebuilt
before using `pnpm start`; generated output removal does not revoke older test
evidence, but older compiled artifacts are no longer available locally.

## Restoring an archived artifact

Look up its `source` and `target` in `cleanup-plan.json`. Inspect the destination
before restoring; do not overwrite a newer file. Move or copy only the selected
artifact from `preserved/` to its original path, using native PowerShell literal
paths. For reference files, verify the recorded SHA-256. Relative links within
old snapshots may require restoring the original directory location.

## Sharing and future housekeeping

Package intended tracked source and bootstrap files. Exclude `.git`,
`node_modules`, `.local`, `.pnpm-store`, `.next`, `.next-build`, `dist`, test
results, coverage, private environment files, raw audit evidence, agreements and
customer/provider exports. Include `.env.example`, the pnpm lockfile, migrations
and approved contracts. Never use a ZIP of the entire local working folder as
the recipient package.

Checkpoint active work before future cleanup. Inspect path references and process
ownership; remove only identified generated output. Preserve the database,
uploads and credentials. Use current `IMPLEMENTATION_STATUS.md` and actual source
for continuation; historical audit/planning reports are reference material.
