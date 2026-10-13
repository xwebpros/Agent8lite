import { z } from "zod";
import type { components } from "../../../../packages/contracts/generated/api";

export const inquiryFields = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100),
  email: z.string().trim().email("Enter a valid email address.").max(254),
  phone: z.string().trim().max(30).optional(),
  message: z.string().trim().min(1, "Message is required.").max(2000),
});
export type InquiryFields = { name: string; email: string; phone: string; message: string };
export type InquiryBinding = {
  siteId: string;
  listingKey: string;
  listingId?: string;
  formId: string;
  formVersion: number;
};
export type InquiryCommand = {
  readonly siteId: string;
  readonly key: string;
  readonly body: components["schemas"]["IdxTemplateInquiryWrite"];
};
export type InquirySnapshot = {
  phase: "editing" | "pending" | "unknown" | "received";
  fields: InquiryFields;
  fieldErrors: Partial<Record<keyof InquiryFields, string>>;
  error: string;
  receipt: components["schemas"]["SubmissionReceipt"] | null;
};
const emptyFields = (): InquiryFields => ({
  name: "",
  email: "",
  phone: "",
  message: "I'm interested in this property.",
});
const receiptSchema = z.object({ receiptId: z.string().uuid(), message: z.string() }).strict();
export class InquiryResponseError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
type Transport = (command: InquiryCommand) => Promise<unknown>;

/** Tab-memory state only. Never persisted, cached by the service worker, or automatically retried. */
export class InquiryRecoveryController {
  private state: InquirySnapshot = {
    phase: "editing",
    fields: emptyFields(),
    fieldErrors: {},
    error: "",
    receipt: null,
  };
  private command: InquiryCommand | null = null;
  private listeners = new Set<() => void>();
  constructor(
    private binding: InquiryBinding,
    private readonly transport: Transport,
    private readonly key: () => string = () => crypto.randomUUID(),
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(state: InquirySnapshot) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  get hasUnresolvedCommand() {
    return this.state.phase === "pending" || this.state.phase === "unknown";
  }
  get hasDirtyDraft() {
    const initial = emptyFields();
    return (
      this.state.phase !== "received" &&
      Object.entries(this.state.fields).some(
        ([field, value]) => initial[field as keyof InquiryFields] !== value,
      )
    );
  }
  rebind(binding: InquiryBinding) {
    if (binding.siteId !== this.binding.siteId || binding.listingKey !== this.binding.listingKey)
      throw new Error("An inquiry cannot change its site or property scope.");
    // Published form changes may affect a new draft, never an already issued command.
    if (this.state.phase === "editing") this.binding = { ...binding };
  }
  update(field: keyof InquiryFields, value: string) {
    if (this.state.phase !== "editing") return;
    this.command = null;
    this.set({ ...this.state, fields: { ...this.state.fields, [field]: value }, error: "", fieldErrors: {} });
  }
  explainNavigationGuard() {
    if (this.hasUnresolvedCommand)
      this.set({
        ...this.state,
        error:
          "Check the submitted inquiry before leaving this site. Its original command key is retained in this tab.",
      });
  }
  async submit(online: boolean): Promise<void> {
    // This guard changes synchronously, before the first await or React rerender.
    if (this.state.phase === "pending" || this.state.phase === "received") return;
    if (!online) {
      this.set({ ...this.state, error: "Offline. Reconnect before submitting or checking this inquiry." });
      return;
    }
    const wasUnknown = this.state.phase === "unknown";
    if (!this.command) {
      const parsed = inquiryFields.safeParse({
        ...this.state.fields,
        phone: this.state.fields.phone || undefined,
      });
      if (!parsed.success) {
        const fieldErrors: InquirySnapshot["fieldErrors"] = {};
        for (const issue of parsed.error.issues) {
          const field = issue.path[0] as keyof InquiryFields;
          fieldErrors[field] ??= issue.message;
        }
        this.set({ ...this.state, error: "Please check your inquiry details.", fieldErrors });
        return;
      }
      this.command = Object.freeze({
        siteId: this.binding.siteId,
        key: this.key(),
        body: Object.freeze({
          ...parsed.data,
          listingKey: this.binding.listingKey,
          ...(this.binding.listingId ? { listingId: this.binding.listingId } : {}),
          formId: this.binding.formId,
          formVersion: this.binding.formVersion,
        }),
      });
    }
    const command = this.command;
    this.set({ ...this.state, phase: "pending", error: "", fieldErrors: {} });
    try {
      const receipt = receiptSchema.parse(await this.transport(command));
      this.command = null;
      this.set({ phase: "received", fields: emptyFields(), fieldErrors: {}, error: "", receipt });
    } catch (cause) {
      // Only an explicit rejection of the first attempt proves no receipt was accepted.
      // A later denial or conflict cannot disprove an earlier uncertain commit.
      const definiteRejection =
        cause instanceof InquiryResponseError && [400, 401, 403, 404, 410, 422].includes(cause.status);
      const uncertain = wasUnknown || !definiteRejection;
      if (!uncertain) this.command = null;
      this.set({
        ...this.state,
        phase: uncertain ? "unknown" : "editing",
        error: uncertain
          ? "The outcome is unknown. Keep this tab open and check the same inquiry to reconcile it safely."
          : cause instanceof Error
            ? cause.message
            : "Your inquiry could not be received.",
      });
    }
  }
}

/** Site scope remains fixed even when a detail page or the offline shell unmounts a consumer. */
export class InquiryRecoveryRegistry {
  private readonly controllers = new Map<string, InquiryRecoveryController>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  constructor(
    private readonly siteId: string,
    private readonly transport: Transport,
  ) {}
  get(binding: InquiryBinding) {
    if (binding.siteId !== this.siteId) throw new Error("Inquiry registry site scope mismatch.");
    let controller = this.controllers.get(binding.listingKey);
    if (!controller) {
      controller = new InquiryRecoveryController(binding, this.transport);
      controller.subscribe(() => {
        this.revision += 1;
        for (const listener of this.listeners) listener();
      });
      this.controllers.set(binding.listingKey, controller);
    }
    return controller;
  }
  all() {
    return [...this.controllers.values()];
  }
  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
