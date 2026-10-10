import { accessConfig, type TrestleAccessConfig } from "./access-probe";
import { propertySchemaInventory, type PropertySchemaInventory } from "./metadata-inventory";
import { digest, safeText, TrestleError } from "./safety";
import { EnvironmentTrestleCredentials, TrestleClient } from "./trestle.client";

export interface TrestleListingTestConfig extends TrestleAccessConfig {
  operatorPurpose: "single-listing-local-inspection";
  localInspectionApproved: true;
  originatingSystemNames: string[];
  listingKey?: string;
}

export interface ListingInspection {
  state: "retrieved";
  retrievedAtUtc: string;
  purpose: "single-listing-local-inspection";
  schema: PropertySchemaInventory;
  listing: Record<string, unknown>;
  summary: {
    propertyRecords: 1;
    schemaFieldCount: number;
    returnedFieldCount: number;
    populatedFieldCount: number;
    missingFields: string[];
    related: { name: string; records: number | null; complete: boolean }[];
    complete: boolean;
    imageDownloads: 0;
  };
}

function config(value: unknown): TrestleListingTestConfig {
  const parsed = accessConfig(value) as TrestleListingTestConfig;
  if (
    parsed.connectionState !== "approved" ||
    !["approved", "not_required"].includes(parsed.brokerAuthorization)
  )
    throw new TrestleError("TRESTLE_FEED_NOT_AUTHORIZED");
  if (
    parsed.operatorPurpose !== "single-listing-local-inspection" ||
    parsed.localInspectionApproved !== true ||
    !Array.isArray(parsed.originatingSystemNames) ||
    parsed.originatingSystemNames.length < 1 ||
    parsed.originatingSystemNames.length > 20 ||
    parsed.originatingSystemNames.some((name) => !safeText(name)) ||
    (parsed.listingKey !== undefined && !safeText(parsed.listingKey))
  )
    throw new TrestleError("TRESTLE_LISTING_CONFIG_INVALID");
  return structuredClone(parsed);
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const present = (value: unknown) =>
  value !== null && value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0);

