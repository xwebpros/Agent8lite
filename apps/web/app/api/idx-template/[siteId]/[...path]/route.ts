import type { NextRequest } from "next/server";
import { idxTemplateWebOrigin, requestIdxTemplate } from "../../../../../lib/idx-template-server";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store" };
async function relay(request: NextRequest, context: { params: Promise<{ siteId: string; path: string[] }> }) {
  try {
    const { siteId, path } = await context.params;
    const origin = idxTemplateWebOrigin(request.headers.get("host"));
    if (
      request.method !== "GET" &&
      (request.headers.get("origin") !== origin || path.join("/") !== "inquiries")
    )
      return Response.json({ title: "Same-origin inquiry required" }, { status: 403, headers: noStore });
    let body: unknown;
    if (request.method === "POST") {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 16_384) {
              await reader.cancel();
              return Response.json({ title: "Inquiry is too large" }, { status: 413, headers: noStore });
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return Response.json(
          { title: "A valid JSON inquiry is required" },
          { status: 400, headers: noStore },
        );
      }
    }
    const response = await requestIdxTemplate(siteId, path, origin, {
      method: request.method,
      query: request.nextUrl.search,
      body,
      key: request.headers.get("idempotency-key") ?? "",
    });
    return new Response(response.body, {
      status: response.status,
      headers: { ...noStore, "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return Response.json(
      { title: "The template service is unavailable. Your inquiry may require reconciliation." },
      { status: 503, headers: noStore },
    );
  }
}
export const GET = relay;
export const POST = relay;
