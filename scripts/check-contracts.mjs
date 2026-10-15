import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const api = JSON.parse(await fs.readFile("packages/contracts/openapi.json", "utf8"));
const events = JSON.parse(await fs.readFile("packages/contracts/events.schema.json", "utf8"));
const attributionAmendment = JSON.parse(
  await fs.readFile("packages/contracts/amendments/ADR-022-listing-attribution-contact.json", "utf8"),
);
if (attributionAmendment.schema !== "Attribution" || attributionAmendment.property !== "contact")
  throw new Error("Unsupported approved attribution amendment target.");
const stageTransitionAmendment = JSON.parse(
  await fs.readFile("packages/contracts/amendments/ADR-043-stage-transition-if-match.json", "utf8"),
);
if (
  stageTransitionAmendment.operationId !== "transitionLead" ||
  stageTransitionAmendment.path !== "/v1/orgs/{orgId}/leads/{leadId}/stage-transitions" ||
  stageTransitionAmendment.method !== "post" ||
  stageTransitionAmendment.parameter?.name !== "If-Match" ||
  stageTransitionAmendment.parameter?.in !== "header"
)
  throw new Error("Unsupported approved stage-transition amendment target.");
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "api", components: api.components });
ajv.addSchema({ $id: "https://estate.example/schemas/openapi", components: api.components });
const capture = JSON.parse(
  await fs.readFile("packages/contracts/internal/native-capture-v1.schema.json", "utf8"),
);
ajv.compile(capture);
ajv.compile(
  JSON.parse(
    await fs.readFile("packages/contracts/internal/native-contact-created-event-v1.schema.json", "utf8"),
  ),
);
ajv.compile(
  JSON.parse(
    await fs.readFile("packages/contracts/internal/native-contact-updated-event-v1.schema.json", "utf8"),
  ),
);
const consent = JSON.parse(
  await fs.readFile("packages/contracts/internal/synthetic-consent-v1.schema.json", "utf8"),
);
ajv.addSchema(consent);
for (const definition of Object.keys(consent.$defs))
  ajv.compile({ $ref: `${consent.$id}#/$defs/${definition}` });
const staff = JSON.parse(
  await fs.readFile("packages/contracts/internal/synthetic-staff-v1.schema.json", "utf8"),
);
ajv.addSchema(staff);
for (const definition of Object.keys(staff.$defs)) ajv.compile({ $ref: `${staff.$id}#/$defs/${definition}` });
ajv.compile(
  JSON.parse(await fs.readFile("packages/contracts/internal/worker-wakeup-v1.schema.json", "utf8")),
);
ajv.compile(
  JSON.parse(await fs.readFile("packages/contracts/internal/native-cms-recovery-v1.schema.json", "utf8")),
);
ajv.compile(
  JSON.parse(
    await fs.readFile("packages/contracts/internal/native-cms-revision-history-v1.schema.json", "utf8"),
  ),
);
ajv.compile(
  JSON.parse(
    await fs.readFile("packages/contracts/internal/native-campaign-draft-event-v1.schema.json", "utf8"),
  ),
);
ajv.compile(
  JSON.parse(
    await fs.readFile("packages/contracts/internal/native-contact-merged-event-v1.schema.json", "utf8"),
  ),
);
const contactMergeAmendment = JSON.parse(
  await fs.readFile("packages/contracts/amendments/ADR-049-contact-merge.json", "utf8"),
);
const idxTemplateAmendment = JSON.parse(
  await fs.readFile("packages/contracts/amendments/ADR-061-idx-template.json", "utf8"),
);
const idxTemplatePaths = [
  "/v1/public/sites/{siteId}/idx-template/content",
  "/v1/public/sites/{siteId}/idx-template/status",
  "/v1/public/sites/{siteId}/idx-template/listings",
  "/v1/public/sites/{siteId}/idx-template/listings/{listingKey}",
  "/v1/public/sites/{siteId}/idx-template/inquiries",
];
const idxTemplateSchemas = [
  "IdxTemplateListing",
  "IdxTemplateListingPage",
  "IdxTemplateText",
  "IdxTemplateBrand",
  "IdxTemplateCapabilities",
  "IdxTemplateContent",
  "IdxTemplateStatus",
  "IdxTemplateInquiryWrite",
];
if (
  JSON.stringify(Object.keys(idxTemplateAmendment.paths ?? {})) !== JSON.stringify(idxTemplatePaths) ||
  JSON.stringify(Object.keys(idxTemplateAmendment.schemas ?? {})) !== JSON.stringify(idxTemplateSchemas)
)
  throw new Error("Unsupported approved IDX template amendment shape.");
