import Ajv from "ajv";
import addFormats from "ajv-formats";
import contract from "../contracts/openapi.json";
import type { components, operations } from "../contracts/generated/api";

export type Listing = components["schemas"]["Listing"];
export type ListingCriteria = components["schemas"]["ListingCriteria"];
export type DisplayPolicy = components["schemas"]["DisplayPolicy"];
export type PageListing = components["schemas"]["PageListing"];
export type AttributionContact = components["schemas"]["Attribution"]["contact"];
export type ListingSort = NonNullable<
  NonNullable<operations["searchPublicListings"]["parameters"]["query"]>["sort"]
>;

const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
ajv.addSchema({ $id: "mls-v1", components: contract.components });
export const isListing = ajv.compile<Listing>({ $ref: "mls-v1#/components/schemas/Listing" });
export const isAttributionContact = ajv.compile<AttributionContact>(
  contract.components.schemas.Attribution.properties.contact,
);
export const isDisplayPolicy = ajv.compile<DisplayPolicy>({
  $ref: "mls-v1#/components/schemas/DisplayPolicy",
});
export const isListingCriteria = ajv.compile<ListingCriteria>({
  $ref: "mls-v1#/components/schemas/ListingCriteria",
});

export class MlsReadError extends Error {
  constructor(
    readonly status: 403 | 404 | 422 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
