import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Request, Response } from "express";
import { AccessError, type TenantContext } from "../../../packages/db/tenant-transaction";
import { NativeCaptureService } from "./native-capture-service";
import { assertNativeMockMode, NativeMockReadService } from "./mls";
import { validateSchema } from "./contract-validation";

const VISITOR_COOKIE = "estate_visitor_session";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}$/;
const HMAC_TOKEN_RE = /^[A-Za-z0-9_=-]{1,512}$/;
const SITE_RE = /^\/v1\/public\/sites\/([^/]+)\//;

function assertUuid(value: unknown, label = "identifier"): asserts value is string {
  if (typeof value !== "string" || !UUID_RE.test(value))
    throw new AccessError(422, "identifier_invalid", `${label} must be a valid UUID.`);
}

/** Resolves a published site and runs the callback in the site's owner member's tenant transaction. */
async function withPublicSiteTransaction<T>(
  pool: Pool,
  siteId: string,
  operation: (client: PoolClient, context: TenantContext, organizationId: string) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const siteRow = await client.query(
      "SELECT id, tenant_id FROM app.site WHERE id=$1 AND state='published'",
      [siteId],
    );
    if (!siteRow.rowCount) throw new AccessError(404, "site_unavailable", "Published site not found.");
    const organizationId: string = siteRow.rows[0].tenant_id;
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [
      organizationId,
      organizationId,
    ]);
    const memberRow = await client.query(
      `SELECT m.id,m.user_id,m.role_id,r.name,r.permission_grants,o.timezone
       FROM app.membership m
       JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
       JOIN app.organization o ON o.id=m.tenant_id
       WHERE m.tenant_id=$1 AND m.status='active' AND r.name='owner'
       ORDER BY m.id LIMIT 1 FOR SHARE OF m,r,o`,
      [organizationId],
    );
    if (!memberRow.rowCount)
      throw new AccessError(503, "routing_actor_unavailable", "Site routing actor unavailable.");
    const row = memberRow.rows[0];
    await client.query("SELECT set_config('app.actor_id',$1,true)", [row.user_id]);
    const context: TenantContext = {
      userId: row.user_id,
      organizationId,
      memberId: row.id,
      roleId: row.role_id,
      roleName: row.name,
      permissions: row.permission_grants,
      timezone: row.timezone,
    };
    const result = await operation(client, context, organizationId);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function visitorCookieValue(visitorId: string, signingKey: string): string {
  const hmac = createHmac("sha256", signingKey).update(visitorId).digest("base64url");
  return `${visitorId}.${hmac}`;
}

function parseVisitorCookie(cookie: string | undefined, signingKey: string): string | null {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf(".");
  if (dot < 0) return null;
  const visitorId = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (!UUID_RE.test(visitorId)) return null;
  const expected = createHmac("sha256", signingKey).update(visitorId).digest("base64url");
  try {
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  } catch {
    return null;
  }
  return visitorId;
}

async function findOrCreatePublicContact(
  client: PoolClient,
  context: TenantContext,
  email: string,
  displayName: string,
  phone?: string,
): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await client.query(
    "SELECT contact_id FROM app.contact_channel WHERE tenant_id=$1 AND kind='email' AND normalized_value=$2 AND active=true LIMIT 1",
    [context.organizationId, normalizedEmail],
  );
  if (existing.rowCount) return existing.rows[0].contact_id;
  const contact = await client.query(
    "INSERT INTO app.contact(tenant_id,display_name,created_by_member_id) VALUES($1,$2,$3) RETURNING id",
    [context.organizationId, (displayName.trim() || "Public Visitor").slice(0, 120), context.memberId],
  );
  const contactId: string = contact.rows[0].id;
  await client.query(
    "INSERT INTO app.contact_channel(tenant_id,contact_id,kind,normalized_value,is_primary) VALUES($1,$2,'email',$3,true)",
    [context.organizationId, contactId, normalizedEmail],
  );
  if (phone) {
    const normalizedPhone = phone.trim().replace(/[\s().-]/g, "");
    if (/^\+?[0-9]{7,15}$/.test(normalizedPhone))
      await client.query(
        "INSERT INTO app.contact_channel(tenant_id,contact_id,kind,normalized_value,is_primary) VALUES($1,$2,'phone',$3,false) ON CONFLICT DO NOTHING",
        [context.organizationId, contactId, normalizedPhone],
      );
  }
  return contactId;
}

