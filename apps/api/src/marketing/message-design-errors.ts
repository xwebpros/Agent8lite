import { AccessError } from "../../../../packages/db/tenant-transaction";
import {
  NativeMessageDesignError,
  prepareNativeMessageDesign,
  type NativeDesignIssue,
  type NativeMessageDesignWrite,
} from "../../../../packages/marketing/native-design";

/** Only curated preparation issues are exposed; SQL/provider properties never become fields. */
export class MessageDesignCommandError extends AccessError {
  readonly errors: readonly NativeDesignIssue[];
  constructor(status: number, code: string, message: string, issues: readonly NativeDesignIssue[]) {
    super(status, code, message);
    this.errors = Object.freeze(issues.slice(0, 100).map((issue) => Object.freeze({ ...issue })));
  }
}

export function prepareMessageDesignCommand(body: NativeMessageDesignWrite) {
  try {
    return prepareNativeMessageDesign(body);
  } catch (error) {
    if (error instanceof NativeMessageDesignError)
      throw new MessageDesignCommandError(422, error.code, error.message, error.issues);
    throw error;
  }
}

/** Translate only the reviewed constraint identifiers, never raw database messages. */
export function messageDesignStorageError(error: unknown): never {
  if (error !== null && typeof error === "object" && "code" in error && "constraint" in error) {
    if (error.code === "23514" && error.constraint === "native_design_unreferenced")
      throw new AccessError(
        409,
        "design_referenced_immutable",
        "A referenced design cannot be edited; create a copy.",
      );
    if (error.code === "23514" && error.constraint === "native_design_sequence_available")
      throw new AccessError(409, "design_revision_exhausted", "The design revision cannot be advanced.");
    if (error.code === "23514" && error.constraint === "native_design_history_available")
      throw new AccessError(503, "design_source_unavailable", "Current design history is unavailable.");
    if (error.code === "23514" && error.constraint === "native_design_source_available")
      throw new AccessError(404, "resource_unavailable", "Message design unavailable or out of scope.");
  }
  throw error;
}
