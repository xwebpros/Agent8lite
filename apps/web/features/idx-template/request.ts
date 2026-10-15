"use client";
export class TemplateApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function templateRequest<T>(siteId: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/idx-template/${encodeURIComponent(siteId)}/${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new TemplateApiError(response.status, body?.detail || "This operation could not be completed.");
  return body as T;
}
