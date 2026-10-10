import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "../../../../packages/contracts/internal/synthetic-staff-v1.schema.json";
import events from "../../../../packages/contracts/events.schema.json";
import { AccessError } from "../../../../packages/db/tenant-transaction";
const ajv = new Ajv2020({ strict: false, allErrors: false });
addFormats(ajv);
ajv.addSchema(schema);
const eventValidator = ajv.compile(events);
export function validateStaff(
  name: "SessionRequest" | "SessionResponse" | "EmptyCommand" | "SupportSelection",
  value: unknown,
  response = false,
) {
  const validate =
    ajv.getSchema(`${schema.$id}#/$defs/${name}`) ?? ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
  if (!validate(value))
    throw new AccessError(
      response ? 500 : 422,
      response ? "response_contract_failure" : "schema_invalid",
      response ? "Response validation failed." : "Request does not match the staff helper schema.",
    );
}
export function validateControlEvent(value: unknown) {
  if (!eventValidator(value))
    throw new AccessError(500, "event_contract_failure", "Event validation failed.");
}
