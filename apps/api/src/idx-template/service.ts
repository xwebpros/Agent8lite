import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { components } from "../../../../packages/contracts/generated/api";
import type {
  IdxTemplateProvider,
  IdxTemplateProviderFactory,
  IdxTemplateQuery,
} from "../../../../packages/contracts/internal/idx-template-provider";
import type {
  PublicInquirySourcePort,
  PublicInquirySourceRequest,
} from "../../../../packages/contracts/internal/public-inquiry-capture";
import { requireEntitlement } from "../../../../packages/auth/entitlements";
import {
  AccessError,
  requirePermission,
  type TenantContext,
} from "../../../../packages/db/tenant-transaction";
import { isNativeRights } from "../../../../packages/mls";
import { listTemplateDefinitions } from "../../../../packages/templates/catalog";
import { validateSchema } from "../contract-validation";
import { stable } from "../crm-service";
import { NativeCaptureService } from "../native-capture-service";
import {
  IdxTemplateRepository,
  type IdxTemplateBindingRow,
  type IdxFeedRow,
  type IdxListingRow,
} from "./repository";

type Schemas = components["schemas"];
export type IdxTemplateContentProjector = (revision: Schemas["RevisionWrite"]) => {
  content: Schemas["IdxTemplateText"];
  brand: Schemas["IdxTemplateBrand"];
};
export type IdxTemplateServiceOptions = {
  origin: string;
  bindingId: string;
  expectedBindingVersion: string;
  siteId: string;
  createProvider: IdxTemplateProviderFactory;
  projectContent: IdxTemplateContentProjector;
  environment?: Readonly<Record<string, string | undefined>>;
};

export const idxTemplatePolicyHash = (displayPolicy: unknown, nativeRights: unknown) =>
  createHash("sha256").update(stable({ displayPolicy, nativeRights })).digest("hex");
const available = (expires: Date, now: Date) =>
  expires instanceof Date && Number.isFinite(expires.getTime()) && expires.getTime() > now.getTime();
const unavailable = () => {
  throw new AccessError(404, "idx_site_unavailable", "The published site is unavailable.");
};
const policyDenied: () => never = () => {
  throw new AccessError(503, "idx_policy_unavailable", "Current property authorization is unavailable.");
};
const disabledCapabilities: Schemas["IdxTemplateCapabilities"] = {
  map: false,
  favorites: false,
  savedSearches: false,
  aiSearch: false,
  comparisons: false,
  viewHistory: false,
  notifications: false,
  recommendations: false,
  marketStats: false,
};

