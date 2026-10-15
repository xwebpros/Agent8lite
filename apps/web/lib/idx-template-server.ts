import type { components } from "../../../packages/contracts/generated/api";
import { idxTemplateOrigins, signIdxTemplateRequest } from "../../../packages/auth/idx-template-bridge";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function idxTemplateWebOrigin(host: string | null): string {
  const allowed = idxTemplateOrigins();
  const matches = [...allowed].filter((origin) => new URL(origin).host === host);
  if (matches.length !== 1) throw new Error("The public template host is unavailable.");
  return matches[0];
}
export async function requestIdxTemplate(
  siteId: string,
  action: string[],
  origin: string,
  options: { method?: string; query?: string; body?: unknown; key?: string } = {},
) {
  if (
    !uuid.test(siteId) ||
    !action.length ||
    !["content", "status", "listings", "inquiries"].includes(action[0]) ||
    action.length > 2 ||
    (action.length === 2 && action[0] !== "listings") ||
    action.some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f]/.test(part))
  )
    throw new Error("Invalid template route.");
  const api = new URL(process.env.API_ORIGIN ?? "http://127.0.0.1:3001");
  if (
    !["http:", "https:"].includes(api.protocol) ||
    api.username ||
    api.password ||
    api.pathname !== "/" ||
    api.search ||
    api.hash
  )
    throw new Error("Invalid template API origin.");
  if (
    ["development", "test"].includes(process.env.APP_ENV ?? "") &&
    process.env.DEV_AUTH_ENABLED === "true" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)
  )
    throw new Error("Synthetic template API must use loopback.");
  const method = options.method ?? "GET";
  const url = `/v1/public/sites/${siteId}/idx-template/${action.map(encodeURIComponent).join("/")}${options.query ?? ""}`;
  const headers = new Headers(signIdxTemplateRequest(method, url, origin, options.body, options.key));
  headers.set("accept", "application/json");
  headers.set("origin", origin);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.key) headers.set("idempotency-key", options.key);
  return fetch(`${api.origin}${url}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
}
export async function getPublishedIdxTemplateContent(
  siteId: string,
  origin: string,
): Promise<components["schemas"]["IdxTemplateContent"]> {
  const response = await requestIdxTemplate(siteId, ["content"], origin);
  if (!response.ok) throw new Error("The published template is unavailable.");
  return response.json() as Promise<components["schemas"]["IdxTemplateContent"]>;
}