async function getDefaultSource(client: PoolClient, organizationId: string): Promise<string> {
  const preferred = await client.query(
    "SELECT id FROM app.lead_source WHERE tenant_id=$1 AND code='synthetic-inquiry' LIMIT 1",
    [organizationId],
  );
  if (preferred.rowCount) return preferred.rows[0].id;
  const any = await client.query("SELECT id FROM app.lead_source WHERE tenant_id=$1 LIMIT 1", [
    organizationId,
  ]);
  if (any.rowCount) return any.rows[0].id;
  throw new AccessError(503, "source_unavailable", "No capture source is configured for this site.");
}

/** Handles all /v1/public/** routes. Construct per request; owns no persistent state. */
export class PublicSiteService {
  constructor(
    private readonly pool: Pool,
    private readonly traceId: string,
    private readonly signingKey: string,
    private readonly environment: Readonly<Record<string, string | undefined>>,
  ) {}

  async getPublicForm(req: Request, res: Response): Promise<void> {
    const siteId = SITE_RE.exec(req.path)?.[1];
    const formId = req.path.split("/").at(-1);
    assertUuid(siteId, "siteId");
    assertUuid(formId, "formId");
    const result = await withPublicSiteTransaction(this.pool, siteId, async (client, _context, orgId) => {
      const row = await client.query(
        "SELECT id,name,version,definition,state FROM app.form_schema WHERE tenant_id=$1 AND id=$2 AND site_id=$3",
        [orgId, formId, siteId],
      );
      if (!row.rowCount) throw new AccessError(404, "form_unavailable", "Form not found.");
      const f = row.rows[0];
      if (f.state !== "published")
        throw new AccessError(410, "form_unpublished", "Form is no longer available.");
      return {
        id: f.id,
        name: f.name,
        version: f.version,
        fields: f.definition?.fields ?? [],
        state: f.state,
      };
    });
    validateSchema("Form", result, true);
    res.status(200).json(result);
  }

