# Agent8lite — Claude Code handoff

> Maintenance note, 2026-10-13: this is a historical handoff. The owner's later cleanup authorization supersedes its prohibition on moving the listed raw artifacts: they were archived with hashes and an original-path restore map at `C:/Users/Monar/Agent8lite-archive/cleanup-20261013-015110/preserved/`. The canonical blueprint remains. PostgreSQL was stopped at the owner's request; the original development servers were stopped for cleanup. Inspect current Git/process state and read `docs/runbooks/repository-cleanup.md` and the newest implementation-status entries before continuing.
>
> The owner subsequently requested service restart on 2026-10-13, superseding the earlier ZIP maintenance hold. Consult the newest `IMPLEMENTATION_STATUS.md` entry and current process identity for runtime state.

Read this file first, then `AGENTS.md` and the top three sections of `IMPLEMENTATION_STATUS.md`. Those two files are authoritative; this file explains how to work efficiently in this repo with several agents.

## 1. Where things stand (2026-10-11)

| Item | Value |
| --- | --- |
| Repository | `https://github.com/xwebpros/Agent8lite` |
| Working branch | `feat/W01-foundation` (pushed, remote-verified) |
| Latest checkpoint | `01ef1a2` |
| `main` | Separate published demo history. Never merge into it or push to it. |
| Last full gate | `node scripts/test-isolated.mjs`: **4,456/4,456**, 142 files, 40 batches, 0 failures |
| Running dev app | Web `http://localhost:3000`, API `http://127.0.0.1:3001`, PostgreSQL/PostGIS `127.0.0.1:55432`. Do not stop them. |

Completed this session (details in `IMPLEMENTATION_STATUS.md`):
- **ADR-046 Task update/completion:** every gate passes except browser checks. Two web-app bugs were fixed (agenda completion did nothing; a `412` left the workspace stuck as dirty).
- **ADR-047 Contact/Lead archive:** API, PWA drawer actions, frozen `contact.archived` event.
- **ADR-048 `contact.updated` event:** internal additive contract plus producer.
- **Fixture fix:** synthetic listing fixtures expired on 2026-10-11, so the seeder now shifts newly seeded rows onto the database clock.

Next work, in dependency order:
1. **Contact merge / duplicate review (MOD-D-005, MOD-D acceptance 5).** The frozen OpenAPI has no merge operation, so start with a contract-proposal ADR (next number: ADR-049). Write no code before that ADR is committed.
2. **M4 condition and segment authoring.** It uses the now-complete Contact/Lead event family.
3. **Review notes not yet acted on:**
   - Task PATCH/create lock membership before Lead, while Lead PATCH locks Lead before membership.
   - The client timezone regex is looser than the server's.
   - The archive confirmation step doesn't receive focus when it opens.
4. **Blocked, so record the blocker and move on:**
   - Browser/axe/keyboard/device acceptance: needs authorized browser tooling.
   - M1 Redis restart/data loss and fully green CI: no Redis, Docker or WSL on this machine.
   - M6 live Trestle, real messaging, payments, production: need owner authorization and information.

Unrecorded, untracked files belong to the owner and must never be staged, moved or deleted: `Agent-Elite-Audit-*`, `Competitive-Real-Estate-SaaS-TDD-*`, `blueprint/reference/*.zip`, `blueprint/report-preview.png`, `collect-public-evidence.ps1`, `evidence/`, `reports/`.

## 2. Toolchain: git, node and pnpm are NOT on PATH

Run this at the start of every PowerShell command, or save it as a script outside the repo:

```powershell
$env:PATH = "C:\Users\Monar\.codex\tmp\trestle-scaffold-runtime\node-v24.19.0-win-x64;" +
  "C:\Users\Monar\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd;" + $env:PATH
function pnpm { & "C:\Users\Monar\.codex\tmp\trestle-scaffold-runtime\node-v24.19.0-win-x64\node.exe" `
  "C:\Users\Monar\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\pnpm\bin\pnpm.mjs" @args }
