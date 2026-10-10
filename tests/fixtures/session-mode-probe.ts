import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createApplication } from "../../apps/api/src/main";
import { readSession } from "../../packages/auth/sessions";
import { closeRuntimePool } from "../../packages/db/pool";
import { createRuntimePool } from "../helpers/database";

type ProbeInput = { mode: "read" | "http"; token: string; userId: string; organizationId: string };

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
      const session = await readSession(pool, input.token);
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
  const app = await createApplication();
  try {
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    const results = [];
    for (const scenario of [
      { path: "/v1/session" },
      { path: `/v1/orgs/${input.organizationId}/contacts`, forwarded: "127.0.0.1" },
      { path: "/v1/session", forwarded: "203.0.113.42" },
      { path: `/v1/orgs/${input.organizationId}/contacts`, forwarded: "127.0.0.1,203.0.113.42" },
      { path: `/v1/orgs/${input.organizationId}/contacts`, forwarded: "203.0.113.42,127.0.0.1" },
      { path: "/v1/session", localAddress: "127.0.0.2" },
    ]) {
      results.push(
        await new Promise<{ status: number; code?: string; cache?: string; identityMatch?: boolean }>(
          (resolve, reject) => {
            const headers: Record<string, string> = { cookie: `estate_session=${input.token}` };
            if (scenario.forwarded) headers["x-forwarded-for"] = scenario.forwarded;
            const outgoing = request(
              {
                hostname: "127.0.0.1",
                port,
                path: scenario.path,
                method: "GET",
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
                    identityMatch:
                      value.userId === input.userId && value.activeOrgId === input.organizationId,
                  });
                });
              },
            );
            outgoing.once("error", reject);
            outgoing.end();
          },
        ),
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