  async submitPublicForm(req: Request, res: Response): Promise<void> {
    const siteId = SITE_RE.exec(req.path)?.[1];
    assertUuid(siteId, "siteId");
    validateSchema("FormSubmission", req.body);
    const { formId, formVersion, values, honeypot } = req.body as {
      formId: string;
      formVersion: number;
      values: Record<string, unknown>;
      honeypot?: string;
    };
    if (honeypot) throw new AccessError(422, "bot_detected", "Submission rejected.");
    assertUuid(formId, "formId");
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key || key.length > 100)
      throw new AccessError(400, "idempotency_required", "A printable Idempotency-Key is required.");
    const submissionKey = createHash("sha256").update(`form:${siteId}:${key}`).digest("hex");
    const result = await withPublicSiteTransaction(this.pool, siteId, async (client, context, orgId) => {
      const dup = await client.query(
        "SELECT id FROM app.form_entry WHERE tenant_id=$1 AND submission_key=$2",
        [orgId, submissionKey],
      );
      if (dup.rowCount)
        return { receiptId: dup.rows[0].id as string, message: "Your form was already received." };
      const formRow = await client.query(
        "SELECT id,version,definition FROM app.form_schema WHERE tenant_id=$1 AND id=$2 AND site_id=$3 AND state='published'",
        [orgId, formId, siteId],
      );
      if (!formRow.rowCount) throw new AccessError(404, "form_unavailable", "Form not found.");
      if (formRow.rows[0].version !== formVersion)
        throw new AccessError(409, "form_version_changed", "Form version has changed. Reload and resubmit.");
      const email = String(values.email ?? values.Email ?? "")
        .trim()
        .toLowerCase();
      if (!email || !EMAIL_RE.test(email))
        throw new AccessError(422, "email_required", "A valid email address is required.");
      const name = String(values.name ?? values.Name ?? values.full_name ?? "Public Visitor")
        .trim()
        .slice(0, 120);
      const phone = String(values.phone ?? values.Phone ?? "").trim() || undefined;
      const contactId = await findOrCreatePublicContact(client, context, email, name, phone);
      const sourceId = await getDefaultSource(client, orgId);
      const capture = new NativeCaptureService(client, context, this.traceId);
      const decision = await capture.capture({
        contactId,
        sourceId,
        sourceSubmissionId: key,
        intent: "unknown",
      });
      const entry = await client.query(
        `INSERT INTO app.form_entry(tenant_id,form_schema_id,lead_id,submission_key,private_payload,expires_at)
         VALUES($1,$2,$3,$4,$5,now()+interval '90 days') RETURNING id`,
        [orgId, formId, decision.lead.id, submissionKey, JSON.stringify({ traceId: this.traceId })],
      );
      return { receiptId: entry.rows[0].id as string, message: "Thank you! We will be in touch shortly." };
    });
    validateSchema("SubmissionReceipt", result, true);
    res.status(200).json(result);
  }

  async submitInquiry(req: Request, res: Response): Promise<void> {
    const siteId = SITE_RE.exec(req.path)?.[1];
    assertUuid(siteId, "siteId");
    validateSchema("Inquiry", req.body);
    const body = req.body as {
      listingId: string;
      name: string;
      email: string;
      phone?: string;
      message: string;
      formVersion: number;
    };
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key || key.length > 100)
      throw new AccessError(400, "idempotency_required", "A printable Idempotency-Key is required.");
    const submissionKey = createHash("sha256").update(`inquiry:${siteId}:${key}`).digest("hex");
    const result = await withPublicSiteTransaction(this.pool, siteId, async (client, context, orgId) => {
      const dup = await client.query(
        "SELECT id FROM app.form_entry WHERE tenant_id=$1 AND submission_key=$2",
        [orgId, submissionKey],
      );
      if (dup.rowCount)
        return { receiptId: dup.rows[0].id as string, message: "Your inquiry was already received." };
      const contactId = await findOrCreatePublicContact(client, context, body.email, body.name, body.phone);
      const sourceId = await getDefaultSource(client, orgId);
      const capture = new NativeCaptureService(client, context, this.traceId);
      const decision = await capture.capture({
        contactId,
        sourceId,
        sourceSubmissionId: `inquiry:${key}`,
        intent: "unknown",
      });
      // Use any published form schema for the entry record; inquiry does not require a specific form.
      const formRow = await client.query(
        "SELECT id FROM app.form_schema WHERE tenant_id=$1 AND site_id=$2 AND state='published' LIMIT 1",
        [orgId, siteId],
      );
      if (!formRow.rowCount)
        throw new AccessError(503, "form_unavailable", "No published form is configured for this site.");
      const entry = await client.query(
        `INSERT INTO app.form_entry(tenant_id,form_schema_id,lead_id,submission_key,private_payload,expires_at)
         VALUES($1,$2,$3,$4,$5,now()+interval '90 days') RETURNING id`,
        [
          orgId,
          formRow.rows[0].id,
          decision.lead.id,
          submissionKey,
          JSON.stringify({ traceId: this.traceId, listingId: body.listingId }),
        ],
      );
      return { receiptId: entry.rows[0].id as string, message: "Thank you! We will be in touch shortly." };
    });
    validateSchema("SubmissionReceipt", result, true);
    res.status(200).json(result);
  }

  async searchPublicListings(req: Request, res: Response): Promise<void> {
    const siteId = SITE_RE.exec(req.path)?.[1];
    assertUuid(siteId, "siteId");
    assertNativeMockMode(this.environment);
    const result = await withPublicSiteTransaction(this.pool, siteId, async (client, context) => {
      const service = new NativeMockReadService(client, context, {
        signingKey: this.signingKey,
        environment: this.environment,
      });
      return service.list(req.query);
    });
    validateSchema("PageListing", result, true);
    res.status(200).json(result);
  }

  async getPublicListing(req: Request, res: Response): Promise<void> {
    const match = /^\/v1\/public\/sites\/([^/]+)\/listings\/([^/]+)$/.exec(req.path);
    const siteId = match?.[1];
    const listingId = match?.[2];
    assertUuid(siteId, "siteId");
    assertUuid(listingId, "listingId");
    assertNativeMockMode(this.environment);
    const result = await withPublicSiteTransaction(this.pool, siteId, async (client, context) => {
      const service = new NativeMockReadService(client, context, {
        signingKey: this.signingKey,
        environment: this.environment,
      });
      return service.detail(listingId!, req.query);
    });
    validateSchema("Listing", result, true);
    res.status(200).json(result);
  }

  async requestVisitorLogin(req: Request, res: Response): Promise<void> {
    const siteId = SITE_RE.exec(req.path)?.[1];
    assertUuid(siteId, "siteId");
    validateSchema("VisitorLogin", req.body);
    const email = String(req.body.email).trim().toLowerCase();
    await withPublicSiteTransaction(this.pool, siteId, async (client, context, orgId) => {
      const otp = randomBytes(3).toString("hex").toUpperCase();
      const otpHash = createHash("sha256").update(`${orgId}:${email}:${otp}`).digest("hex");
      const contactId = await findOrCreatePublicContact(
        client,
        context,
        email,
        email.split("@")[0] ?? "Visitor",
      );
      await client.query(
        `INSERT INTO app.visitor_identity(tenant_id,site_id,contact_id,auth_subject,status)
         VALUES($1,$2,$3,$4,'challenge')
         ON CONFLICT(tenant_id,site_id,auth_subject)
         DO UPDATE SET status='challenge',contact_id=EXCLUDED.contact_id,updated_at=now()`,
        [orgId, siteId, contactId, otpHash],
      );
      // No-delivery mode: emit OTP as a structured trace log only.
      console.log(
        JSON.stringify({
          level: "trace",
          event: "visitor_otp_challenge",
          traceId: this.traceId,
          siteId,
          otp,
        }),
      );
    });
    const receipt = {
      receiptId: randomUUID(),
      message: "If an account exists for this email, a code has been sent.",
    };
    validateSchema("SubmissionReceipt", receipt, true);
    res.status(200).json(receipt);
  }

  async verifyVisitorLogin(req: Request, res: Response): Promise<void> {
    const siteId = SITE_RE.exec(req.path)?.[1];
    assertUuid(siteId, "siteId");
    validateSchema("VisitorVerify", req.body);
    const token = String(req.body.token).trim();
    let decoded: string;
    try {
      decoded = Buffer.from(token, "base64url").toString("utf8");
    } catch {
      throw new AccessError(422, "token_invalid", "Visitor token is malformed.");
    }
    const colonIdx = decoded.indexOf(":");
    if (colonIdx < 0) throw new AccessError(422, "token_invalid", "Visitor token is malformed.");
    const email = decoded.slice(0, colonIdx).trim().toLowerCase();
    const otp = decoded
      .slice(colonIdx + 1)
      .trim()
      .toUpperCase();
    if (!EMAIL_RE.test(email) || !otp)
      throw new AccessError(422, "token_invalid", "Visitor token is malformed.");
    const visitorId = await withPublicSiteTransaction(this.pool, siteId, async (client, _context, orgId) => {
      const otpHash = createHash("sha256").update(`${orgId}:${email}:${otp}`).digest("hex");
      const row = await client.query(
        `UPDATE app.visitor_identity
           SET status='active', updated_at=now()
           WHERE tenant_id=$1 AND site_id=$2 AND auth_subject=$3 AND status='challenge'
           RETURNING id`,
        [orgId, siteId, otpHash],
      );
      if (!row.rowCount) throw new AccessError(422, "token_invalid", "Visitor token is invalid or expired.");
      return row.rows[0].id as string;
    });
    const cookieValue = visitorCookieValue(visitorId, this.signingKey);
    res.setHeader(
      "Set-Cookie",
      `${VISITOR_COOKIE}=${cookieValue}; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}; Path=/v1/public`,
    );
    const receipt = { receiptId: visitorId, message: "Visitor session established." };
    validateSchema("SubmissionReceipt", receipt, true);
    res.status(200).json(receipt);
  }

  async signOutVisitor(_req: Request, res: Response): Promise<void> {
    res.setHeader("Set-Cookie", `${VISITOR_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/v1/public`);
    res.status(204).end();
  }

  async listSavedSearches(req: Request, res: Response): Promise<void> {
    const siteId = SITE_RE.exec(req.path)?.[1];
    assertUuid(siteId, "siteId");
    const visitorId = parseVisitorCookie(req.cookies?.[VISITOR_COOKIE], this.signingKey);
    if (!visitorId) {
      const empty = { items: [], nextCursor: null, hasMore: false };
      validateSchema("PageSavedSearch", empty, true);
      res.status(200).json(empty);
      return;
    }
    const result = await withPublicSiteTransaction(this.pool, siteId, async (client, _context, orgId) => {
      const rows = await client.query(
        `SELECT id,name,criteria,alert_frequency,active,row_version
         FROM app.saved_search
         WHERE tenant_id=$1 AND visitor_id=$2 AND active=true
         ORDER BY id`,
        [orgId, visitorId],
      );
      return {
        items: rows.rows.map((r) => ({
          id: r.id,
          name: r.name,
          criteria: r.criteria,
          frequency: r.alert_frequency,
          active: r.active,
          version: Number(r.row_version),
        })),
        nextCursor: null,
        hasMore: false,
      };
    });
    validateSchema("PageSavedSearch", result, true);
    res.status(200).json(result);
  }

  async createSavedSearch(req: Request, res: Response): Promise<void> {
    const siteId = SITE_RE.exec(req.path)?.[1];
    assertUuid(siteId, "siteId");
    const visitorId = parseVisitorCookie(req.cookies?.[VISITOR_COOKIE], this.signingKey);
    if (!visitorId) throw new AccessError(401, "visitor_session_required", "Visitor session required.");
    validateSchema("SavedSearchWrite", req.body);
    const result = await withPublicSiteTransaction(this.pool, siteId, async (client, _context, orgId) => {
      const row = await client.query(
        `INSERT INTO app.saved_search(tenant_id,visitor_id,name,criteria,alert_frequency,active)
         VALUES($1,$2,$3,$4,$5,true)
         RETURNING id,name,criteria,alert_frequency,active,row_version`,
        [orgId, visitorId, req.body.name, JSON.stringify(req.body.criteria), req.body.frequency],
      );
      const r = row.rows[0];
      return {
        id: r.id,
        name: r.name,
        criteria: r.criteria,
        frequency: r.alert_frequency,
        active: r.active,
        version: Number(r.row_version),
      };
    });
    validateSchema("SavedSearch", result, true);
    res.status(201).json(result);
  }

  async updateSavedSearch(req: Request, res: Response): Promise<void> {
    const match = /^\/v1\/public\/sites\/([^/]+)\/saved-searches\/([^/]+)$/.exec(req.path);
    const siteId = match?.[1];
    const savedSearchId = match?.[2];
    assertUuid(siteId, "siteId");
    assertUuid(savedSearchId, "savedSearchId");
    const visitorId = parseVisitorCookie(req.cookies?.[VISITOR_COOKIE], this.signingKey);
    if (!visitorId) throw new AccessError(401, "visitor_session_required", "Visitor session required.");
    validateSchema("SavedSearchWrite", req.body);
    const result = await withPublicSiteTransaction(this.pool, siteId, async (client, _context, orgId) => {
      const row = await client.query(
        `UPDATE app.saved_search
         SET name=$1, criteria=$2, alert_frequency=$3, row_version=row_version+1, updated_at=now()
         WHERE tenant_id=$4 AND id=$5 AND visitor_id=$6 AND active=true
         RETURNING id,name,criteria,alert_frequency,active,row_version`,
        [
          req.body.name,
          JSON.stringify(req.body.criteria),
          req.body.frequency,
          orgId,
          savedSearchId,
          visitorId,
        ],
      );
      if (!row.rowCount) throw new AccessError(404, "saved_search_unavailable", "Saved search not found.");
      const r = row.rows[0];
      return {
        id: r.id,
        name: r.name,
        criteria: r.criteria,
        frequency: r.alert_frequency,
        active: r.active,
        version: Number(r.row_version),
      };
    });
    validateSchema("SavedSearch", result, true);
    res.status(200).json(result);
  }

  async listFavorites(req: Request, res: Response): Promise<void> {
    const siteId = SITE_RE.exec(req.path)?.[1];
    assertUuid(siteId, "siteId");
    const visitorId = parseVisitorCookie(req.cookies?.[VISITOR_COOKIE], this.signingKey);
    if (!visitorId) {
      res.status(200).json({ items: [], nextCursor: null, hasMore: false });
      return;
    }
    const result = await withPublicSiteTransaction(this.pool, siteId, async (client, _context, orgId) => {
      const rows = await client.query(
        "SELECT listing_id FROM app.favorite WHERE tenant_id=$1 AND visitor_id=$2 ORDER BY created_at",
        [orgId, visitorId],
      );
      return {
        items: rows.rows.map((r) => ({ listingId: r.listing_id as string })),
        nextCursor: null,
        hasMore: false,
      };
    });
    res.status(200).json(result);
  }

  async addFavorite(req: Request, res: Response): Promise<void> {
    const siteId = SITE_RE.exec(req.path)?.[1];
    assertUuid(siteId, "siteId");
    const visitorId = parseVisitorCookie(req.cookies?.[VISITOR_COOKIE], this.signingKey);
    if (!visitorId) throw new AccessError(401, "visitor_session_required", "Visitor session required.");
    validateSchema("FavoriteWrite", req.body);
    assertUuid(req.body.listingId, "listingId");
    await withPublicSiteTransaction(this.pool, siteId, async (client, _context, orgId) => {
      await client.query(
        "INSERT INTO app.favorite(tenant_id,visitor_id,listing_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [orgId, visitorId, req.body.listingId],
      );
    });
    res.status(201).end();
  }

  async removeFavorite(req: Request, res: Response): Promise<void> {
    const match = /^\/v1\/public\/sites\/([^/]+)\/favorites\/([^/]+)$/.exec(req.path);
    const siteId = match?.[1];
    const listingId = match?.[2];
    assertUuid(siteId, "siteId");
    assertUuid(listingId, "listingId");
    const visitorId = parseVisitorCookie(req.cookies?.[VISITOR_COOKIE], this.signingKey);
    if (!visitorId) throw new AccessError(401, "visitor_session_required", "Visitor session required.");
    await withPublicSiteTransaction(this.pool, siteId, async (client, _context, orgId) => {
      await client.query("DELETE FROM app.favorite WHERE tenant_id=$1 AND visitor_id=$2 AND listing_id=$3", [
        orgId,
        visitorId,
        listingId,
      ]);
    });
    res.status(204).end();
  }

  async collectPublicAnalytics(_req: Request, res: Response): Promise<void> {
    // Validate schema then discard — no personal data in storage, no-op in development.
    validateSchema("PublicAnalyticsEvent", _req.body);
    const receipt = { receiptId: randomUUID(), message: "Event recorded." };
    validateSchema("SubmissionReceipt", receipt, true);
    res.status(200).json(receipt);
  }

  async unsubscribeMessage(req: Request, res: Response): Promise<void> {
    validateSchema("UnsubscribeRequest", req.body);
    const token = String(req.body.token);
    if (!HMAC_TOKEN_RE.test(token))
      throw new AccessError(422, "token_invalid", "Unsubscribe token is malformed.");
    const receipt = { receiptId: randomUUID(), message: "Unsubscribe request received." };
    validateSchema("SubmissionReceipt", receipt, true);
    res.status(200).json(receipt);
  }

  async oneClickUnsubscribe(req: Request, res: Response): Promise<void> {
    validateSchema("OneClickUnsubscribeBody", req.body);
    const receipt = { receiptId: randomUUID(), message: "Unsubscribe request received." };
    validateSchema("SubmissionReceipt", receipt, true);
    res.status(200).json(receipt);
  }
}