if (
  !contactMergeAmendment.paths ||
  !contactMergeAmendment.schemas ||
  !Object.hasOwn(contactMergeAmendment.paths, "/v1/orgs/{orgId}/contact-duplicates") ||
  !Object.hasOwn(contactMergeAmendment.paths, "/v1/orgs/{orgId}/contacts/{contactId}/merges") ||
  !Object.hasOwn(contactMergeAmendment.paths, "/v1/orgs/{orgId}/contact-merges/{mergeId}") ||
  !Object.hasOwn(contactMergeAmendment.schemas, "ContactDuplicate") ||
  !Object.hasOwn(contactMergeAmendment.schemas, "PageContactDuplicate") ||
  !Object.hasOwn(contactMergeAmendment.schemas, "ContactMergeRequest") ||
  !Object.hasOwn(contactMergeAmendment.schemas, "ConsentMergeOutcome") ||
  !Object.hasOwn(contactMergeAmendment.schemas, "ContactMerge")
)
  throw new Error("Unsupported approved contact-merge amendment shape.");
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
  if (file === "openapi.json") {
    const expected = JSON.parse(source.toString("utf8"));
    if (Object.hasOwn(expected.components.schemas.Attribution.properties, "contact"))
      throw new Error("Original attribution contract unexpectedly changed.");
    expected.components.schemas.Attribution.properties.contact = attributionAmendment.definition;
    const amendedOperation = expected.paths[stageTransitionAmendment.path]?.[stageTransitionAmendment.method];
    if (!amendedOperation || amendedOperation.operationId !== stageTransitionAmendment.operationId)
      throw new Error("Original stage-transition operation unexpectedly changed.");
    if (amendedOperation.parameters.some((parameter) => parameter.name === "If-Match"))
      throw new Error("Original stage-transition contract unexpectedly contains If-Match.");
    amendedOperation.parameters.push(stageTransitionAmendment.parameter);
    // Apply ADR-049 additive amendment: new paths and schemas
    for (const [path, item] of Object.entries(contactMergeAmendment.paths)) {
      if (Object.hasOwn(expected.paths, path))
        throw new Error(`ADR-049 amendment path unexpectedly present in original: ${path}`);
      expected.paths[path] = item;
    }
    for (const [name, schema] of Object.entries(contactMergeAmendment.schemas)) {
      if (Object.hasOwn(expected.components.schemas, name))
        throw new Error(`ADR-049 amendment schema unexpectedly present in original: ${name}`);
      expected.components.schemas[name] = schema;
    }
    for (const [path, item] of Object.entries(idxTemplateAmendment.paths)) {
      if (Object.hasOwn(expected.paths, path)) throw new Error(`ADR-061 path collision: ${path}`);
      expected.paths[path] = item;
    }
    for (const [name, schema] of Object.entries(idxTemplateAmendment.schemas)) {
      if (Object.hasOwn(expected.components.schemas, name))
        throw new Error(`ADR-061 schema collision: ${name}`);
      expected.components.schemas[name] = schema;
    }
    // Apply ADR-055 additive amendment: job listing endpoint (inserted in key order)
    const jobListingAmendment = JSON.parse(
      await fs.readFile("packages/contracts/amendments/ADR-055-job-listing.json", "utf8"),
    );
    for (const addedPath of Object.keys(jobListingAmendment.paths)) {
      if (Object.hasOwn(expected.paths, addedPath))
        throw new Error(`ADR-055 amendment path unexpectedly present in original: ${addedPath}`);
    }
    {
      const ordered = {};
      for (const [p, v] of Object.entries(expected.paths)) {
        // Insert the jobs listing path right before /v1/orgs/{orgId}/jobs/{jobId}
        if (p === "/v1/orgs/{orgId}/jobs/{jobId}") {
          for (const addedPath of Object.keys(jobListingAmendment.paths)) {
            ordered[addedPath] = api.paths[addedPath];
          }
        }
        ordered[p] = v;
      }
      // If insertion point wasn't found, append
      for (const addedPath of Object.keys(jobListingAmendment.paths)) {
        if (!Object.hasOwn(ordered, addedPath)) ordered[addedPath] = api.paths[addedPath];
      }
      expected.paths = ordered;
    }
    if (JSON.stringify(expected) !== JSON.stringify(api))
      throw new Error("Unreviewed OpenAPI drift beyond ADR-022, ADR-043, ADR-049, ADR-055 and ADR-061 amendments.");
  } else if (!source.equals(copied)) throw new Error(`Unreviewed contract drift: ${file}`);
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
  `PASS: ${ids.size} operations, ${Object.keys(api.components.schemas).length} schemas, event envelope, original contracts plus exact ADR-022/043/049/055/061 amendments${process.argv.includes("--generated") ? ", generated types" : ""}.`,
);
