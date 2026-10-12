import { createHmac } from "node:crypto";

export function generateUnsubscribeToken(
  signingKey: string,
  tenantId: string,
  email: string,
  purpose: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({ t: tenantId, e: email.toLowerCase(), p: purpose }),
  ).toString("base64url");
  const signature = createHmac("sha256", signingKey)
    .update(`unsubscribe:${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}
