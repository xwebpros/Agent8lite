import type { WorkflowDefinition, WorkflowIssue, WorkflowNode } from "./types";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const keyPattern = /^[a-z][a-z0-9_]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kinds = ["wait", "email", "sms", "condition", "task"] as const;
const conditionFields = ["stageId", "ownerMemberId", "sourceId", "tagIds", "q", "intent"];
const kindFields: Record<WorkflowNode["kind"], readonly string[]> = {
  wait: ["delaySeconds"],
  email: ["messageDesignId"],
  sms: ["messageDesignId"],
  condition: ["condition"],
  task: ["taskTitle"],
};
const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max * 2 && [...value].length <= max;
const nodeKey = (value: unknown): value is string => typeof value === "string" && keyPattern.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && uuidPattern.test(value);

function timezone(value: unknown): boolean {
  // Offset strings and abbreviation-only choices are not IANA zone identities.
  if (!boundedString(value, 80) || !/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Browser-safe semantic checks over generated v1 aliases. The API also validates
 * the authoritative frozen JSON schema; this module imports no server/runtime.
 */
export function validateWorkflowDefinition(input: WorkflowDefinition): readonly WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  const finish = () => Object.freeze(issues.map((issue) => Object.freeze(issue)));
  if (!record(input)) {
    add("definition", "A workflow definition object is required.");
    return finish();
  }
  if (Object.keys(input).some((key) => !["nodes", "edges", "timezone", "quietHours"].includes(key)))
    add("definition", "Unexpected workflow properties are not allowed.");
  if (!timezone(input.timezone)) add("timezone", "A valid IANA timezone or UTC is required.");
  if (own(input, "quietHours")) {
    const quiet = input.quietHours;
    if (!record(quiet)) add("quietHours", "Quiet hours require start and end times.");
    else {
      if (Object.keys(quiet).some((key) => !["start", "end"].includes(key)))
        add("quietHours", "Unexpected quiet-hour properties are not allowed.");
      for (const part of ["start", "end"] as const)
        if (typeof quiet[part] !== "string" || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(quiet[part]))
          add(`quietHours.${part}`, "Use a 24-hour HH:mm time.");
      if (typeof quiet.start === "string" && quiet.start === quiet.end)
        add("quietHours", "Quiet-hour start and end must differ.");
    }
  }
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 100)
    add("nodes", "A workflow must contain between 1 and 100 nodes.");
  if (!Array.isArray(input.edges) || input.edges.length > 200)
    add("edges", "A workflow must contain an edge array with at most 200 edges.");
  // Do not traverse unbounded malformed input even when a caller bypasses typing.
  if (
    !Array.isArray(input.nodes) ||
    !Array.isArray(input.edges) ||
    input.nodes.length < 1 ||
    input.nodes.length > 100 ||
    input.edges.length > 200
  )
    return finish();

  const nodes = new Map<string, { index: number; kind: WorkflowNode["kind"] }>();
  input.nodes.forEach((raw, index) => {
    const path = `nodes.${index}`;
    if (!record(raw)) return void add(path, "A workflow node object is required.");
    if (!nodeKey(raw.key)) add(`${path}.key`, "Use a lowercase workflow key with at most 64 characters.");
    const kind = raw.kind;
    if (typeof kind !== "string" || !kinds.includes(kind as WorkflowNode["kind"])) {
      add(`${path}.kind`, "Use a supported workflow node kind.");
      return;
    }
    const allowed = ["key", "kind", ...kindFields[kind as WorkflowNode["kind"]]];
    if (Object.keys(raw).some((key) => !allowed.includes(key)))
      add(path, "Only properties appropriate for this node kind are allowed.");
    if (nodeKey(raw.key)) {
      if (nodes.has(raw.key)) add(`${path}.key`, "Workflow node keys must be unique.");
      else nodes.set(raw.key, { index, kind: kind as WorkflowNode["kind"] });
    }
    if (kind === "wait") {
      if (
        !Number.isInteger(raw.delaySeconds) ||
        Number(raw.delaySeconds) < 0 ||
        Number(raw.delaySeconds) > 31536000
      )
        add(`${path}.delaySeconds`, "Wait delay must be an integer between 0 and 31536000 seconds.");
    } else if (kind === "email" || kind === "sms") {
      if (!uuid(raw.messageDesignId))
        add(`${path}.messageDesignId`, "A valid message design UUID is required.");
    } else if (kind === "task") {
      if (!boundedString(raw.taskTitle, 200) || !raw.taskTitle.trim())
        add(`${path}.taskTitle`, "A nonblank task title with at most 200 characters is required.");
    } else {
      const filter = raw.condition;
      const filterPath = `${path}.condition`;
      if (!record(filter)) return void add(filterPath, "A lead-filter condition is required.");
      if (Object.keys(filter).some((key) => !conditionFields.includes(key)))
        add(filterPath, "Conditions accept only the v1 lead-filter fields.");
      if (!conditionFields.some((key) => own(filter, key)))
        add(filterPath, "A condition must contain at least one lead-filter predicate.");
      for (const field of ["stageId", "ownerMemberId", "sourceId"] as const)
        if (own(filter, field) && !uuid(filter[field]))
          add(`${filterPath}.${field}`, "A valid UUID is required.");
      if (own(filter, "tagIds")) {
        const tags = filter.tagIds;
        if (!Array.isArray(tags) || tags.length < 1 || tags.length > 20 || !tags.every(uuid))
          add(`${filterPath}.tagIds`, "Use between 1 and 20 valid tag UUIDs.");
        else if (new Set(tags.map((tag) => tag.toLowerCase())).size !== tags.length)
          add(`${filterPath}.tagIds`, "Condition tag UUIDs must be unique.");
      }
      if (own(filter, "q") && (!boundedString(filter.q, 200) || !filter.q.trim()))
        add(`${filterPath}.q`, "Search text must be nonblank and at most 200 characters.");
      if (
        own(filter, "intent") &&
        (typeof filter.intent !== "string" || !["buyer", "seller", "both", "unknown"].includes(filter.intent))
      )
        add(`${filterPath}.intent`, "Use a supported lead intent.");
    }
  });

  const outgoing = new Map<string, { to: string; branch: string; index: number }[]>();
  const incoming = new Map([...nodes.keys()].map((key) => [key, 0]));
  const edges = new Set<string>();
  input.edges.forEach((edge, index) => {
    const path = `edges.${index}`;
    if (!record(edge)) return void add(path, "A workflow edge object is required.");
    if (Object.keys(edge).some((key) => !["from", "to", "branch"].includes(key)))
      add(path, "Unexpected edge properties are not allowed.");
    const from = edge.from;
    const to = edge.to;
    if (!nodeKey(from) || !nodes.has(from)) add(`${path}.from`, "Edge source must name an existing node.");
    if (!nodeKey(to) || !nodes.has(to)) add(`${path}.to`, "Edge destination must name an existing node.");
    if (typeof edge.branch !== "string" || !["always", "true", "false"].includes(edge.branch)) {
      add(`${path}.branch`, "Use an always, true or false branch.");
      return;
    }
    if (!nodeKey(from) || !nodeKey(to) || !nodes.has(from) || !nodes.has(to)) return;
    const identity = `${from}/${to}/${edge.branch}`;
    if (edges.has(identity)) add(path, "Duplicate workflow edges are not allowed.");
    edges.add(identity);
    const next = outgoing.get(from) ?? [];
    next.push({ to, branch: String(edge.branch), index });
    outgoing.set(from, next);
    incoming.set(to, incoming.get(to)! + 1);
  });
  for (const [key, node] of nodes) {
    const next = outgoing.get(key) ?? [];
    if (node.kind === "condition") {
      if (
        next.length !== 2 ||
        next.filter((edge) => edge.branch === "true").length !== 1 ||
        next.filter((edge) => edge.branch === "false").length !== 1 ||
        next[0].to === next[1].to
      )
        add(`nodes.${node.index}`, "A condition needs distinct true and false destinations.");
    } else {
      if (next.length > 1) add(`nodes.${node.index}`, "A non-condition node may have at most one successor.");
      for (const edge of next)
        if (edge.branch !== "always")
          add(`edges.${edge.index}.branch`, "Only conditions may have true or false branches.");
    }
  }
  const entries = [...nodes.keys()].filter((key) => incoming.get(key) === 0);
  if (entries.length !== 1) add("nodes", "A workflow must have exactly one entry node.");
  const visited = new Set<string>();
  const active = new Set<string>();
  let cycle = false;
  const visit = (key: string) => {
    if (active.has(key)) {
      cycle = true;
      return;
    }
    if (visited.has(key)) return;
    visited.add(key);
    active.add(key);
    for (const edge of outgoing.get(key) ?? []) visit(edge.to);
    active.delete(key);
  };
  if (entries.length === 1) {
    visit(entries[0]);
    for (const [key, node] of nodes)
      if (!visited.has(key)) add(`nodes.${node.index}`, "Every node must be reachable from the entry.");
  }
  for (const key of nodes.keys()) visit(key);
  if (cycle) add("edges", "Workflow cycles are not allowed.");
  return finish();
}
