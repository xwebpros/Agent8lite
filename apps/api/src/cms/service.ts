import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  documentEtag,
  planDraftAppend,
  recoverDraft,
  requireDraftVersion,
  resolveSiteTemplate,
  templateThemeVersion,
} from "../../../../packages/cms";
import type { CmsProfileReferencePort } from "../../../../packages/cms/ports";
import { revisionRecovery } from "../../../../packages/cms/recovery";
import { requireRevisionHistory } from "../../../../packages/cms/history";
import type { components } from "../../../../packages/contracts/generated/api";
import { requireEntitlement } from "../../../../packages/auth/entitlements";
import {
  AccessError,
  requirePermission,
  type TenantContext,
} from "../../../../packages/db/tenant-transaction";
import { listTemplateDefinitions } from "../../../../packages/templates/catalog";
import type { PublishPolicy } from "../../../../packages/templates/registry";
import { validateSchema } from "../contract-validation";
import { assertUuid, CrmService, stable } from "../crm-service";
import { cursorBinding, decodeCursor, encodeCursor } from "../cursors";
import {
  CmsRepository,
  type DocumentRow,
  type DomainRow,
  type FormRow,
  type MediaRow,
  type RevisionRow,
  type SiteRow,
} from "./repository";

type Schemas = components["schemas"];
type Mutation<T> = { body: T; status: number; etag: string };
type CommandHeaders = { key: string | undefined; ifMatch?: string };
type Query = Record<string, unknown>;
function unavailable(): never {
  throw new AccessError(404, "resource_unavailable", "Resource unavailable or out of scope.");
}
const domainModel = (row: DomainRow): Schemas["Domain"] => ({
  id: row.id,
  hostname: row.hostname,
  verificationState: row.verification_state as Schemas["Domain"]["verificationState"],
  tlsState: row.tls_state as Schemas["Domain"]["tlsState"],
  environment: row.environment,
  requiredDns:
    row.verification_state === "pending"
      ? [{ type: "TXT" as const, name: `_verify.${row.hostname}`, value: `estate-verify=${row.id}` }]
      : [],
});
const mediaModel = (row: MediaRow): Schemas["Media"] => ({
  id: row.id,
  mimeType: row.mime_type,
  bytes: Number(row.byte_size),
  scanState: row.scan_state as Schemas["Media"]["scanState"],
  altText: row.alt_text ?? null,
  previewUrl: null,
  version: Number(row.row_version),
});
const formModel = (row: FormRow): Schemas["Form"] => ({
  id: row.id,
  version: row.version,
  name: row.name,
  fields: (row.definition as { fields: Schemas["FormField"][] }).fields ?? [],
  state: row.state as Schemas["Form"]["state"],
});
const siteModel = (row: SiteRow): Schemas["Site"] => ({
  id: row.id,
  name: row.name,
  businessProfileId: row.business_profile_id,
  state: row.state,
  themeVersion: row.theme_version,
  publishedAt: row.published_at?.toISOString() ?? null,
  version: Number(row.row_version),
});
const documentModel = (row: DocumentRow): Schemas["Document"] => ({
  id: row.id,
  siteId: row.site_id,
  slug: row.slug,
  kind: row.kind,
  title: row.title,
  publishedRevisionId: row.published_revision_id,
  version: Number(row.row_version),
});
function revisionModel(row: RevisionRow): Schemas["Revision"] {
  const body = {
    id: row.id,
    documentId: row.document_id,
    schemaVersion: row.schema_version,
    blocks: row.block_data,
    seo: row.seo,
    createdAt: row.created_at.toISOString(),
  };
  // Future kinds must use the explicit recovery read; frozen v1 cannot represent them.
  try {
    validateSchema("Revision", body, true);
  } catch (error) {
    if (error instanceof AccessError && error.code === "response_contract_failure")
      throw new AccessError(
        409,
        "revision_recovery_required",
        "The stored revision requires the authorized recovery reader.",
      );
    throw error;
  }
  return body as Schemas["Revision"];
}
function nonempty(value: string): string {
  if (!value.trim()) throw new AccessError(422, "empty_text", "Text cannot be empty.");
  return value.trim();
}
function documentInput(body: Schemas["DocumentWrite"]) {
  validateSchema("DocumentWrite", body);
  if (!body.slug.split("/").every((segment) => /^[a-z0-9][a-z0-9-]*$/.test(segment)))
    throw new AccessError(422, "slug_invalid", "Slug must contain nonempty lowercase path segments.");
  return { ...body, title: nonempty(body.title) };
}

