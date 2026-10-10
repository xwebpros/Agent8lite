import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import nativeCapture from "../../../packages/contracts/internal/native-capture-v1.schema.json";
import syntheticConsent from "../../../packages/contracts/internal/synthetic-consent-v1.schema.json";
import { AccessError } from "../../../packages/db/tenant-transaction";

const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema({ $id: "estate.openapi", components: { schemas: contract.components.schemas } });
// All references resolve to the frozen local document; no remote schema fetching.
ajv.addSchema({
  $id: "https://estate.example/schemas/openapi",
  components: { schemas: contract.components.schemas },
});
const nativeCaptureValidator = ajv.compile(nativeCapture);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
const consentAjv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
addFormats(consentAjv);
consentAjv.addSchema({
  $id: "https://estate.example/schemas/openapi",
  components: { schemas: contract.components.schemas },
});
consentAjv.addSchema(syntheticConsent);
const consentValidators = new Map<string, ReturnType<typeof consentAjv.compile>>();

export function validateSyntheticConsent(
  name: "EvidenceRequest" | "EvidenceResponse" | "ChannelsResponse",
  value: unknown,
  response = false,
) {
  let validator = consentValidators.get(name);
  if (!validator) {
    validator = consentAjv.compile({ $ref: `${syntheticConsent.$id}#/$defs/${name}` });
    consentValidators.set(name, validator);
  }
  if (!validator(value))
    throw new AccessError(
      response ? 500 : 422,
      response ? "response_contract_failure" : "schema_invalid",
      response ? "Response validation failed." : "Request does not match the consent helper schema.",
    );
}

export function validateNativeCapture(value: unknown) {
  if (!nativeCaptureValidator(value))
    throw new AccessError(422, "schema_invalid", "Request does not match the native capture schema.");
}

export function validateSchema(name: string, value: unknown, response = false) {
  let validator = validators.get(name);
  if (!validator) {
    validator = ajv.compile({ $ref: `estate.openapi#/components/schemas/${name}` });
    validators.set(name, validator);
  }
  if (!validator(value))
    throw new AccessError(
      response ? 500 : 422,
      response ? "response_contract_failure" : "schema_invalid",
      response ? "Response validation failed." : "Request does not match the API schema.",
    );
}

export function operation(path: string, method: string) {
  const item = (contract.paths as Record<string, Record<string, unknown>>)[path]?.[method.toLowerCase()] as
    | {
        "x-permission": string;
        requestBody?: { content: Record<string, { schema: { $ref: string } }> };
        responses: Record<string, { content?: Record<string, { schema: { $ref: string } }> }>;
      }
    | undefined;
  if (!item) throw new AccessError(404, "route_unavailable", "Route unavailable.");
  return item;
}

export function schemaName(reference: string) {
  return reference.split("/").at(-1)!;
}
