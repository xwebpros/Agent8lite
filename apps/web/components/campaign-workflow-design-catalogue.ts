import { ApiError, type Schema } from "../lib/api";
import {
  freezeMessageDesign,
  isMessageDesignId,
  messageDesignWriteFromReceipt,
  requireMessageDesignPage,
  requireMessageDesignReceipt,
  type MessageDesignReceipt,
} from "./message-design-protocol";

export type WorkflowDesignChannel = Schema<"MessageDesign">["channel"];
export type WorkflowDesignChoice = Readonly<
  Pick<Schema<"MessageDesign">, "id" | "name" | "channel" | "version">
>;
export type WorkflowDesignCatalogueState = Readonly<{
  online: boolean;
  reading: boolean;
  page: Schema<"PageMessageDesign"> | null;
  preview: MessageDesignReceipt | null;
  previewNodeKey: string | null;
  phase: "unread" | "ready" | "unavailable" | "denied";
  error: string;
  nodeError: Readonly<{ nodeKey: string; message: string }> | null;
}>;
export interface WorkflowDesignCatalogueClient {
  list(cursor?: string | null): Promise<unknown>;
  detail(id: string): Promise<{ data: unknown; etag: string }>;
}
export function workflowDesignChoices(
  page: Schema<"PageMessageDesign"> | null,
  channel: WorkflowDesignChannel,
): readonly WorkflowDesignChoice[] {
  if (!page) return [];
  const verified = requireMessageDesignPage(page);
  return freezeMessageDesign(
    verified.items
      .filter((design) => design.channel === channel && Boolean(messageDesignWriteFromReceipt(design)))
      .map(({ id, name, channel, version }) => ({ id, name, channel, version })),
  );
}
export function requireWorkflowDesign(
  value: unknown,
  etag: string,
  id: string,
  channel: WorkflowDesignChannel,
): MessageDesignReceipt {
  if (!isMessageDesignId(id)) throw new Error("Choose an authorized design reference.");
  const receipt = requireMessageDesignReceipt(value, etag, id);
  if (receipt.data.channel !== channel || !messageDesignWriteFromReceipt(receipt.data))
    throw new Error("Choose a current native design for this channel.");
  return receipt;
}

/** A separate bounded read lifetime never owns or replaces the protected workflow command. */
export class CampaignWorkflowDesignCatalogue {
  private state: WorkflowDesignCatalogueState;
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private detached = false;
  private revoked = false;
  constructor(
    private readonly options: {
      online: boolean;
      client: WorkflowDesignCatalogueClient;
      isCurrent(): boolean;
      applySelection(nodeKey: string, receipt: MessageDesignReceipt): boolean;
      onSourceUnavailable?(nodeKey: string, id: string): void;
      onAuthorityLost?(error: ApiError): void;
    },
  ) {
    this.state = freezeMessageDesign({
      online: options.online,
      reading: false,
      page: null,
      preview: null,
      previewNodeKey: null,
      phase: "unread",
      error: "",
      nodeError: null,
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<WorkflowDesignCatalogueState>) {
    this.state = freezeMessageDesign({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  private available() {
    return !this.detached && !this.revoked && this.state.online && this.options.isCurrent();
  }
  private current(epoch: number) {
    return epoch === this.epoch && this.available();
  }
  invalidate() {
    ++this.epoch;
    this.update({
      reading: false,
      page: null,
      preview: null,
      previewNodeKey: null,
      error: "",
      nodeError: null,
      phase: this.revoked ? "denied" : "unread",
    });
  }
  attach() {
    if (!this.revoked) this.detached = false;
  }
  detach() {
    this.detached = true;
    this.invalidate();
  }
  revoke() {
    this.revoked = true;
    this.invalidate();
  }
  setOnline(online: boolean) {
    if (online === this.state.online) return;
    if (!online) this.invalidate();
    this.update({ online });
  }
  async refresh(): Promise<void> {
    this.invalidate();
    await this.loadPage();
  }
  private fail(error: unknown, nodeKey?: string, id?: string) {
    const authority = error instanceof ApiError && [401, 403].includes(error.status);
    if (authority) {
      const entitlement = error.status === 403 && error.code === "entitlement_disabled";
      if (entitlement) this.invalidate();
      else this.revoke();
      this.update({
        phase: entitlement ? "unavailable" : "denied",
        error: "Current design access or marketing capability could not be verified.",
      });
      this.options.onAuthorityLost?.(error);
      return;
    }
    this.update({
      reading: false,
      preview: null,
      previewNodeKey: null,
      ...(nodeKey ? {} : { page: null, phase: "unavailable" as const }),
      error: nodeKey ? "" : "The current design catalogue could not be verified. No choices were replaced.",
      nodeError: nodeKey
        ? {
            nodeKey,
            message:
              "This current native design is unavailable or incompatible. The original workflow reference is unchanged.",
          }
        : null,
    });
    if (nodeKey && id) this.options.onSourceUnavailable?.(nodeKey, id);
  }
  async loadPage(cursor?: string | null): Promise<void> {
    if (!this.available() || this.state.reading || (cursor && cursor !== this.state.page?.nextCursor)) return;
    const epoch = ++this.epoch;
    this.update({ reading: true, preview: null, previewNodeKey: null, nodeError: null, error: "" });
    try {
      const value = await this.options.client.list(cursor);
      if (!this.current(epoch)) return;
      this.update({ page: requireMessageDesignPage(value), phase: "ready" });
    } catch (error) {
      if (this.current(epoch)) this.fail(error);
    } finally {
      if (this.current(epoch)) this.update({ reading: false });
    }
  }
  async choose(nodeKey: string, id: string, channel: WorkflowDesignChannel): Promise<void> {
    if (
      !this.available() ||
      this.state.reading ||
      !isMessageDesignId(id) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(nodeKey)
    )
      return;
    // Only an explicitly displayed current-page choice may replace a node.
    if (!workflowDesignChoices(this.state.page, channel).some((design) => design.id === id)) return;
    const epoch = ++this.epoch;
    this.update({ reading: true, preview: null, previewNodeKey: null, nodeError: null, error: "" });
    try {
      const result = await this.options.client.detail(id);
      if (!this.current(epoch)) return;
      const receipt = requireWorkflowDesign(result.data, result.etag, id, channel);
      if (this.options.applySelection(nodeKey, receipt))
        this.update({ preview: receipt, previewNodeKey: nodeKey });
    } catch (error) {
      if (this.current(epoch)) this.fail(error, nodeKey, id);
    } finally {
      if (this.current(epoch)) this.update({ reading: false });
    }
  }
}
