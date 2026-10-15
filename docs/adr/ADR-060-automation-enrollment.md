# ADR-060 — Automation Rules and Lead Enrollment

**Status:** Accepted

**Date:** 2026-10-12

**Workstream:** W01/Foundation — Marketing module

## Context

The blueprint (0001) defines `app.automation_rule` and `app.enrollment` tables but provides only a coarse `tenant_scope` permissive policy with no grants to `estate_runtime`. The marketing module requires create/read/update access to automation rules and create/cancel access to enrollments, scoped to the verified tenant context.

Column naming in the blueprint (`trigger_type`, `condition`, `row_version bigint`) differs from the initial service prototype, requiring alignment.

## Decision

Migration 0028 is an additive migration that extends the existing blueprint tables without recreating them:

1. **Column additions**: `version int` added to both `automation_rule` and `enrollment` for ETag-based optimistic locking; `current_step text` added to `enrollment` for workflow position tracking.

2. **RESTRICTIVE RLS policies**: Separate `RESTRICTIVE` policies for `estate_runtime` on top of the existing permissive `tenant_scope`, following the same pattern established in 0027 for campaign lifecycle.

3. **Column-level GRANTs**: `SELECT, INSERT` on both tables; `UPDATE` scoped to mutable columns only.

4. **Enrollment state**: The existing schema has `state NOT NULL` without a `DEFAULT`. The service INSERT explicitly provides `state='active'` to satisfy both the NOT NULL constraint and the `runtime_enrollment_insert` RESTRICTIVE policy `WITH CHECK (... AND state = 'active')`.

5. **Source event tracking**: `source_event_id` (from 0001's UNIQUE constraint) is populated with the caller's idempotency key, making each enrollment attempt uniquely traceable.

## Service design

- `AutomationService.createAutomation()`: advisory lock + idempotency record, maps `trigger_type`/`condition` DB columns to `trigger`/`conditions` API fields.
- `AutomationService.updateAutomation()`: optimistic lock via `row_version` + ETag If-Match; revision mismatch returns 412.
- `AutomationService.enrollLead()`: validates published campaign version via `app.idempotency_record` (same RLS-bypass technique as ADR-059); validates lead existence in `app.contact`; idempotent per key.
- `AutomationService.cancelEnrollment()`: RESTRICTIVE UPDATE policy enforces `state NOT IN ('completed','cancelled')` at the DB layer; a second cancel with a different key returns 409.

## Consequences

- Blueprint column names (`trigger_type`, `condition`) are used in SQL; the service maps them to camelCase API fields.
- Enrollment uniqueness is enforced by the 0001 UNIQUE constraint `(tenant_id, lead_id, campaign_version_id, source_event_id)`.
- The `version` column (optimistic lock counter) is separate from `row_version` (audit counter) to allow independent increment semantics.
