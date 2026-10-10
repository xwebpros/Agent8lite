import { readMessageDesignResponse } from "./message-design-protocol";

/** A transport timeout leaves mutations unknown; it never authorizes a new command key. */
export async function requestMessageDesign(path: string, expectedStatus: number, options: RequestInit = {}) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20000);
  try {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: abort.signal,
    });
    const data = await readMessageDesignResponse(response);
    if (response.status !== expectedStatus)
      throw new Error("The frozen message response status could not be verified.");
    return { data, etag: response.headers.get("ETag") || "" };
  } finally {
    clearTimeout(timeout);
  }
}
