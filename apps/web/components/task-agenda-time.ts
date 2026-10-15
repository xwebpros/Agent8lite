import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import type { Schema } from "../lib/api";

type Task = Schema<"Task">;
export const taskAgendaVisibleLimit = 5;
export const taskAgendaInputLimit = 500;
const memoryLimit = 4 * 1024 * 1024;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
const validTask = ajv.compile<Task>(contract.components.schemas.Task);
const validInstant = ajv.compile({ type: "string", format: "date-time" });
const validTiming = ajv.compile<Pick<Schema<"TaskWrite">, "dueAt" | "timezone">>({
  type: "object",
  additionalProperties: false,
  required: ["dueAt", "timezone"],
  properties: {
    dueAt: contract.components.schemas.TaskWrite.properties.dueAt,
    timezone: contract.components.schemas.TaskWrite.properties.timezone,
  },
});

/** Copy descriptors into a detached JSON tree without executing hooks or coercions. */
export function taskAgendaSnapshot<T>(input: T): T {
  let nodes = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 20000 || depth > 12) throw new Error();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value)) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype)
      throw new Error();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > 501 ||
      (array && (value.length > taskAgendaInputLimit || keys.length !== value.length + 1))
    )
      throw new Error();
    const result = array ? Object.setPrototypeOf(new Array(value.length), null) : Object.create(null);
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        key === "toJSON" ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
      )
        throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(value);
    return result;
  };
  try {
    const json = JSON.stringify(copy(input, 0));
    if (!json || new TextEncoder().encode(json).byteLength > memoryLimit) throw new Error();
    const detached = JSON.parse(json, (_key, value: unknown) => {
      if (value && typeof value === "object" && !Array.isArray(value)) Object.setPrototypeOf(value, null);
      return value;
    }) as T;
    const freeze = (value: unknown) => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(detached);
    return detached;
  } catch {
    throw new Error("Loaded task data could not be verified within its private memory limits.");
  }
}

export function validTaskAgendaTimezone(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)
  )
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function instant(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return null;
  // Calendar validity comes from the frozen date-time schema, not Date's rollover behavior.
  if (!validInstant(value)) return null;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

/** Unchanged wall input retains the original instant; only explicit edits invoke device resolution. */
export function resolveTaskDrawerTiming(
  original: Pick<Schema<"Task">, "dueAt" | "timezone">,
  baseline: unknown,
  entered: unknown,
  resolveChanged: (value: string) => unknown,
): Readonly<Pick<Schema<"TaskWrite">, "dueAt" | "timezone">> {
  try {
    const timing = taskAgendaSnapshot(original);
    const validWall = (value: unknown): value is string =>
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value) &&
      instant(`${value.length === 16 ? `${value}:00` : value}Z`) !== null;
    if (
      !validTiming(timing) ||
      instant(timing.dueAt) === null ||
      !validTaskAgendaTimezone(timing.timezone) ||
      !validWall(baseline) ||
      !validWall(entered)
    )
      throw new Error();
    if (entered === baseline) return timing;
    const changed = taskAgendaSnapshot(resolveChanged(entered));
    if (
      !validTiming(changed) ||
      instant(changed.dueAt) === null ||
      !validTaskAgendaTimezone(changed.timezone)
    )
      throw new Error();
    return changed;
  } catch {
    throw new Error("Task timing could not be verified.");
  }
}

export function formatTaskAgendaInstant(value: unknown, timezone: unknown): string | null {
  const epoch = instant(value);
  if (epoch === null || !validTaskAgendaTimezone(timezone)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "shortOffset",
    }).format(epoch);
  } catch {
    return null;
  }
}

export function requireTaskAgendaTask(value: unknown): Task {
  const task = taskAgendaSnapshot(value);
  if (
    !validTask(task) ||
    !Number.isSafeInteger(task.version) ||
    !task.title.trim() ||
    /[\u0000-\u001F\u007F]/.test(task.title) ||
    instant(task.dueAt) === null ||
    !validTaskAgendaTimezone(task.timezone)
  )
    throw new Error("Loaded task timing metadata is unavailable.");
  return task;
}

function day(epoch: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(epoch);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = get("year"),
    month = get("month"),
    date = get("day");
  if (!year || !month || !date) throw new Error();
  return `${year.padStart(4, "0")}-${month}-${date}`;
}

export type TaskAgendaPartition =
  | Readonly<{
      state: "ready";
      capturedAt: string;
      userDay: string;
      userTimezone: string;
      groups: Readonly<{ overdue: readonly Task[]; today: readonly Task[]; upcoming: readonly Task[] }>;
    }>
  | Readonly<{
      state: "unavailable";
      code: "task_agenda_metadata_unavailable" | "task_agenda_time_unavailable";
    }>;

export function partitionLoadedTasks(
  tasks: readonly Task[],
  capturedNow: unknown,
  userTimezone: unknown,
): TaskAgendaPartition {
  const now = instant(capturedNow);
  if (
    now === null ||
    typeof capturedNow !== "string" ||
    !capturedNow.endsWith("Z") ||
    !validTaskAgendaTimezone(userTimezone)
  )
    return { state: "unavailable", code: "task_agenda_time_unavailable" };
  try {
    const detached = taskAgendaSnapshot(tasks);
    if (!Array.isArray(detached) || detached.length > taskAgendaInputLimit) throw new Error();
    const ids = new Set<string>();
    for (const task of detached) {
      requireTaskAgendaTask(task);
      if (ids.has(task.id.toLowerCase())) throw new Error();
      ids.add(task.id.toLowerCase());
    }
    const userDay = day(now, userTimezone);
    const groups: { overdue: Task[]; today: Task[]; upcoming: Task[] } = {
      overdue: [],
      today: [],
      upcoming: [],
    };
    for (const task of detached) {
      if (task.state !== "open") continue;
      const due = instant(task.dueAt) as number;
      if (due < now) groups.overdue.push(task);
      else if (day(due, userTimezone) === userDay) groups.today.push(task);
      else groups.upcoming.push(task);
    }
    for (const group of Object.values(groups)) {
      group.sort(
        (a, b) => (instant(a.dueAt) as number) - (instant(b.dueAt) as number) || a.id.localeCompare(b.id),
      );
      Object.freeze(group);
    }
    return Object.freeze({
      state: "ready",
      capturedAt: new Date(now).toISOString(),
      userDay,
      userTimezone,
      groups: Object.freeze(groups),
    });
  } catch {
    return { state: "unavailable", code: "task_agenda_metadata_unavailable" };
  }
}