/** Transaction-bound public service: no independent transaction, sender or credentials. */
export class IdxTemplateService implements PublicInquirySourcePort {
  readonly repository: IdxTemplateRepository;
  private provider: IdxTemplateProvider | undefined;
  private inquiryListing: Schemas["IdxTemplateListing"] | undefined;

  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    private readonly traceId: string,
    private readonly options: IdxTemplateServiceOptions,
  ) {
    this.repository = new IdxTemplateRepository(client);
  }

  private organizationPermission(code: string) {
    if (requirePermission(this.context, code) !== "organization")
      throw new AccessError(403, "idx_capture_scope_denied", "Current site authority is unavailable.");
  }

  async assertSiteCurrent(): Promise<IdxTemplateBindingRow> {
    this.organizationPermission("published.site");
    this.organizationPermission("sites.read");
    this.organizationPermission("content.read");
    this.organizationPermission("forms.read");
    await requireEntitlement(this.client, "sites.read");
    const row = await this.repository.binding(this.options.bindingId);
    if (
      !row ||
      row.tenant_id !== this.context.organizationId ||
      row.site_id !== this.options.siteId ||
      row.origin !== this.options.origin ||
      row.row_version.toString() !== this.options.expectedBindingVersion ||
      row.capture_member_id !== this.context.memberId ||
      row.capture_user_id !== this.context.userId ||
      row.capture_issuer !== "urn:estate:idx-template-capture" ||
      row.capture_subject !== row.site_id ||
      row.capture_status !== "active" ||
      row.state !== "active" ||
      row.site_state !== "published" ||
      row.site_theme_version !== `${row.template_code}@${row.template_version}` ||
      !listTemplateDefinitions().some(
        (template) => template.code === row.template_code && template.version === row.template_version,
      ) ||
      row.site_profile_id !== row.business_profile_id ||
      row.document_site_id !== row.site_id ||
      row.document_archived_at !== null ||
      !row.published_revision_id ||
      row.form_site_id !== row.site_id ||
      row.form_state !== "published"
    )
      unavailable();
    if (row!.domain_id) {
      const domain = await this.repository.domain(row!.domain_id);
      if (
        !domain ||
        domain.site_id !== row!.site_id ||
        domain.archived_at !== null ||
        domain.verification_state !== "verified" ||
        domain.tls_state !== "active" ||
        row!.origin !== `https://${domain.hostname}`
      )
        unavailable();
    } else {
      const env = this.options.environment ?? process.env;
      if (
        row!.mode !== "mock" ||
        !["development", "test"].includes(env.APP_ENV ?? "") ||
        env.DEV_AUTH_ENABLED !== "true" ||
        !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(row!.origin)
      )
        unavailable();
    }
    const actor = await this.client.query<{ allowed: boolean }>(
      "SELECT current_user='estate_runtime' AND app.current_tenant()=$1::uuid AND app.current_actor()=$2::uuid AS allowed",
      [this.context.organizationId, this.context.userId],
    );
    if (actor.rows[0]?.allowed !== true) unavailable();
    const now = await this.repository.now();
    if (!available(row!.expires_at, now)) unavailable();
    await requireEntitlement(this.client, "sites.read");
    if (!available(row!.expires_at, await this.repository.now())) unavailable();
    return row!;
  }

  async assertDataCurrent(): Promise<{ binding: IdxTemplateBindingRow; feed: IdxFeedRow; now: Date }> {
    const binding = await this.assertSiteCurrent();
    this.organizationPermission("mls.read");
    await requireEntitlement(this.client, "mls.read");
    const feed = await this.repository.feed(binding.feed_id);
    const now = await this.repository.now();
    const configuration = feed?.connection_config as
      | { synthetic?: unknown; liveFeedRights?: unknown }
      | undefined;
    if (
      !feed ||
      feed.mode !== binding.mode ||
      feed.state !== "ready" ||
      feed.connection_provider !== "trestle" ||
      feed.connection_mode !== binding.mode ||
      feed.connection_state !== (binding.mode === "mock" ? "mock" : "ready") ||
      (binding.mode === "mock" &&
        (feed.transport !== "mock" ||
          feed.connection_secret_ref !== null ||
          configuration?.synthetic !== true ||
          configuration.liveFeedRights !== "unapproved")) ||
      !available(binding.policy_expires_at, now) ||
      !feed.policy_approved_at ||
      !Number.isFinite(feed.policy_approved_at.getTime()) ||
      feed.policy_approved_at.getTime() > now.getTime() ||
      !isNativeRights(feed.native_rights) ||
      feed.native_rights.approvalState !== "approved" ||
      feed.native_rights.rights.display !== "allowed" ||
      feed.native_rights.maxDataAgeSeconds === null ||
      feed.native_rights.maxDataAgeSeconds <= 0 ||
      feed.native_rights.disclaimerVersion !== binding.policy_version ||
      idxTemplatePolicyHash(feed.display_policy, feed.native_rights) !== binding.policy_sha256
    )
      policyDenied();
    try {
      validateSchema("DisplayPolicy", feed!.display_policy, true);
    } catch {
      policyDenied();
    }
    const policy = feed!.display_policy as Schemas["DisplayPolicy"];
    if (
      !policy.approved ||
      !policy.displayFields.includes("status") ||
      !feed!.native_rights.allowedFields.includes("status")
    )
      policyDenied();
    await requireEntitlement(this.client, "mls.read");
    const currentNow = await this.repository.now();
    if (!available(binding.expires_at, currentNow)) unavailable();
    if (!available(binding.policy_expires_at, currentNow)) policyDenied();
    return { binding, feed: feed!, now: currentNow };
  }

  private currentProvider(binding: IdxTemplateBindingRow) {
    if (!this.provider)
      this.provider = this.options.createProvider(
        {
          bindingId: binding.id,
          siteId: binding.site_id,
          organizationId: binding.tenant_id,
          feedId: binding.feed_id,
          mode: binding.mode,
          policyVersion: binding.policy_version,
          policyExpiresAt: binding.policy_expires_at.toISOString(),
          expiresAt: binding.expires_at.toISOString(),
        },
        async () => {
          await this.assertDataCurrent();
        },
        this.client,
      );
    return this.provider;
  }

  async status(): Promise<Schemas["IdxTemplateStatus"]> {
    const binding = await this.assertSiteCurrent();
    try {
      await this.assertDataCurrent();
      const body = await this.currentProvider(binding).status();
      await this.assertDataCurrent();
      validateSchema("IdxTemplateStatus", body, true);
      if (
        (body.live && binding.mode !== "live") ||
        body.synthetic !== (binding.mode === "mock") ||
        (body.property &&
          (!body.configured ||
            !body.metadata ||
            (binding.mode === "live" && (!body.live || !body.authenticated))))
      )
        policyDenied();
      return body;
    } catch (error) {
      await this.assertSiteCurrent();
      if (!(error instanceof AccessError)) throw error;
      return {
        configured: false,
        authenticated: false,
        metadata: false,
        property: false,
        media: false,
        live: false,
        synthetic: binding.mode === "mock",
        message: "Property services are currently unavailable. Published website content remains available.",
      };
    }
  }

  async content(): Promise<Schemas["IdxTemplateContent"]> {
    const binding = await this.assertSiteCurrent();
    const revision = await this.repository.revision(binding.published_revision_id, binding.document_id);
    if (!revision) unavailable();
    validateSchema("RevisionWrite", revision, true);
    const projected = this.options.projectContent(revision!);
    const status = await this.status();
    const body: Schemas["IdxTemplateContent"] = {
      siteId: binding.site_id,
      documentId: binding.document_id,
      revisionId: binding.published_revision_id,
      templateCode: binding.template_code,
      templateVersion: binding.template_version,
      content: projected.content,
      brand: projected.brand,
      seo: revision!.seo,
      inquiryForm: { id: binding.form_id, version: Number(binding.form_version) },
      dataMode: status.property ? binding.mode : "unavailable",
      capabilities: { ...disabledCapabilities },
      expiresAt: new Date(
        status.property
          ? Math.min(binding.expires_at.getTime(), binding.policy_expires_at.getTime())
          : binding.expires_at.getTime(),
      ).toISOString(),
    };
    await this.assertSiteCurrent();
    validateSchema("IdxTemplateContent", body, true);
    return body;
  }

  private async currentListing(
    key: string,
  ): Promise<{ record: IdxListingRow; binding: IdxTemplateBindingRow; feed: IdxFeedRow; now: Date }> {
    const authority = await this.assertDataCurrent();
    const record = await this.repository.listing(authority.binding.feed_id, key);
    const now = await this.repository.now();
    const policy = authority.feed.display_policy as Schemas["DisplayPolicy"];
    const rights = authority.feed.native_rights;
    if (
      !record ||
      !isNativeRights(rights) ||
      !record.display_allowed ||
      record.withdrawn_at !== null ||
      !["active", "pending"].includes(record.status) ||
      !policy.allowedStatuses.some((status) => status === record.status) ||
      !available(record.expires_at, now) ||
      !record.ingested_at ||
      !Number.isFinite(record.ingested_at.getTime()) ||
      record.ingested_at.getTime() > now.getTime() ||
      now.getTime() - record.ingested_at.getTime() >
        Math.min(policy.maxStaleSeconds, rights.maxDataAgeSeconds!) * 1000 ||
      record.synthetic !== (authority.binding.mode === "mock")
    )
      throw new AccessError(404, "idx_listing_unavailable", "The listing is currently unavailable.");
    await this.assertDataCurrent();
    const currentNow = await this.repository.now();
    if (
      !available(record!.expires_at, currentNow) ||
      currentNow.getTime() - record!.ingested_at!.getTime() >
        Math.min(policy.maxStaleSeconds, rights!.maxDataAgeSeconds!) * 1000
    )
      throw new AccessError(404, "idx_listing_unavailable", "The listing is currently unavailable.");
    return { ...authority, record: record!, now: currentNow };
  }

  private async projection(input: Schemas["IdxTemplateListing"]): Promise<Schemas["IdxTemplateListing"]> {
    validateSchema("IdxTemplateListing", input, true);
    const { record, binding, feed, now } = await this.currentListing(input.listingKey);
    if (input.synthetic !== (binding.mode === "mock") || Date.parse(input.expiresAt) <= now.getTime())
      throw new AccessError(404, "idx_listing_unavailable", "The listing is currently unavailable.");
    if (
      input.listingId !== undefined &&
      record.source_listing_id !== null &&
      input.listingId !== record.source_listing_id
    )
      throw new AccessError(503, "listing_source_mismatch", "The listing source is unavailable.");
    const policy = feed.display_policy as Schemas["DisplayPolicy"];
    const rights = feed.native_rights;
    if (!isNativeRights(rights)) policyDenied();
    const has = (field: string) =>
      rights!.allowedFields.includes(field) && policy.displayFields.includes(field);
    const body = {
      ...input,
      photos: has("photos") ? [...input.photos] : [],
      expiresAt: new Date(
        Math.min(
          Date.parse(input.expiresAt),
          record.expires_at.getTime(),
          record.ingested_at!.getTime() + Math.min(policy.maxStaleSeconds, rights!.maxDataAgeSeconds!) * 1000,
          binding.policy_expires_at.getTime(),
          binding.expires_at.getTime(),
        ),
      ).toISOString(),
    };
    const mapping: Partial<Record<keyof Schemas["IdxTemplateListing"], string>> = {
      listingId: "sourceListingId",
      status: "status",
      price: "listPrice",
      streetAddress: "address",
      city: "address",
      state: "address",
      postalCode: "address",
      latitude: "coordinates",
      longitude: "coordinates",
      bedrooms: "bedrooms",
      bathrooms: "bathrooms",
      livingArea: "area",
      publicRemarks: "publicRemarks",
      propertyType: "propertyType",
      propertySubType: "propertySubType",
      yearBuilt: "yearBuilt",
      modificationTimestamp: "sourceModifiedAt",
      listingOffice: "attribution.brokerage",
      listingAgent: "attribution.agent",
      listingOfficeEmail: "attribution.contact",
      listingOfficePhone: "attribution.contact",
    };
    for (const field of Object.keys(body) as Array<keyof typeof body>) {
      if (["listingKey", "photos", "synthetic", "expiresAt"].includes(field)) continue;
      if (!has(mapping[field] ?? field)) delete (body as Record<string, unknown>)[field];
    }
    if (rights!.addressRule === "hidden" || !record.address_display_allowed)
      for (const field of ["streetAddress", "city", "state", "postalCode"] as const) delete body[field];
    if (
      rights!.locationRule === "hidden" ||
      rights!.locationRule === "coarse" ||
      !record.address_display_allowed
    ) {
      delete body.latitude;
      delete body.longitude;
    }
    validateSchema("IdxTemplateListing", body, true);
    return body;
  }

  async detail(key: string): Promise<Schemas["IdxTemplateListing"]> {
    const { binding } = await this.currentListing(key);
    const input = await this.currentProvider(binding).detail(key);
    if (input.listingKey !== key)
      throw new AccessError(503, "listing_source_mismatch", "The listing source is unavailable.");
    const body = await this.projection(input);
    await this.assertDataCurrent();
    return body;
  }

  async search(query: IdxTemplateQuery): Promise<Schemas["IdxTemplateListingPage"]> {
    const { binding, feed } = await this.assertDataCurrent();
    const rights = feed.native_rights;
    const policy = feed.display_policy as Schemas["DisplayPolicy"];
    if (!isNativeRights(rights)) policyDenied();
    const has = (field: string) =>
      rights!.allowedFields.includes(field) && policy.displayFields.includes(field);
    const filterFields: Record<string, string> = {
      minPrice: "listPrice",
      maxPrice: "listPrice",
      beds: "bedrooms",
      baths: "bathrooms",
      address: "address",
      city: "address",
      zip: "address",
      status: "status",
      propertyType: "propertyType",
      propertySubType: "propertySubType",
      minSqft: "area",
      maxSqft: "area",
      minYearBuilt: "yearBuilt",
      maxYearBuilt: "yearBuilt",
      pool: "pool",
      singleStory: "singleStory",
      hoa: "hoa",
      gated: "gated",
      minGarageSpaces: "garageSpaces",
      minLotSizeSqft: "lotSizeSqft",
      minLatitude: "coordinates",
      maxLatitude: "coordinates",
      minLongitude: "coordinates",
      maxLongitude: "coordinates",
    };
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || key === "page") continue;
      const field =
        key === "sort" ? (value === "newest" ? "sourceModifiedAt" : "listPrice") : filterFields[key];
      if (
        !field ||
        !has(field) ||
        (field === "address" && rights!.addressRule !== "visible") ||
        (field === "coordinates" && (rights!.addressRule !== "visible" || rights!.locationRule !== "exact"))
      )
        throw new AccessError(422, "query_policy_denied", "This search field is currently unavailable.");
    }
    const page = await this.currentProvider(binding).search(query);
    await this.assertDataCurrent();
    validateSchema("IdxTemplateListingPage", page, true);
    if (page.synthetic !== (binding.mode === "mock") || page.live !== (binding.mode === "live"))
      policyDenied();
    if (Date.parse(page.expiresAt) <= (await this.repository.now()).getTime()) policyDenied();
    const items: Schemas["IdxTemplateListing"][] = [];
    for (const input of page.items) {
      try {
        items.push(await this.projection(input));
      } catch (error) {
        if (!(error instanceof AccessError) || error.code !== "idx_listing_unavailable") throw error;
      }
    }
    await this.assertDataCurrent();
    const expires = Math.min(
      Date.parse(page.expiresAt),
      binding.expires_at.getTime(),
      binding.policy_expires_at.getTime(),
      ...items.map((item) => Date.parse(item.expiresAt)),
    );
    if (expires <= (await this.repository.now()).getTime()) policyDenied();
    return { ...page, items, expiresAt: new Date(expires).toISOString() };
  }

  async requireCurrent(request: PublicInquirySourceRequest) {
    if (
      request.siteId !== this.options.siteId ||
      request.bindingId !== this.options.bindingId ||
      request.expectedBindingVersion !== this.options.expectedBindingVersion
    )
      unavailable();
    const { binding, record } = await this.currentListing(request.listingKey);
    // This snapshot exists only inside this command's transaction. Every use is
    // reprojected against current locked rights/listing rows and the actual clock.
    if (!this.inquiryListing || this.inquiryListing.listingKey !== request.listingKey)
      this.inquiryListing = await this.detail(request.listingKey);
    const listing = await this.projection(this.inquiryListing);
    const assignment = await this.repository.listingAssignment(
      binding.id,
      binding.feed_id,
      request.listingKey,
      binding.policy_version,
    );
    let listingAgent: string | null = null;
    if (
      assignment &&
      available(assignment.expires_at, await this.repository.now()) &&
      (await this.repository.member(
        assignment.member_id,
        assignment.office_id ?? binding.brokerage_office_id,
      )) &&
      available(assignment.expires_at, await this.repository.now())
    )
      listingAgent = assignment.member_id;
    const siteAgent =
      binding.agent_member_id &&
      (await this.repository.member(binding.agent_member_id, binding.brokerage_office_id))
        ? binding.agent_member_id
        : null;
    await this.currentListing(request.listingKey);
    if (assignment && listingAgent && !available(assignment.expires_at, await this.repository.now()))
      listingAgent = null;
    return {
      siteId: binding.site_id,
      bindingId: binding.id,
      bindingVersion: binding.row_version.toString(),
      sourceId: binding.source_id,
      feedId: binding.feed_id,
      providerCode: binding.mode === "mock" ? ("mock-synthetic" as const) : ("trestle" as const),
      providerListingKey: listing.listingKey,
      ...((record.source_listing_id ?? listing.listingId) !== undefined
        ? { providerListingId: record.source_listing_id ?? listing.listingId }
        : {}),
      ...(listing.postalCode ? { postalCode: listing.postalCode } : {}),
      policyVersion: binding.policy_version,
      siteAgentMemberId: siteAgent,
      listingAgentMemberId: listingAgent,
      brokerageOfficeId: binding.brokerage_office_id,
    };
  }

  private validateForm(binding: IdxTemplateBindingRow, body: Schemas["IdxTemplateInquiryWrite"]) {
    if (body.formId !== binding.form_id)
      throw new AccessError(404, "idx_form_unavailable", "The inquiry form is unavailable.");
    if (body.formVersion !== Number(binding.form_version))
      throw new AccessError(
        409,
        "form_version_changed",
        "The inquiry form changed. Reload before submitting.",
      );
    const definition = binding.form_definition as { fields?: Schemas["FormField"][]; leadSourceId?: string };
    if (!definition || !Array.isArray(definition.fields) || definition.leadSourceId !== binding.source_id)
      throw new AccessError(503, "idx_form_unavailable", "The inquiry form is unavailable.");
    const values: Record<string, unknown> = {
      name: body.name,
      email: body.email,
      phone: body.phone,
      message: body.message,
    };
    const supplied = new Set(definition.fields.map((field) => field.key));
    for (const key of ["name", "email", "message"])
      if (!supplied.has(key))
        throw new AccessError(503, "idx_form_unavailable", "The inquiry form is unavailable.");
    for (const field of definition.fields) {
      validateSchema("FormField", field, true);
      const value = values[field.key];
      if (field.required && (value === undefined || typeof value !== "string" || !value.trim()))
        throw new AccessError(422, "form_field_required", "A required inquiry field is missing.");
      if (typeof value === "string" && field.maxLength !== undefined && value.length > field.maxLength)
        throw new AccessError(422, "form_field_too_long", "An inquiry field exceeds the published limit.");
      if (field.kind === "consent" && value !== undefined)
        throw new AccessError(
          422,
          "consent_evidence_required",
          "Marketing consent requires separately verified evidence.",
        );
    }
  }

  async submit(body: Schemas["IdxTemplateInquiryWrite"], key: string): Promise<Schemas["SubmissionReceipt"]> {
    validateSchema("IdxTemplateInquiryWrite", body);
    if (body.honeypot) throw new AccessError(422, "bot_detected", "The submission was rejected.");
    const original = JSON.parse(JSON.stringify(body)) as Schemas["IdxTemplateInquiryWrite"];
    let binding = await this.assertSiteCurrent();
    this.validateForm(binding, original);
    const route = `idx-template:inquiry:${binding.site_id}:${binding.form_id}`;
    const hash = createHash("sha256").update(stable(original)).digest("hex");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${binding.tenant_id}:${route}:${key}`,
    ]);
    binding = await this.assertSiteCurrent();
    this.validateForm(binding, original);
    const sourceRequest = {
      siteId: binding.site_id,
      bindingId: binding.id,
      expectedBindingVersion: binding.row_version.toString(),
      listingKey: original.listingKey,
    };
    const source = await this.requireCurrent(sourceRequest);
    if (original.listingId !== undefined && original.listingId !== source.providerListingId)
      throw new AccessError(
        422,
        "listing_identifier_mismatch",
        "The listing identifier changed. Reload the listing.",
      );
    const previous = await this.repository.receipt(this.context.userId, route, key);
    if (previous) {
      if (previous.request_hash !== hash)
        throw new AccessError(409, "idempotency_conflict", "The inquiry key was used with different input.");
      validateSchema("SubmissionReceipt", previous.response_body, true);
      await this.requireCurrent(sourceRequest);
      return previous.response_body as Schemas["SubmissionReceipt"];
    }
    const captured = await new NativeCaptureService(
      this.client,
      this.context,
      this.traceId,
      this,
    ).capturePublicInquiry({
      name: original.name,
      email: original.email,
      ...(original.phone !== undefined ? { phone: original.phone } : {}),
      message: original.message,
      listingKey: original.listingKey,
      ...(original.listingId !== undefined ? { listingId: original.listingId } : {}),
      sourceSubmissionId: randomUUID(),
      siteId: binding.site_id,
      bindingId: binding.id,
      expectedBindingVersion: binding.row_version.toString(),
    });
    const submissionKey = createHash("sha256").update(`${route}:${key}`).digest("hex");
    const entryId = await this.repository.saveEntry(binding.form_id, captured.lead.id, submissionKey, {
      schemaVersion: 1,
      requestHash: hash,
      inquiry: original,
      noteId: captured.noteId,
      decisionId: captured.decisionId,
      provenance: source,
      routing: { winningRuleId: captured.winningRuleId, reasonCodes: captured.reasonCodes },
    });
    const receipt = {
      receiptId: entryId,
      message: "Your inquiry was received. Follow-up is managed by the site team.",
    };
    validateSchema("SubmissionReceipt", receipt, true);
    await this.repository.saveReceipt(this.context.userId, route, key, hash, receipt);
    await this.requireCurrent(sourceRequest);
    return receipt;
  }
}
