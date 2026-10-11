# ADR-050 — Workflow condition branch authoring in the PWA

Accepted by the coordinating session on 2026-10-11. This bounded M4 slice advances MOD-E-002 ("conditions use an allowlisted lead-filter DSL"), the MOD-E UI requirement for "a versioned workflow canvas plus accessible ordered list", and MOD-K-006/007. It changes only the PWA. It adds no contract amendment, migration, dependency, server route, event or provider behavior: the frozen `CampaignVersionWrite`/`WorkflowNode`/`WorkflowEdge`/`LeadFilter` schemas and the ADR-023 server validation and source-authority checks already accept condition nodes with `true`/`false` branches.

## Problem

ADR-023 saves immutable draft workflow versions whose graphs may contain condition nodes. The PWA editor is linear only: it can author wait, task, email and SMS chains, shows stored condition predicates read-only, and refuses to copy any graph with a condition. Users therefore cannot author a condition from the PWA, so MOD-E-002 is reachable only through the raw API.

## Decision

### Structured outline

The editor authors a **structured outline**, not a free graph. An outline is an ordered list of items. An item is either a step (wait, task, email, SMS) or a condition holding a `LeadFilter` and two child outlines, **When the lead matches** (`true`) and **Otherwise** (`false`). Both branches rejoin at the item that follows the condition. Nesting depth is limited to 3 conditions, and the existing 100-node and 200-edge limits apply to the whole definition.

This is rendered as the accessible ordered list MOD-E names: nested `<ol>` lists with headings per branch and explicit buttons (add step to this branch, move up/down within its list, remove). No drag-and-drop or canvas is required for any operation. Removing a condition requires its branches to be empty first, so steps are never deleted as a side effect.

### Outline to graph

Serialization is deterministic and keeps every node key:
- Consecutive items are joined by an `always` edge from the last node of an item to the first node of the next item.
- A condition emits one `true` edge to the first node of its true branch (or to its continuation when that branch is empty) and one `false` edge likewise. The last node of each non-empty branch gets an `always` edge to the continuation.
- The continuation is the first node of the next item in the same list, otherwise the parent's continuation, otherwise none.

Local validation adds platform messages before the shared `validateWorkflowDefinition` check:
- both branches empty: "Add a step to at least one branch of this condition."
- an empty branch with no continuation: "A condition at the end of the workflow needs a step in both branches."
- depth over 3: "Conditions can be nested at most three levels deep."

### Graph to outline (copying a saved version)

`copySelected` parses the saved graph back into an outline. For each condition, its rejoin point is the earliest node reachable from both branch targets (or the enclosing stop). A graph is accepted only if re-serializing the parsed outline yields exactly the same node set and the same edge set (order-insensitive). Anything else stays read-only with the existing message. This round-trip check means a parsing heuristic can never silently change a stored graph.

Linear graphs remain a special case of the outline, so existing linear drafts behave as before.

### Condition predicates

The condition editor offers only the frozen `LeadFilter` fields, and at least one is required (the shared validator already enforces this):
- **Intent**: buyer, seller, both or unknown.
- **Stage**, **Source**: one choice each from the frozen `listPipelineStage` / `listLeadSource` pages (limit 100), read when a condition editor is first opened while online.
- **Tags**: up to 20 unique choices from `listTag` pages (25 per page, at most 200 per binding).
- **Assigned to me**: sets `ownerMemberId` to the verified session member. The client does not guess organization scope, so it offers no arbitrary owner picker (same limit as ADR-045).
- **Name contains**: bounded nonblank `q` text, at most 200 characters.

Reference catalogues are private tab memory bound to the existing workflow binding. They are cleared with the draft on detach, revoke, context change and offline, and never enter URLs, history, service-worker storage or IndexedDB. A stored reference that is not in the current catalogue page is shown as "Saved reference (not in the current list)" and is kept unless the person explicitly changes that field. Catalogue `401`/`403` follows the existing workflow access-loss path; a catalogue failure leaves other fields editable and states that choices could not be verified.

Server authority is unchanged: ADR-023 rechecks organization-scoped `crm.leads.read`, CRM entitlement and every referenced stage, source, tag and active owner on save, read and replay. Its `422 workflow_reference_unavailable` field errors already map to node fields in `campaign-workflow-protocol.ts`.

### Preview

The existing deterministic preview, with an explicit true/false choice per reached condition, works unchanged on branched drafts.

### Command and lifecycle

Saving still uses the existing immutable `WorkflowDraftCommand`, original key, exact-body acknowledgement, uncertain/rejected phases and Workspace protection. No new pending command type is introduced, so no new Workspace guard is needed beyond the existing workflow protection.

## Ownership and acceptance

Frontend owns `apps/web/components/campaign-workflow-*` and a new `campaign-workflow-outline.ts`. Tests: a new `tests/unit/campaign-workflow-outline.test.ts` covering serialization, every local issue, parse round-trips for linear, single, nested and reconverging graphs, rejection of non-structured graphs (cross edges, shared tails that are not the rejoin point, multiple entries), key preservation and limits; controller tests for adding/moving/removing within branches, predicate editing, catalogue privacy/clearing and copying a branched version; and the existing retained workflow suites. A fresh integration run of the existing campaign workflow API suite confirms the server accepts the serialized graphs (a new integration case saves a two-branch definition). Browser/axe/keyboard/device acceptance remains blocked.
