import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

export type ConditionChoice = Readonly<{ id: string; label: string }>;
export type ConditionCatalogueKind = "stages" | "sources" | "tags";
export type WorkflowConditionCatalogueState = Readonly<{
  online: boolean;
  reading: boolean;
  phase: "unread" | "ready" | "denied";
  stages: readonly ConditionChoice[] | null;
  sources: readonly ConditionChoice[] | null;
  tags: readonly ConditionChoice[] | null;
  tagCursor: string | null;
  error: string;
}>;
export interface WorkflowConditionCatalogueClient {
  stages(): Promise<unknown>;
  sources(): Promise<unknown>;
  tags(cursor?: string | null): Promise<unknown>;
}
export const conditionTagLimit = 200;

const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:workflow-condition-catalogue",
  components: {
    schemas: {
      PipelineStage: contract.components.schemas.PipelineStage,
      PagePipelineStage: contract.components.schemas.PagePipelineStage,
      LeadSource: contract.components.schemas.LeadSource,
      PageLeadSource: contract.components.schemas.PageLeadSource,
      Tag: contract.components.schemas.Tag,
      PageTag: contract.components.schemas.PageTag,
    },
  },
});
const page = <T>(name: string) =>
  ajv.compile<T>({ $ref: `estate:workflow-condition-catalogue#/components/schemas/${name}` });
const validateStages = page<Schema<"PagePipelineStage">>("PagePipelineStage");
const validateSources = page<Schema<"PageLeadSource">>("PageLeadSource");
const validateTags = page<Schema<"PageTag">>("PageTag");

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function cursorShape(value: { hasMore: boolean; nextCursor: string | null; items: readonly unknown[] }) {
  return value.hasMore ? Boolean(value.nextCursor) && value.items.length > 0 : value.nextCursor === null;
}
function unique(choices: readonly ConditionChoice[]): readonly ConditionChoice[] {
  const ids = new Set<string>();
  for (const choice of choices) {
    const id = choice.id.toLowerCase();
    if (ids.has(id)) throw new Error("A condition reference catalogue repeated an identity.");
    ids.add(id);
  }
  return choices;
}
export function requireStageChoices(value: unknown): readonly ConditionChoice[] {
  if (!validateStages(value) || !cursorShape(value))
    throw new Error("Pipeline stage choices could not be verified.");
  return unique(
    [...value.items]
      .sort((left, right) => left.position - right.position)
      .map((stage) => ({ id: stage.id, label: stage.name })),
  );
}
export function requireSourceChoices(value: unknown): readonly ConditionChoice[] {
  if (!validateSources(value) || !cursorShape(value))
    throw new Error("Lead source choices could not be verified.");
  return unique(value.items.map((source) => ({ id: source.id, label: source.label })));
}
export function requireTagPage(
  value: unknown,
): Readonly<{ choices: readonly ConditionChoice[]; next: string | null }> {
  if (!validateTags(value) || !cursorShape(value)) throw new Error("Tag choices could not be verified.");
  return {
    choices: unique(value.items.map((tag) => ({ id: tag.id, label: tag.name }))),
    next: value.hasMore ? value.nextCursor : null,
  };
}

/**
 * Private, bounded reference choices for condition predicates. Choices only help a person pick
 * references; the server rechecks every saved reference. Nothing here is persisted.
 */
export class WorkflowConditionCatalogue {
  private state: WorkflowConditionCatalogueState;
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private detached = false;
  private revoked = false;
  constructor(
    private readonly options: {
      online: boolean;
      client: WorkflowConditionCatalogueClient;
      permitted: Readonly<Record<ConditionCatalogueKind, boolean>>;
      isCurrent(): boolean;
      onAuthorityLost?(error: ApiError): void;
    },
  ) {
    this.state = freeze({
      online: options.online,
      reading: false,
      phase: "unread",
      stages: null,
      sources: null,
      tags: null,
      tagCursor: null,
      error: "",
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<WorkflowConditionCatalogueState>) {
    this.state = freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  private available() {
    return !this.detached && !this.revoked && this.state.online && this.options.isCurrent();
  }
  invalidate() {
    ++this.epoch;
    this.update({
      reading: false,
      phase: this.revoked ? "denied" : "unread",
      stages: null,
      sources: null,
      tags: null,
      tagCursor: null,
      error: "",
    });
  }
  attach() {
    if (!this.revoked) this.detached = false;
  }
  detach() {
    this.detached = true;
    this.invalidate();
  }
  setOnline(online: boolean) {
    if (online === this.state.online) return;
    if (!online) this.invalidate();
    this.update({ online });
  }
  /** 401 ends workflow access; 403 only makes that one list unavailable. */
  private authority(error: unknown): boolean {
    if (error instanceof ApiError && error.status === 401) {
      this.revoked = true;
      this.invalidate();
      this.options.onAuthorityLost?.(error);
      return true;
    }
    return false;
  }
  async load(): Promise<void> {
    if (!this.available() || this.state.reading || this.state.phase === "ready") return;
    const epoch = ++this.epoch;
    const { client, permitted } = this.options;
    this.update({ reading: true, error: "" });
    const [stages, sources, tags] = await Promise.allSettled([
      permitted.stages ? client.stages().then(requireStageChoices) : Promise.resolve(null),
      permitted.sources ? client.sources().then(requireSourceChoices) : Promise.resolve(null),
      permitted.tags ? client.tags(null).then(requireTagPage) : Promise.resolve(null),
    ]);
    if (epoch !== this.epoch || !this.available()) return;
    for (const result of [stages, sources, tags])
      if (result.status === "rejected" && this.authority(result.reason)) return;
    const value = <T>(result: PromiseSettledResult<T>) =>
      result.status === "fulfilled" ? result.value : null;
    const failed = [stages, sources, tags].some((result) => result.status === "rejected");
    const tagPage = value(tags);
    this.update({
      reading: false,
      phase: "ready",
      stages: value(stages),
      sources: value(sources),
      tags: tagPage?.choices ?? null,
      tagCursor: tagPage?.next ?? null,
      error: failed
        ? "Some condition choices could not be verified. Saved references stay unchanged; try again while online."
        : "",
    });
  }
  async loadMoreTags(): Promise<void> {
    const cursor = this.state.tagCursor;
    if (!this.available() || this.state.reading || !cursor || !this.state.tags) return;
    if (this.state.tags.length >= conditionTagLimit) return;
    const epoch = ++this.epoch;
    this.update({ reading: true, error: "" });
    try {
      const next = requireTagPage(await this.options.client.tags(cursor));
      if (epoch !== this.epoch || !this.available() || this.state.tagCursor !== cursor) return;
      const combined = unique([...this.state.tags!, ...next.choices]).slice(0, conditionTagLimit);
      this.update({
        reading: false,
        tags: combined,
        tagCursor: combined.length >= conditionTagLimit ? null : next.next,
      });
    } catch (error) {
      if (epoch !== this.epoch || !this.available()) return;
      if (this.authority(error)) return;
      this.update({
        reading: false,
        error: "More tag choices could not be verified. Earlier choices remain.",
      });
    }
  }
}
