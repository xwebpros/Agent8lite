import { readWorkflowJsonResponse, type WorkflowDefinition } from "./campaign-workflow-protocol";

/** A timeout aborts transport only; callers keep an immutable mutation command as unknown. */
export async function requestWorkflowJson(
  path: string,
  expected: number,
  options: RequestInit = {},
  definition?: WorkflowDefinition,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const data = await readWorkflowJsonResponse(response, definition);
    if (response.status !== expected)
      throw new Error("The frozen workflow response status could not be verified.");
    return { data, etag: response.headers.get("ETag") ?? "" };
  } finally {
    clearTimeout(timer);
  }
}
