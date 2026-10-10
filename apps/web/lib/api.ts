import type { components } from "../../../packages/contracts/generated/api";

export type Schema<Name extends keyof components["schemas"]> = components["schemas"][Name];
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<{ data: T; headers: Headers }> {
  const response = await fetch(`/api${path}`, { ...options, credentials: "same-origin", cache: "no-store" });
  const data = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    const problem = data as Partial<Schema<"Problem">>;
    throw new ApiError(
      response.status,
      problem.detail || problem.title || "The request could not be completed.",
      problem.code,
    );
  }
  return { data: data as T, headers: response.headers };
}
