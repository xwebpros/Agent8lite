import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import pg, { type PoolClient } from "pg";
import { CmsHttpAdapter } from "../../apps/api/src/cms";
import type { CmsProfileReferencePort } from "../../packages/cms/ports";
import { MockStorageProvider } from "../../packages/providers/storage/mock";
import { AccessError, type TenantContext } from "../../packages/db/tenant-transaction";
import { migrate } from "../../packages/db/migrate";
import { seed } from "../../packages/db/seed";

export const cmsTestOrigin = "http://cms-test.invalid";
export const cmsTestPolicy = { approvedLinkOrigins: new Set(["https://approved.example.test"]) };

/** Test-owned resolver demonstrates the supplied read port; it is not an administration implementation. */
export function testProfilePort(
  client: PoolClient,
  context: TenantContext,
  denied: ReadonlySet<string>,
): CmsProfileReferencePort {
  return {
    async requireActiveReference(id) {
      const found = await client.query(
        "SELECT id,tenant_id FROM app.business_profile WHERE tenant_id=app.current_tenant() AND id=$1 FOR SHARE",
        [id],
      );
      if (!found.rowCount || denied.has(id))
        throw new AccessError(404, "resource_unavailable", "Resource unavailable or out of scope.");
      if (found.rows[0].tenant_id !== context.organizationId)
        throw new AccessError(404, "resource_unavailable", "Resource unavailable or out of scope.");
      return { id: found.rows[0].id, organizationId: found.rows[0].tenant_id };
    },
  };
}

export async function createIsolatedCms() {
  const source = new URL(
    process.env.TEST_MIGRATION_DATABASE_URL ??
      process.env.MIGRATION_DATABASE_URL ??
      "postgresql://postgres:local-migration-only@127.0.0.1:55432/postgres",
  );
  if (
    !["postgres:", "postgresql:"].includes(source.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(source.hostname)
  )
    throw new Error("CMS tests require a loopback PostgreSQL cluster.");
  const database = `estate_cms_${randomBytes(8).toString("hex")}`;
  if (!/^estate_cms_[0-9a-f]{16}$/.test(database)) throw new Error("Unsafe disposable database name.");
  const clusterUrl = new URL(source);
  clusterUrl.pathname = "/postgres";
  const cluster = new pg.Pool({ connectionString: clusterUrl.href, max: 1 });
  const migrationUrl = new URL(source);
  migrationUrl.pathname = `/${database}`;
  const runtimeUrl = new URL(migrationUrl);
  runtimeUrl.username = "estate_runtime";
  runtimeUrl.password = "local-runtime-only";
  const admin = new pg.Pool({ connectionString: migrationUrl.href, max: 6 });
  const runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 6 });
  const deniedProfiles = new Set<string>();
  let server: Server | undefined;
  let created = false;
  const previousMigration = process.env.MIGRATION_DATABASE_URL;
  const close = async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        server!.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
    await Promise.all([runtime.end(), admin.end()]);
    try {
      if (created) await cluster.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    } finally {
      await cluster.end();
      if (previousMigration === undefined) delete process.env.MIGRATION_DATABASE_URL;
      else process.env.MIGRATION_DATABASE_URL = previousMigration;
    }
  };
  try {
    await cluster.query(`CREATE DATABASE "${database}"`);
    created = true;
    process.env.MIGRATION_DATABASE_URL = migrationUrl.href;
    await migrate();
    await seed();
    // Older checkpoints use the candidate here; the coordinator's standard runner now owns 0013.
    const schema = await admin.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='idempotency_record' AND column_name='response_etag'",
    );
    if (!schema.rowCount)
      await admin.query(
        await readFile(resolve("docs/proposals/W05/native-draft-grants.proposed.sql"), "utf8"),
      );
    const adapter = new CmsHttpAdapter(runtime, {
      profiles: (client, context) => testProfilePort(client, context, deniedProfiles),
      trustedLinkPolicy: cmsTestPolicy,
      allowedOrigins: new Set([cmsTestOrigin]),
      storage: new MockStorageProvider(cmsTestOrigin),
    });
    server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 256 * 1024) throw new Error("Test request exceeds the fixture bound.");
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        const requestHeaders = Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(",") : value,
          ]),
        );
        const result = await adapter.handle({
          method: request.method ?? "GET",
          url: request.url ?? "/",
          headers: requestHeaders,
          remoteAddress: request.socket.remoteAddress,
          body: raw ? JSON.parse(raw) : undefined,
        });
        response.writeHead(result.status, result.headers);
        response.end(JSON.stringify(result.body));
      } catch {
        response.writeHead(400, { "content-type": "application/problem+json", "cache-control": "no-store" });
        response.end(
          JSON.stringify({
            type: "https://estate.example/problems/test_request_invalid",
            title: "Invalid test request.",
            status: 400,
            code: "test_request_invalid",
            traceId: database,
          }),
        );
      }
    });
    await new Promise<void>((resolveListen, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string" || [3000, 3001].includes(address.port))
      throw new Error("CMS test listener must own an ephemeral port.");
    return {
      admin,
      runtime,
      runtimeUrl: runtimeUrl.href,
      deniedProfiles,
      adapter,
      origin: `http://127.0.0.1:${address.port}`,
      database,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
