# Administration profile reference read port

Proposed 2026-10-10 after coordinator review 221af81; the coordinator committed the exact shared interface and administration factory at 4559d98. CMS consumes the canonical packages/contracts/internal/profile-reference-port.ts declaration through a type re-export. Only that exact reviewed declaration was restored as a dependency in this checkout; the mixed root commit was not cherry-picked and the root factory remains for coordinator route integration.

```ts
interface CmsProfileReferencePort {
  requireActiveReference(profileId: string): Promise<{
    id: string;
    organizationId: string;
  }>;
}
```

Bind the implementation to the **same PoolClient and verified TenantContext** used by the CMS service. The current resolver requires an existing tenant profile, locks its row FOR SHARE until the caller commits, and returns only ID/organization ID. Missing/foreign profiles throw the same safe resource-unavailable error. CMS additionally checks returned ID/organization against its requested ID and verified context. It does not query or mutate business_profile, accept a profile snapshot from a request, or start another transaction. The reviewed root factory createCmsProfileReferencePort also checks an organization CMS grant, websites capability and matching current actor/tenant. No default permissive CMS resolver exists.

The reference permission is the already-approved CMS sites/content organization grant, not a new profiles.read grant: the resolver verifies only whether a profile may be referenced, not private profile fields. Direct administration reads retain their own permissions. Existing app.business_profile has no archived_at/status column in migrations 0001–0011. Administration must define eligibility for its existing/future archive semantics; CMS must not invent a JSON archive flag or new shared column. The disposable harness can verify real tenant-scoped profile lookup/locking and explicit resolver refusal, but cannot claim production archive behavior until that administration implementation is integrated.

packages/cms/ports.ts now re-exports the exact canonical CmsProfileReferencePort, rather than maintaining a duplicate interface. Coordinator-reported factory acceptance: 4/4 isolated real-runtime-role tests passed, covering capability/scope/cross-tenant denial, profile deletion blocked through caller rollback and detached context/pool reuse. Those root tests were read, not rerun in this worktree. The CMS disposable harness continues to supply its explicit test resolver and its 22-case acceptance remains separate evidence.
