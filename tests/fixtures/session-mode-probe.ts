import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { readProductionSession, readSession } from "../../packages/auth/sessions";
import { createRuntimePool } from "../helpers/database";

type ProbeInput = {
  mode: "read" | "http";
  reader: "synthetic" | "production";
  token?: string;
  userId: string;
  organizationId: string;
  includeDevelopmentLogin?: boolean;
};

async function probe() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProbeInput;
  if (input.mode === "read") {
    const pool = createRuntimePool();
    let connections = 0;
    pool.on("connect", () => {
      connections++;
    });
    try {
      const session = await (input.reader === "production" ? readProductionSession : readSession)(
        pool,
        input.token,
      );
      return {
        status: "accepted",
        identityMatch: session.userId === input.userId && session.organizationId === input.organizationId,
        connections,
      };
    } catch (error) {
      return { status: "rejected", code: (error as { code?: string }).code, connections };
    } finally {
      await pool.end();
    }
  }
  // Reader probes must not initialize the full HTTP application or its global pools.
  const { createApplication } = await import("../../apps/api/src/main");
  const { closeRuntimePool } = await import("../../packages/db/pool");
  const app = await createApplication();
  try {
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    const results = [];
    const scenarios: {
      path: string;
      forwarded?: string;
      localAddress?: string;
      method?: "GET" | "POST";
      body?: unknown;
    }[] = [
      { path: "/v1/session" },
      { path: `/v1/orgs/${input.organizationId}/contacts`, forwarded: "127.0.0.1" },
      { path: "/v1/session", forwarded: "203.0.113.42" },
      { path: `/v1/orgs/${input.organizationId}/contacts`, forwarded: "127.0.0.1,203.0.113.42" },
      { path: `/v1/orgs/${input.organizationId}/contacts`, forwarded: "203.0.113.42,127.0.0.1" },
      { path: "/v1/session", localAddress: "127.0.0.2" },
    ];
    if (input.includeDevelopmentLogin)
      scenarios.push({ path: "/dev/session", method: "POST", body: { identity: "owner" } });
    for (const scenario of scenarios) {
      results.push(
        await new Promise<{
          status: number;
          code?: string;
          cache?: string;
          identityMatch?: boolean;
          synthetic?: string;
        }>((resolve, reject) => {
          const headers: Record<string, string> = { cookie: `estate_session=${input.token}` };
          if (scenario.forwarded) headers["x-forwarded-for"] = scenario.forwarded;
          if (scenario.body) {
            headers["content-type"] = "application/json";
            headers.origin = "http://localhost:3000";
          }
          const outgoing = request(
            {
              hostname: "127.0.0.1",
              port,
              path: scenario.path,
              method: scenario.method ?? "GET",
              headers,
              localAddress: scenario.localAddress,
            },
            (response) => {
              const body: Buffer[] = [];
              response.on("data", (chunk) => body.push(Buffer.from(chunk)));
              response.on("error", reject);
              response.on("end", () => {
                const value = JSON.parse(Buffer.concat(body).toString("utf8"));
                resolve({
                  status: response.statusCode!,
                  code: value.code,
                  cache: response.headers["cache-control"],
                  synthetic: response.headers["x-synthetic-identity"] as string | undefined,
                  identityMatch: value.userId === input.userId && value.activeOrgId === input.organizationId,
                });
              });
            },
          );
          outgoing.once("error", reject);
          outgoing.end(scenario.body ? JSON.stringify(scenario.body) : undefined);
        }),
      );
    }
    return { status: "http", results };
  } finally {
    await app.close();
    await closeRuntimePool();
  }
}

probe()
  .then((result) => process.stdout.write(`SESSION_PROBE_RESULT=${JSON.stringify(result)}\n`))
  .catch(() => {
    // Never log stdin, cookies, connection strings or raw provider errors.
    process.stdout.write('SESSION_PROBE_RESULT={"status":"probe_failed"}\n');
    process.exitCode = 1;
  });