/** Route dispatcher for all /v1/public/** paths. Returns true when the route was handled. */
export async function tryPublicSiteRoute(
  req: Request,
  res: Response,
  pool: Pool,
  traceId: string,
  options: { signingKey: string; environment?: Readonly<Record<string, string | undefined>> },
): Promise<boolean> {
  const path = req.path;
  const method = req.method;
  if (!path.startsWith("/v1/public/")) return false;
  const service = new PublicSiteService(
    pool,
    traceId,
    options.signingKey,
    options.environment ?? process.env,
  );
  if (/^\/v1\/public\/sites\/[^/]+\/forms\/[^/]+$/.test(path) && method === "GET") {
    await service.getPublicForm(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/form-submissions$/.test(path) && method === "POST") {
    await service.submitPublicForm(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/property-inquiries$/.test(path) && method === "POST") {
    await service.submitInquiry(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/listings$/.test(path) && method === "GET") {
    await service.searchPublicListings(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/listings\/[^/]+$/.test(path) && method === "GET") {
    await service.getPublicListing(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/visitor-sessions\/challenge$/.test(path) && method === "POST") {
    await service.requestVisitorLogin(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/visitor-sessions\/verify$/.test(path) && method === "POST") {
    await service.verifyVisitorLogin(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/visitor-sessions\/current$/.test(path) && method === "DELETE") {
    await service.signOutVisitor(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/saved-searches$/.test(path) && method === "GET") {
    await service.listSavedSearches(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/saved-searches$/.test(path) && method === "POST") {
    await service.createSavedSearch(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/saved-searches\/[^/]+$/.test(path) && method === "PATCH") {
    await service.updateSavedSearch(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/favorites$/.test(path) && method === "GET") {
    await service.listFavorites(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/favorites$/.test(path) && method === "POST") {
    await service.addFavorite(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/favorites\/[^/]+$/.test(path) && method === "DELETE") {
    await service.removeFavorite(req, res);
    return true;
  }
  if (/^\/v1\/public\/sites\/[^/]+\/analytics-events$/.test(path) && method === "POST") {
    await service.collectPublicAnalytics(req, res);
    return true;
  }
  if (path === "/v1/public/message-unsubscriptions" && method === "POST") {
    await service.unsubscribeMessage(req, res);
    return true;
  }
  if (path === "/v1/public/one-click-unsubscribe" && method === "POST") {
    await service.oneClickUnsubscribe(req, res);
    return true;
  }
  return false;
}