```

This gives the pinned Node 24.19.0 (matches `.node-version`), pnpm 11.25.0 (matches `packageManager`) and git 2.53. Do not install or upgrade global tools.

If these Codex-provided paths ever disappear, install Node 24.19.0 and Git and ask the owner before changing pins.

## 3. Verification commands

| Purpose | Command | Time |
| --- | --- | --- |
| Pure/unit suite | `node node_modules/vitest/vitest.mjs run tests/unit packages` | ~90 s |
| One integration file (fresh disposable DB + API) | `node scripts/test-isolated.mjs tests/integration/<file>.test.ts` | ~1–2 min |
| Full gate (every integration file isolated) | `node scripts/test-isolated.mjs` | **~45 min** |
| Root + web TypeScript | `pnpm typecheck` (root `tsc` also covers `tests/`) | ~1 min |
| Contracts + generated types | `node scripts/check-contracts.mjs --generated` | seconds |
| Full Biome | `pnpm lint` | seconds |
| Production build (never touches dev `.next`) | `$env:ESTATE_BUILD_DIR='.next-build'; node scripts/build-app.mjs` | ~2 min |
| Compiled runtime / local API / launch probes | `node scripts/verify-runtime.mjs`, `verify-runtime-local.mjs`, `verify-launch-local.mjs` | ~3 min |

Rules learned the hard way:
- **Never edit `apps/api/**` or `packages/**` while an isolated suite is running.** Each batch starts the API and seed from source, so a mid-run edit silently changes later batches. `apps/web/**` and `docs/**` are safe once batch 1 (the unit batch) has finished.
- **Run only one database-verification process at a time.** All runners share the cluster on port 55432 and its roles, and several processes against one API also hit per-member rate limits. Run integration files one at a time, never combined into a single invocation.
- **Run long gates in the background** and keep working on files the gate doesn't read.
- The frozen `getJob` contract returns **202**, not 200.
- **PowerShell 5.1 pitfalls:**
  - `git commit -F -` with a here-string doesn't work; write the message to a file and use `-F <file>`.
  - `Set-Content -NoNewline` joins lines.
  - For byte-exact `git show <rev>:<path>`, use `cmd /c "git show ... > file"`.
- Commit with explicit paths (`git add -- <files>`), never `git add .`. Push only `feat/W01-foundation`.

## 4. Engineering procedure for every slice

1. Write the ADR in `docs/adr/ADR-0NN-*.md`, plus any internal contract under `packages/contracts/internal/` registered in `scripts/check-contracts.mjs`. **Commit it before any consumer code.** Frozen blueprint contracts never change.
2. Backend: add a dedicated command boundary in `apps/api/src`, registered in `apps/api/src/main.ts` ahead of the generic `crm.idempotent` fallback. Copy the recoverable-command pattern from `patchContact`, `patchLead`, `patchTask` and `archiveContact` in `crm-service.ts`:
   - detach and validate input before any wait
   - advisory lock on tenant/actor/route/key
   - inspect the receipt even when expired
   - lock in a fixed order (Contact → Lead → membership/office), then recheck after the wait
   - compare-and-swap
   - write the audit, receipt and outbox entries in the same transaction
   - recheck authority and receipt expiry before returning
3. Tests: write a new `tests/integration/<slice>.test.ts` against real runtime roles. Cover races, replay, expiry, scope, revocation and actual lock waits, as `archive-api.test.ts` does. When behavior changes on purpose, update the retained tests deliberately and say so.
4. PWA: give each slice a protocol, controller and panel module in `apps/web/components`, modeled on `record-archive*.ts(x)` and `task-edit*.ts(x)`. Add every new pending command to **all** Workspace guards: refresh, `taskEditAllowed` `otherProtected`, the capture-phase link guard, organization switch, sign-out, service-worker reload and drawer close. Add an executable source-wiring test in the style of `tests/unit/task-edit-workspace.test.ts`.
5. Run the gate: targeted suites → full `test-isolated` → typecheck, contracts, lint → build → runtime/launch probes.
6. Update `IMPLEMENTATION_STATUS.md` with a new top section containing exact counts. Never rewrite historical results. Commit, push, confirm `HEAD == origin/feat/W01-foundation`, then start the next slice without waiting to be asked.

## 5. Running several agents from the desktop app

### 5.1 Roles and file ownership

The main session is the **coordinator**. It alone edits shared files, makes commits, pushes and runs the full gate.

| Agent | May edit | Never edits |
| --- | --- | --- |
| Coordinator (main session) | ADRs, `packages/contracts/**`, migrations, `package.json`/lockfile, `scripts/**`, `apps/api/src/main.ts` route registration, `IMPLEMENTATION_STATUS.md` | — |
| `backend` | `apps/api/**` (except route registration unless told), `packages/db/**`, `packages/auth/**` | `apps/web/**`, contracts, migrations without coordinator approval |
| `frontend` | `apps/web/**`, `packages/ui/**`, new `tests/unit/<slice>-*.test.ts(x)` | `apps/api/**`, `packages/**`, `tests/integration/**` |
| `qa-reviewer` | nothing (read-only review); may add `tests/**` only when explicitly asked | product code |
| `Explore` (built-in) | nothing; wide searches only | — |

`apps/web/components/workspace.tsx` is about 6,000 lines. **Only one agent may edit it at a time.**

### 5.2 Patterns that worked here

- **Contract first, then fan out.** Commit the ADR, then start the `frontend` agent in the background on the PWA half while the coordinator (or `backend`) builds the API and integration tests. The two halves share only the frozen HTTP contract, so they don't collide.
- **Review alongside long runs.** Start a read-only `qa-reviewer` on the latest commit (`git show <sha>`) while the 45-minute gate runs. In this session that found two real bugs. Verify each finding yourself before changing code; one of three findings here was a false positive.
- **Agents start with no context.** Each prompt must include:
  - the PowerShell PATH snippet from section 2
  - the ADR path
  - the reference files to copy patterns from
  - the files it owns
  - the exact commands that must pass: `pnpm typecheck` (**root**, not only the web check), `node node_modules/vitest/vitest.mjs run tests/unit packages`, Biome on every touched file
  - "do not commit or push; do not stop the dev servers on ports 3000/3001; do not run `test-isolated`"
- **Integrate yourself.** Rerun the agent's checks, read its core logic, then commit with explicit paths. An agent's report is not evidence until you have rerun the checks.
- **Database tests have one owner.** Agents may run pure/unit tests freely. Only the coordinator runs `scripts/test-isolated.mjs` (see section 3).

### 5.3 Ready-to-use agent definitions

Save these as `.claude/agents/<name>.md` in the repo (project scope) so every session can call them by name. Give the `model:` field only if you want to pin one; omit it to inherit the session model.

`.claude/agents/backend.md`:
```markdown
---
name: backend
description: Agent8lite API/database implementer. Use for apps/api, packages/db, packages/auth work on a committed ADR.
tools: Read, Edit, Write, Grep, Glob, PowerShell
---
You implement backend slices in C:\Users\Monar\Agent8lite following AGENTS.md and the named ADR.
Prepend the PATH snippet from HANDOFF-CLAUDE-CODE.md section 2 to every PowerShell command.
Copy the recoverable-command pattern from crm-service.ts (patchContact/patchLead/patchTask/archiveContact).
Edit only apps/api/**, packages/db/**, packages/auth/** and the new integration test file you are given.
Before reporting: pnpm typecheck, Biome on touched files, and ONE `node scripts/test-isolated.mjs <your file>` run
if and only if the coordinator said the database is free. Never commit, push, or stop dev servers.
Report changed files, exact test counts, deviations from the ADR, and open risks.
```

`.claude/agents/frontend.md`:
```markdown
---
name: frontend
description: Agent8lite PWA implementer. Use for apps/web and packages/ui work on a committed ADR.
tools: Read, Edit, Write, Grep, Glob, PowerShell
---
You implement PWA slices in C:\Users\Monar\Agent8lite following AGENTS.md and the named ADR.
Prepend the PATH snippet from HANDOFF-CLAUDE-CODE.md section 2 to every PowerShell command.
Model new commands on apps/web/components/record-archive*.ts(x) and task-edit*.ts(x); add every pending
command to all Workspace lifecycle guards. Edit only apps/web/**, packages/ui/** and new tests/unit/<slice>-* files.
Before reporting: `pnpm typecheck` (ROOT - it covers tests/), `node node_modules/vitest/vitest.mjs run tests/unit packages`,
Biome on touched files. Never run test-isolated, commit, push, or stop dev servers. Do not claim browser verification.
Report changed files, exact test counts, deviations from the ADR, and what remains open.
```

`.claude/agents/qa-reviewer.md`:
```markdown
---
name: qa-reviewer
description: Read-only independent reviewer for an Agent8lite commit or diff. Use while long test gates run.
tools: Read, Grep, Glob, PowerShell
---
You review C:\Users\Monar\Agent8lite read-only. Prepend the PATH snippet from HANDOFF-CLAUDE-CODE.md section 2.
Never edit files, stage, commit, run tests or write to databases.
Review the given commit (`git show <sha>`) against its ADR and the accepted reference implementation.
Check tenant/scope authorization, receipt/idempotency handling, lock order, rollback atomicity, event privacy,
and client stale-callback/lifecycle-guard/identity bugs. Report only concrete defects with file:line and a failure
scenario, most severe first, then a short list of lower-confidence concerns. Under 800 words.
```

### 5.4 Parallel desktop sessions and worktrees

The subagents above share one checkout, and file ownership keeps them apart. To run **separate desktop sessions** on independent slices at the same time (for example the merge-contract proposal in one and an M4 UI slice in another):
- Give each session its own git worktree and branch (`feat/Wxx-short-purpose`, branched from the current `feat/W01-foundation` head). `AGENTS.md` requires one worktree per workstream in that case. The coordinator session merges reviewed branches back into `feat/W01-foundation` in dependency order.
- Only the coordinator session allocates migration numbers, edits contracts or dependencies, runs `test-isolated` and pushes.
- A worktree needs its own `node_modules` (`pnpm install --frozen-lockfile` with the pinned pnpm). Never point it at the dev servers' ports.

Large multi-agent workflows (the Workflow tool) run only when you explicitly ask for one, for example by saying "use a workflow". Use one for wide parallel review or test-triage passes, not for routine slices.

## 6. Session start checklist

1. Run the PATH snippet; `git status --short --branch`; confirm `HEAD == origin/feat/W01-foundation` and that only the owner's untracked files listed in section 1 appear.
2. Read `AGENTS.md`, this file and the top of `IMPLEMENTATION_STATUS.md`.
3. Confirm the dev app answers on ports 3000/3001; don't restart it.
4. Pick the next item from section 1, write and commit its ADR, then fan out as described in section 5.
5. End every session with an `IMPLEMENTATION_STATUS.md` update containing exact evidence, the commit and push, and a short report of completed work, test evidence, blockers and the next checkpoint.
