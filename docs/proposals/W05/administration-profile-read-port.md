# Administration profile reference read port

Proposed 2026-10-10 after coordinator review 221af81; owned CMS consumers may proceed with an explicitly supplied verified resolver. Shared implementation/location belongs to the administration/coordinator owner.

```ts
interface CmsProfileReferencePort {
  requireActiveReference(profileId: string): Promise<{
    id: string;
    organizationId: string;
  }>;
}
```

Bind the implementation to the **same PoolClient and verified TenantContext** used by the CMS service. The resolver requires the current tenant profile to exist and remain eligible for references, locks its row FOR SHARE until the caller commits, and returns only ID/organization ID. Missing/foreign/archived profiles throw the same safe resource-unavailable error. CMS additionally checks returned ID/organization against its requested ID and verified context. It does not query or mutate business_profile, accept a profile snapshot from a request, or start another transaction. The resolver's trusted factory is supplied by the coordinator; no default permissive implementation exists.

The reference permission is the already-approved CMS sites/content organization grant, not a new profiles.read grant: the resolver verifies only whether a profile may be referenced, not private profile fields. Direct administration reads retain their own permissions. Existing app.business_profile has no archived_at/status column in migrations 0001–0011. Administration must define eligibility for its existing/future archive semantics; CMS must not invent a JSON archive flag or new shared column. The disposable harness can verify real tenant-scoped profile lookup/locking and explicit resolver refusal, but cannot claim production archive behavior until that administration implementation is integrated.

Service exports CmsProfileReferencePort in packages/cms/ports.ts as the provisional owned type. Coordinator can later re-export/move that exact interface to an approved shared internal service-port location. No shared dependency, contract or migration edit is required for this interface proposal.
