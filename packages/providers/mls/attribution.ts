import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import amendment from "../../contracts/amendments/ADR-022-listing-attribution-contact.json";
import type { MlsAttributionContact } from "./port";

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validContact = ajv.compile(amendment.definition);

/** Preserve only an actual participant-provided email/phone; never infer an inquiry destination. */
export function providedAttributionContact(value: unknown): MlsAttributionContact | null {
  if (typeof value !== "string" || value.length > 254 || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (!value.length || value.trim() !== value) return null;
  for (const kind of ["email", "phone"] as const) {
    const contact = { kind, value };
    if (validContact(contact)) return Object.freeze(contact);
  }
  return null;
}
