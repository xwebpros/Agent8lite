// Server-only preview access. Never imported by the client demo or ordinary identity code.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const demoCookie = "estate_preview";
export const demoLifetimeSeconds = 3600;
type Environment = Record<string, string | undefined>;
export function demoSettings(env: Environment = process.env) {
  if (env.HOSTED_DEMO_ENABLED !== "true") return null;
  const password = env.DEMO_ACCESS_PASSWORD;
  const secret = env.DEMO_SESSION_SECRET;
  if (
    !password ||
    password.length < 16 ||
    password.length > 128 ||
    !secret ||
    secret.length < 32 ||
    secret.length > 256
  )
    return null;
  try {
    const origin = new URL(env.WEB_ORIGIN ?? "");
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== env.WEB_ORIGIN) return null;
    if (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
      return null;
    return { password, secret, origin: origin.origin, secure: origin.protocol === "https:" };
  } catch {
    return null;
  }
}
type Settings = NonNullable<ReturnType<typeof demoSettings>>;
function equal(left: string, right: string) {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}
const signature = (value: string, settings: Settings) =>
  createHmac("sha256", settings.secret).update(value).digest("base64url");
export function previewPasswordMatches(value: string, settings: Settings) {
  return equal(value, settings.password);
}
export function createPreviewSession(settings: Settings, now = Date.now()) {
  const payload = `${now}.${randomBytes(16).toString("hex")}`;
  return `${payload}.${signature(payload, settings)}`;
}
export function verifyPreviewSession(value: string | undefined, settings: Settings, now = Date.now()) {
  if (!value || !/^[1-9][0-9]{0,15}\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const [issued, nonce, tag] = value.split(".");
  const clock = Number(issued);
  return (
    Number.isSafeInteger(clock) &&
    clock <= now &&
    now - clock < demoLifetimeSeconds * 1000 &&
    equal(tag, signature(`${issued}.${nonce}`, settings))
  );
}
export function previewCsrf(value: string, settings: Settings) {
  return signature(`csrf:${value}`, settings);
}
export function verifyPreviewCsrf(value: string | undefined, token: string, settings: Settings) {
  return !!value && value.length === 43 && equal(value, previewCsrf(token, settings));
}
export function previewOriginAllowed(request: Request, settings: Settings) {
  return (
    request.headers.get("origin") === settings.origin &&
    ["same-origin", null].includes(request.headers.get("sec-fetch-site"))
  );
}
export function createPreviewLimiter(clock = Date.now) {
  let attempts = 0;
  let ends = 0;
  return () => {
    const now = clock();
    if (now >= ends) {
      attempts = 0;
      ends = now + 60000;
    }
    return ++attempts <= 10;
  };
}
export async function readPreviewForm(request: Request, field: "password" | "csrf") {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded")
    throw new Error("preview_form_invalid");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("preview_form_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        throw new Error("preview_form_invalid");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  const form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if ([...form.keys()].length !== 1 || !form.has(field)) throw new Error("preview_form_invalid");
  return form.get(field)!;
}