/** Owner-operated diagnostic only. Never register this raw-record reader as a public adapter. */
export async function probeTrestleListing(input: {
  enabled: boolean;
  environment: NodeJS.ProcessEnv;
  readConfig: () => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}): Promise<ListingInspection | { state: "disabled"; code: string }> {
  if (!input.enabled || input.environment.TRESTLE_LISTING_TEST_ENABLED !== "true")
    return { state: "disabled", code: "TRESTLE_LISTING_TEST_NOT_ENABLED" };
  const initial = config(await input.readConfig());
  const binding = digest(initial);
  const context = {
    organizationId: initial.organizationId,
    feedId: initial.feedId,
    policyVersion: "listing-inspection-v1",
  };
  const client = new TrestleClient(
    initial.endpoints,
    new EnvironmentTrestleCredentials(context, input.environment),
    input.fetch,
    input.now,
  );
  const guard = async () => {
    if (digest(config(await input.readConfig())) !== binding) {
      client.invalidate();
      throw new TrestleError("TRESTLE_AUTHORIZATION_CHANGED");
    }
  };
  try {
    const xml = await client.get(
      context,
      new URL("$metadata", client.endpoints.odataBaseUrl).href,
      true,
      guard,
    );
    await guard();
    const schema = propertySchemaInventory(xml);
    const url = new URL("Property", client.endpoints.odataBaseUrl);
    const source = initial.originatingSystemNames
      .map((name) => `OriginatingSystemName eq ${literal(name)}`)
      .join(" or ");
    let filter = `(${source}) and StandardStatus eq 'Active' and InternetEntireListingDisplayYN eq true and InternetAddressDisplayYN eq true`;
    if (initial.listingKey) filter += ` and ListingKey eq ${literal(initial.listingKey)}`;
    url.searchParams.set("$top", "1");
    url.searchParams.set("$filter", filter);
    url.searchParams.set("$orderby", "ListingKey asc");
    if (schema.navigation.length)
      url.searchParams.set(
        "$expand",
        schema.navigation
          .map(({ name, type }) => (type.startsWith("Collection(") ? `${name}($top=1000)` : name))
          .join(","),
      );
    const text = await client.get(context, url.href, false, guard);
    await guard();
    let body: { value?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw new TrestleError("TRESTLE_BAD_PROPERTY_RESPONSE");
    }
    if (!body || !Array.isArray(body.value) || body.value.length > 1)
      throw new TrestleError("TRESTLE_BAD_PROPERTY_RESPONSE");
    if (body.value.length === 0) throw new TrestleError("TRESTLE_LISTING_NOT_FOUND");
    const row = body.value[0] as Record<string, unknown>;
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new TrestleError("TRESTLE_BAD_PROPERTY_RESPONSE");
    if (!safeText(row.ListingKey) || row.synthetic === true || /^SYNTHETIC-/i.test(String(row.ListingKey)))
      throw new TrestleError("TRESTLE_UNTRUSTED_SOURCE_RECORD");
    if (
      !initial.originatingSystemNames.includes(String(row.OriginatingSystemName)) ||
      (initial.listingKey !== undefined && row.ListingKey !== initial.listingKey)
    )
      throw new TrestleError("TRESTLE_SOURCE_SCOPE_DENIED");
    if (
      row.StandardStatus !== "Active" ||
      row.InternetEntireListingDisplayYN !== true ||
      row.InternetAddressDisplayYN !== true
    )
      throw new TrestleError("TRESTLE_LISTING_DISPLAY_DENIED");
    const known = new Set([...schema.fields, ...schema.navigation].map(({ name }) => name));
    if (
      Object.keys(row).some(
        (name) =>
          !known.has(name) &&
          !name.startsWith("@odata.") &&
          !(name.endsWith("@odata.nextLink") && known.has(name.split("@")[0])),
      )
    )
      throw new TrestleError("TRESTLE_UNEXPECTED_PROPERTY_FIELD");
    const serialized = JSON.stringify(row);
    for (const value of [input.environment.TRESTLE_CLIENT_ID, input.environment.TRESTLE_CLIENT_SECRET]) {
      if (value && serialized.includes(JSON.stringify(value).slice(1, -1)))
        throw new TrestleError("TRESTLE_UNSAFE_DIAGNOSTIC_RESPONSE");
    }
    const related = schema.navigation.map(({ name, type }) => {
      const collection = type.startsWith("Collection(");
      const value = row[name];
      const records = collection
        ? Array.isArray(value)
          ? value.length
          : null
        : value === null
          ? 0
          : value && typeof value === "object" && !Array.isArray(value)
            ? 1
            : null;
      if (records !== null && records > 1000) throw new TrestleError("TRESTLE_BAD_PROPERTY_RESPONSE");
      return {
        name,
        records,
        complete: records !== null && records < 1000 && !row[`${name}@odata.nextLink`],
      };
    });
    const returned = schema.fields.filter(({ name }) => Object.hasOwn(row, name));
    const missingFields = schema.fields
      .filter(({ name }) => !Object.hasOwn(row, name))
      .map(({ name }) => name);
    await guard();
    return {
      state: "retrieved",
      retrievedAtUtc: (input.now?.() ?? new Date()).toISOString(),
      purpose: "single-listing-local-inspection",
      schema,
      listing: row,
      summary: {
        propertyRecords: 1,
        schemaFieldCount: schema.fields.length,
        returnedFieldCount: returned.length,
        populatedFieldCount: returned.filter(({ name }) => present(row[name])).length,
        missingFields,
        related,
        complete: missingFields.length === 0 && related.every(({ complete }) => complete),
        imageDownloads: 0,
      },
    };
  } finally {
    client.invalidate();
  }
}
