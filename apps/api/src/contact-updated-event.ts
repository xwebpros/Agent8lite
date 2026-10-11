import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import eventSchema from "../../../packages/contracts/internal/native-contact-updated-event-v1.schema.json";
import { AccessError } from "../../../packages/db/tenant-transaction";

const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true });
addFormats(ajv);
const validEvent = ajv.compile(eventSchema);

/** ADR-048: references-only internal event for one fresh committed Contact revision. */
export function contactUpdatedEvent(
  tenantId: string,
  contactId: string,
  version: number,
  correlationId: string,
  instant: Date,
) {
  if (
    !(instant instanceof Date) ||
    !Number.isFinite(instant.getTime()) ||
    typeof correlationId !== "string" ||
    !correlationId ||
    [...correlationId].length > 80 ||
    /[\uD800-\uDFFF]/u.test(correlationId) ||
    !Number.isSafeInteger(version) ||
    version < 2
  )
    throw new AccessError(503, "event_contract_failure", "Contact reference event validation failed.");
  const timestamp = instant.toISOString();
  const event = {
    eventId: randomUUID(),
    type: "contact.updated",
    version: 1,
    tenantId,
    occurredAt: timestamp,
    ingestedAt: timestamp,
    producer: "crm",
    aggregateType: "contact",
    aggregateId: contactId,
    correlationId,
    payload: { resourceId: contactId, resourceVersion: version },
  };
  if (!validEvent(event) || event.aggregateId !== event.payload.resourceId)
    throw new AccessError(503, "event_contract_failure", "Contact reference event validation failed.");
  return event;
}
