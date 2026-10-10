import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const api = JSON.parse(await fs.readFile("packages/contracts/openapi.json", "utf8"));
const events = JSON.parse(await fs.readFile("packages/contracts/events.schema.json", "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "api", components: api.components });
ajv.addSchema({ $id: "https://estate.example/schemas/openapi", components: api.components });
const capture = JSON.parse(
  await fs.readFile("packages/contracts/internal/native-capture-v1.schema.json", "utf8"),
);
ajv.compile(capture);
const consent = JSON.parse(
  await fs.readFile("packages/contracts/internal/synthetic-consent-v1.schema.json", "utf8"),
);
ajv.addSchema(consent);
for (const definition of Object.keys(consent.$defs))
  ajv.compile({ $ref: `${consent.$id}#/$defs/${definition}` });
for (const [name, schema] of Object.entries(api.components.schemas)) {
  ajv.compile({ ...schema, components: api.components });
  if (!schema.type && !schema.oneOf && !schema.anyOf && !schema.allOf)
    throw new Error(`Schema missing shape: ${name}`);
}
ajv.compile(events);
const ids = new Set();
for (const [path, item] of Object.entries(api.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    if (ids.has(operation.operationId)) throw new Error(`Duplicate operation ${operation.operationId}`);
    ids.add(operation.operationId);
    if (!operation["x-permission"] || !operation.responses) throw new Error(`Incomplete operation ${path}`);
  }
}
for (const file of [
  "openapi.json",
  "events.schema.json",
  "permission-catalog.json",
  "role-presets.json",
  "pwa-policy.json",
]) {
  const source = await fs.readFile(`blueprint/contracts/${file}`);
  const copied = await fs.readFile(`packages/contracts/${file}`);
  if (!source.equals(copied)) throw new Error(`Unreviewed contract drift: ${file}`);
}
if (process.argv.includes("--generated")) {
  await fs.mkdir(".local", { recursive: true });
  const before = await fs.readFile("packages/contracts/generated/api.ts", "utf8");
  execFileSync(
    process.execPath,
    [
      "node_modules/openapi-typescript/bin/cli.js",
      "packages/contracts/openapi.json",
      "--empty-objects-unknown",
      "-o",
      ".local/generated-check.ts",
    ],
    { stdio: "pipe" },
  );
  const after = await fs.readFile(".local/generated-check.ts", "utf8");
  if (before !== after) throw new Error("Generated API types drifted. Run pnpm contracts:generate.");
}
console.log(
  `PASS: ${ids.size} operations, ${Object.keys(api.components.schemas).length} schemas, event envelope, frozen contracts${process.argv.includes("--generated") ? ", generated types" : ""}.`,
);
