import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { migrationPool } from "./pool";

export async function migrate() {
  const pool = migrationPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(874521)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS public.estate_migration (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir(join(process.cwd(), "packages/db/migrations")))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const source = await readFile(join(process.cwd(), "packages/db/migrations", name), "utf8");
      const hash = createHash("sha256").update(source).digest("hex");
      const applied = await client.query("SELECT sha256 FROM public.estate_migration WHERE name=$1", [name]);
      if (applied.rowCount) {
        if (applied.rows[0].sha256 !== hash) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      // Keep the source checksum unchanged and commit DDL with its receipt.
      const escaped = name.replaceAll("'", "''");
      const receipt = `INSERT INTO public.estate_migration(name,sha256) VALUES ('${escaped}','${hash}');`;
      const begins = [...source.matchAll(/^[\t ]*BEGIN[\t ]*;[\t ]*(?:--[^\r\n]*)?$/gim)];
      const commits = [...source.matchAll(/^[\t ]*COMMIT[\t ]*;[\t ]*(?:--[^\r\n]*)?$/gim)];
      let tracked: string;
      if (begins.length === 0 && commits.length === 0) {
        tracked = `BEGIN;\n${source}\n${receipt}\nCOMMIT;`;
      } else if (begins.length === 1 && commits.length === 1 && begins[0].index < commits[0].index) {
        const commitIndex = commits[0].index;
        tracked = `${source.slice(0, commitIndex)}${receipt}\n${source.slice(commitIndex)}`;
      } else {
        throw new Error(`Migration requires one complete outer transaction or no transaction: ${name}`);
      }
      try {
        await client.query(tracked);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      console.log(`Applied ${name}`);
    }
    console.log("PostgreSQL/PostGIS migrations are current.");
  } finally {
    await client.query("SELECT pg_advisory_unlock(874521)").catch(() => {});
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/migrate.ts"))
  migrate().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