/** Bound to an existing verified tenant transaction. It does not start/commit a second transaction. */
export class CmsService {
  readonly repository: CmsRepository;
  private readonly audit: CrmService;
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    traceId: string,
    private readonly dependencies: { profiles: CmsProfileReferencePort; trustedLinkPolicy: PublishPolicy },
  ) {
    this.repository = new CmsRepository(client);
    this.audit = new CrmService(client, context, traceId);
  }

  private async authorize(permission: string) {
    if (requirePermission(this.context, permission) !== "organization")
      throw new AccessError(403, "permission_denied", "Organization scope is required for CMS operations.");
    await requireEntitlement(this.client, permission);
  }

  private async profile(profileId: string) {
    assertUuid(profileId);
    const reference = await this.dependencies.profiles.requireActiveReference(profileId);
    if (reference.id !== profileId || reference.organizationId !== this.context.organizationId) unavailable();
  }

  private async site(id: string) {
    assertUuid(id);
    const row = await this.repository.site(id);
    if (!row || !["draft", "published"].includes(row.state)) unavailable();
    await this.profile(row.business_profile_id);
    return row;
  }

  private async document(id: string, writing: boolean) {
    assertUuid(id);
    const initial = await this.repository.document(id);
    if (!initial || initial.archived_at) unavailable();
    await this.site(initial.site_id);
    const row = await this.repository.document(id, writing ? "write" : "read");
    if (!row || row.archived_at || row.site_id !== initial.site_id) unavailable();
    return row;
  }

  private response<T>(schema: keyof Schemas, body: T, status: number, version: number): Mutation<T> {
    validateSchema(schema, body, true);
    return { body, status, etag: documentEtag(version) };
  }

  /** Current authorization precedes lookup; historical replay precedes the old version precondition.
   * replayStatus overrides the stored status_code returned to clients on replay (e.g. 200 for POST-creates). */
  private async idempotent<T>(
    route: string,
    permission: "sites.write" | "content.write" | "domains.manage" | "media.write" | "forms.write",
    schema: keyof Schemas,
    body: unknown,
    headers: CommandHeaders,
    command: () => Promise<Mutation<T>>,
    reauthorizeReplay: (body: T) => Promise<void>,
    replayStatus?: number,
  ): Promise<Mutation<T>> {
    const key = headers.key;
    if (!key || key.length > 100 || !/^[\x21-\x7e]+$/.test(key))
      throw new AccessError(400, "idempotency_required", "A printable Idempotency-Key is required.");
    const hash = createHash("sha256")
      .update(stable({ body, ifMatch: headers.ifMatch ?? null }))
      .digest("hex");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:cms:${route}:${key}`,
    ]);
    // Row locks protect state, not the passing of effective_until while source/advisory locks wait.
    await this.authorize(permission);
    const existing = await this.client.query(
      "SELECT request_hash,response_body,status_code,response_etag FROM app.idempotency_record WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3 AND expires_at>now()",
      [this.context.userId, route, key],
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.request_hash !== hash)
        throw new AccessError(409, "idempotency_conflict", "The command key was used with different input.");
      await reauthorizeReplay(row.response_body);
      await this.authorize(permission);
      validateSchema(schema, row.response_body, true);
      if (
        !/^"[1-9][0-9]*"$/.test(row.response_etag ?? "") ||
        !Number.isSafeInteger(Number(row.response_etag.slice(1, -1)))
      )
        throw new AccessError(
          503,
          "replay_metadata_unavailable",
          "The historical command metadata is unavailable.",
        );
      return { body: row.response_body, status: row.status_code, etag: row.response_etag };
    }
    const result = await command();
    await this.authorize(permission);
    await this.client.query(
      "INSERT INTO app.idempotency_record(tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at) VALUES(app.current_tenant(),$1,$2,$3,$4,$5,$6,$7,now()+interval '1 day')",
      [this.context.userId, route, key, hash, JSON.stringify(result.body), replayStatus ?? result.status, result.etag],
    );
    await this.authorize(permission);
    return result;
  }

  async createSite(body: Schemas["SiteWrite"], headers: CommandHeaders): Promise<Mutation<Schemas["Site"]>> {
    await this.authorize("sites.write");
    validateSchema("SiteWrite", body);
    await this.profile(body.businessProfileId);
    const template = resolveSiteTemplate(body.templateCode);
    const name = nonempty(body.name);
    return this.idempotent(
      "cms:create-site",
      "sites.write",
      "Site",
      body,
      headers,
      async () => {
        const row = await this.repository.createSite(
          body.businessProfileId,
          name,
          templateThemeVersion(template),
        );
        await this.audit.audit("site.created", "site", row.id, 1);
        return this.response("Site", siteModel(row), 201, 1);
      },
      async (historical) => {
        await this.site(historical.id);
      },
    );
  }

  async getSite(id: string) {
    await this.authorize("sites.read");
    const body = siteModel(await this.site(id));
    validateSchema("Site", body, true);
    await this.authorize("sites.read");
    return body;
  }

  private page(query: Query, resource: string, defaultLimit = 25) {
    if (Object.keys(query).some((key) => !["cursor", "limit"].includes(key)))
      throw new AccessError(422, "query_invalid", "Unsupported pagination query.");
    const limit = query.limit === undefined ? defaultLimit : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
    const binding = cursorBinding(this.context, resource, "organization", {});
    const after = decodeCursor(query.cursor, binding);
    if (after && resource !== "cms:templates") assertUuid(after);
    return { limit, binding, after };
  }

  private pageResponse<T>(
    schema: keyof Schemas,
    rows: T[],
    limit: number,
    binding: string,
    identify: (row: T) => string,
  ) {
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const body = {
      items,
      hasMore,
      nextCursor: hasMore ? encodeCursor(identify(items.at(-1)!), binding) : null,
    };
    validateSchema(schema, body, true);
    return body;
  }

  async listSites(query: Query = {}): Promise<Schemas["PageSite"]> {
    await this.authorize("sites.read");
    const page = this.page(query, "cms:sites");
    const rows = await this.repository.listSites(page.after, page.limit + 1);
    for (const row of rows) await this.profile(row.business_profile_id);
    await this.authorize("sites.read");
    return this.pageResponse("PageSite", rows.map(siteModel), page.limit, page.binding, (row) => row.id);
  }

  async createDocument(
    siteId: string,
    body: Schemas["DocumentWrite"],
    headers: CommandHeaders,
  ): Promise<Mutation<Schemas["Document"]>> {
    await this.authorize("content.write");
    await this.site(siteId);
    const input = documentInput(body);
    return this.idempotent(
      `cms:create-document:${siteId}`,
      "content.write",
      "Document",
      body,
      headers,
      async () => {
        const row = await this.repository.createDocument(siteId, input.slug, input.kind, input.title);
        await this.audit.audit("content_document.created", "content_document", row.id, 1);
        return this.response("Document", documentModel(row), 201, 1);
      },
      async (historical) => {
        const current = await this.document(historical.id, false);
        if (current.site_id !== siteId) unavailable();
      },
    );
  }

  async getDocument(id: string) {
    await this.authorize("content.read");
    const body = documentModel(await this.document(id, false));
    validateSchema("Document", body, true);
    await this.authorize("content.read");
    return body;
  }

  async listDocuments(siteId: string, query: Query = {}): Promise<Schemas["PageDocument"]> {
    await this.authorize("content.read");
    await this.site(siteId);
    const page = this.page(query, `cms:documents:${siteId}`);
    const rows = await this.repository.listDocuments(siteId, page.after, page.limit + 1);
    await this.authorize("content.read");
    return this.pageResponse(
      "PageDocument",
      rows.map(documentModel),
      page.limit,
      page.binding,
      (row) => row.id,
    );
  }

  async updateDocument(
    id: string,
    body: Schemas["DocumentWrite"],
    headers: CommandHeaders,
  ): Promise<Mutation<Schemas["Document"]>> {
    await this.authorize("content.write");
    const current = await this.document(id, true);
    const input = documentInput(body);
    return this.idempotent(
      `cms:update-document:${id}`,
      "content.write",
      "Document",
      body,
      headers,
      async () => {
        const nextVersion = requireDraftVersion(Number(current.row_version), headers.ifMatch);
        const row = await this.repository.updateDocument(current, nextVersion, input);
        await this.audit.audit("content_document.updated", "content_document", id, nextVersion);
        return this.response("Document", documentModel(row), 200, nextVersion);
      },
      async (historical) => {
        if (historical.id !== id) unavailable();
      },
    );
  }

  async saveDraft(
    id: string,
    body: Schemas["RevisionWrite"],
    headers: CommandHeaders,
  ): Promise<Mutation<Schemas["Revision"]>> {
    await this.authorize("content.write");
    const current = await this.document(id, true);
    validateSchema("RevisionWrite", body);
    return this.idempotent(
      `cms:save-draft:${id}`,
      "content.write",
      "Revision",
      body,
      headers,
      async () => {
        const plan = planDraftAppend(
          { id, version: Number(current.row_version) },
          headers.ifMatch,
          body,
          this.dependencies.trustedLinkPolicy,
          {
            revisionId: randomUUID(),
            createdAt: new Date().toISOString(),
          },
        );
        await this.repository.updateDocument(current, plan.documentUpdate.nextVersion);
        const row = await this.repository.insertRevision(plan, this.context.memberId);
        await this.audit.audit(
          "content_revision.saved",
          "content_document",
          id,
          plan.documentUpdate.nextVersion,
        );
        return this.response("Revision", revisionModel(row), 201, plan.documentUpdate.nextVersion);
      },
      async (historical) => {
        const stored = await this.repository.revision(historical.id);
        if (!stored || stored.document_id !== id || historical.documentId !== id) unavailable();
      },
    );
  }

  async listRevisions(documentId: string, query: Query = {}): Promise<Schemas["PageRevision"]> {
    await this.authorize("content.read");
    await this.document(documentId, false);
    const page = this.page(query, `cms:revisions:${documentId}`);
    const rows = await this.repository.listRevisions(documentId, page.after, page.limit + 1);
    await this.authorize("content.read");
    return this.pageResponse(
      "PageRevision",
      rows.map(revisionModel),
      page.limit,
      page.binding,
      (row) => row.id,
    );
  }

  async getRevision(id: string) {
    await this.authorize("content.read");
    assertUuid(id);
    const row = await this.repository.revision(id);
    if (!row) unavailable();
    await this.document(row.document_id, false);
    await this.authorize("content.read");
    return revisionModel(row);
  }
  async listRevisionHistory(documentId: string, query: Query = {}) {
    await this.authorize("content.read");
    await this.document(documentId, false);
    if (
      query.limit !== undefined &&
      ((typeof query.limit !== "number" && typeof query.limit !== "string") ||
        (typeof query.limit === "string" && !/^[1-9][0-9]{0,2}$/.test(query.limit)))
    )
      throw new AccessError(422, "limit_invalid", "Limit must be an integer between 1 and 100.");
    const page = this.page(query, `cms:revision-history:${documentId}`, 50);
    const rows = await this.repository.listRevisionMetadata(documentId, page.after, page.limit + 1);
    const items = rows.slice(0, page.limit).map((row) => ({
      id: row.id,
      documentId: row.document_id,
      schemaVersion: row.schema_version,
      createdAt: row.created_at.toISOString(),
    }));
    const hasMore = rows.length > page.limit;
    const body = requireRevisionHistory(
      {
        items,
        hasMore,
        nextCursor: hasMore ? encodeCursor(items.at(-1)!.id, page.binding) : null,
      },
      documentId,
    );
    await this.authorize("content.read");
    return body;
  }

  /** Explicit authorized recovery helper; future block kinds cannot fit the frozen Revision envelope. */
  async getRevisionRecovery(documentId: string, id: string) {
    await this.authorize("content.read");
    assertUuid(id);
    await this.document(documentId, false);
    const row = await this.repository.revision(id);
    if (!row || row.document_id !== documentId) unavailable();
    await this.authorize("content.read");
    const inspected = recoverDraft(
      { schemaVersion: row.schema_version, blocks: row.block_data, seo: row.seo },
      this.dependencies.trustedLinkPolicy,
    );
    const body = revisionRecovery(row.id, documentId, inspected.data, inspected.issues);
    await this.authorize("content.read");
    return body;
  }

  async listTemplates(query: Query = {}): Promise<Schemas["PageTemplate"]> {
    // Caller already has active verified membership; catalog browsing grants no tenant capability.
    const page = this.page(query, "cms:templates");
    const definitions = listTemplateDefinitions();
    if (page.after && !definitions.some((template) => `${template.code}@${template.version}` === page.after))
      throw new AccessError(422, "cursor_invalid", "Template catalog pagination changed.");
    const afterIndex = page.after
      ? definitions.findIndex((template) => `${template.code}@${template.version}` === page.after) + 1
      : 0;
    return this.pageResponse(
      "PageTemplate",
      definitions.slice(afterIndex, afterIndex + page.limit + 1),
      page.limit,
      page.binding,
      (row) => `${row.code}@${row.version}`,
    );
  }

  // ── Domain management (ADR-053 / MOD-C-005) ───────────────────────────────

  async listDomains(siteId: string): Promise<Schemas["PageDomain"]> {
    await this.authorize("domains.read");
    assertUuid(siteId);
    await this.site(siteId);
    const rows = await this.repository.listDomains(siteId);
    return { items: rows.map(domainModel), nextCursor: null, hasMore: false };
  }

  async createDomain(
    siteId: string,
    body: Schemas["DomainWrite"],
    headers: CommandHeaders,
  ): Promise<Mutation<Schemas["Domain"]>> {
    await this.authorize("domains.manage");
    assertUuid(siteId);
    await this.site(siteId);
    const hostname = body.hostname.toLowerCase().trim();
    return this.idempotent(
      "cms:domain",
      "domains.manage",
      "Domain",
      body,
      headers,
      async () => {
        const existing = await this.repository.domainByHostname(hostname);
        if (existing) {
          if (existing.site_id !== siteId || existing.archived_at)
            throw new AccessError(409, "domain_hostname_conflict", "This hostname is already in use.");
          const model = domainModel(existing);
          return { body: model, status: 200, etag: documentEtag(Number(existing.row_version)) };
        }
        const row = await this.repository.createDomain(siteId, hostname, body.environment);
        const model = domainModel(row);
        return { body: model, status: 201, etag: documentEtag(Number(row.row_version)) };
      },
      async () => {},
      200,
    );
  }

  async verifyDomain(id: string): Promise<Mutation<Schemas["Domain"]>> {
    await this.authorize("domains.manage");
    assertUuid(id);
    const row = await this.repository.domain(id, "write");
    if (!row) unavailable();
    const nextVersion = Number(row.row_version) + 1;
    const updated = await this.repository.updateDomainVerification(id, "verified", "active", nextVersion);
    if (!updated) unavailable();
    const model = domainModel(updated);
    validateSchema("Domain", model, true);
    return { body: model, status: 200, etag: documentEtag(Number(updated.row_version)) };
  }

  async archiveDomain(id: string): Promise<{ body: Schemas["Job"]; status: number }> {
    await this.authorize("domains.manage");
    assertUuid(id);
    const row = await this.repository.domain(id, "write");
    if (!row) unavailable();
    const nextVersion = Number(row.row_version) + 1;
    await this.repository.archiveDomain(id, nextVersion);
    const jobBody: Schemas["Job"] = {
      id: randomUUID(),
      state: "succeeded",
      kind: "domain.archived",
      createdAt: new Date().toISOString(),
    };
    validateSchema("Job", jobBody, true);
    return { body: jobBody, status: 202 };
  }

  async archiveSite(id: string): Promise<{ body: Schemas["Job"]; status: number }> {
    await this.authorize("sites.write");
    assertUuid(id);
    const site = await this.repository.site(id);
    if (!site) unavailable();
    const activeDomains = await this.repository.activeDomainCount(id);
    if (activeDomains > 0)
      throw new AccessError(
        409,
        "domain_still_active",
        "Verified domains must be removed before archiving the site.",
      );
    const updated = await this.repository.archiveSite(id);
    if (!updated) throw new AccessError(409, "site_already_archived", "The site is already archived.");
    const jobBody: Schemas["Job"] = {
      id: randomUUID(),
      state: "succeeded",
      kind: "site.archived",
      createdAt: new Date().toISOString(),
    };
    validateSchema("Job", jobBody, true);
    return { body: jobBody, status: 202 };
  }

  // ── Media management (ADR-053 / MOD-C-006) ────────────────────────────────

  async listMedia(query: Query = {}): Promise<Schemas["PageMedia"]> {
    await this.authorize("media.read");
    const page = this.page(query, "cms:media");
    const rows = await this.repository.listMedia(page.after, page.limit + 1);
    return this.pageResponse("PageMedia", rows.map(mediaModel), page.limit, page.binding, (row) => row.id);
  }

  async finalizeMedia(
    body: Schemas["MediaFinalize"],
    headers: CommandHeaders,
  ): Promise<Mutation<Schemas["Media"]>> {
    await this.authorize("media.write");
    assertUuid(body.assetId);
    return this.idempotent(
      "cms:media-finalize",
      "media.write",
      "Media",
      body,
      headers,
      async () => {
        const row = await this.repository.media(body.assetId, "write");
        if (!row) unavailable();
        if (row.scan_state === "rejected")
          throw new AccessError(
            422,
            "media_rejected",
            "This media asset was rejected and cannot be finalized.",
          );
        if (row.scan_state === "clean") {
          const model = mediaModel(row);
          return { body: model, status: 200, etag: documentEtag(Number(row.row_version)) };
        }
        const nextVersion = Number(row.row_version) + 1;
        const updated = await this.repository.finalizeMedia(
          body.assetId,
          body.checksum,
          body.altText ?? null,
          nextVersion,
        );
        if (!updated) unavailable();
        return { body: mediaModel(updated), status: 200, etag: documentEtag(Number(updated.row_version)) };
      },
      async () => {},
    );
  }

  // ── Form management (ADR-053 / MOD-C-007) ────────────────────────────────

  async listForms(siteId: string, query: Query = {}): Promise<Schemas["PageForm"]> {
    await this.authorize("forms.read");
    assertUuid(siteId);
    await this.site(siteId);
    const page = this.page(query, "cms:forms");
    const rows = await this.repository.listForms(siteId, page.after, page.limit + 1);
    return this.pageResponse("PageForm", rows.map(formModel), page.limit, page.binding, (row) => row.name);
  }

  async createForm(
    siteId: string,
    body: Schemas["FormWrite"],
    headers: CommandHeaders,
  ): Promise<Mutation<Schemas["Form"]>> {
    await this.authorize("forms.write");
    assertUuid(siteId);
    await this.site(siteId);
    return this.idempotent(
      "cms:form",
      "forms.write",
      "Form",
      body,
      headers,
      async () => {
        const definition = {
          fields: body.fields,
          confirmation: body.confirmation,
          leadSourceId: body.leadSourceId,
        };
        const row = await this.repository.createForm(siteId, body.name, definition, body.state);
        return { body: formModel(row), status: 201, etag: documentEtag(Number(row.row_version)) };
      },
      async () => {},
    );
  }

  async getForm(id: string): Promise<Schemas["Form"]> {
    await this.authorize("forms.read");
    assertUuid(id);
    const row = await this.repository.form(id);
    if (!row) unavailable();
    const model = formModel(row);
    validateSchema("Form", model, true);
    return model;
  }

  async publishFormVersion(
    id: string,
    body: Schemas["FormWrite"],
    headers: CommandHeaders,
  ): Promise<Mutation<Schemas["Form"]>> {
    await this.authorize("forms.write");
    assertUuid(id);
    const existing = await this.repository.form(id);
    if (!existing) unavailable();
    return this.idempotent(
      "cms:form-version",
      "forms.write",
      "Form",
      body,
      headers,
      async () => {
        const currentMax = await this.repository.maxFormVersion(existing.site_id, existing.name);
        const definition = {
          fields: body.fields,
          confirmation: body.confirmation,
          leadSourceId: body.leadSourceId,
        };
        const row = await this.repository.insertFormVersion(
          existing.site_id,
          existing.name,
          currentMax + 1,
          definition,
          body.state,
        );
        return { body: formModel(row), status: 201, etag: documentEtag(Number(row.row_version)) };
      },
      async () => {},
    );
  }
}
