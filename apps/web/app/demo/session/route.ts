import { NextRequest, NextResponse } from "next/server";
import {
  createPreviewLimiter,
  createPreviewSession,
  demoCookie,
  demoLifetimeSeconds,
  demoSettings,
  previewOriginAllowed,
  previewPasswordMatches,
  readPreviewForm,
} from "../../../lib/hosted-demo-access";

export const dynamic = "force-dynamic";
const allowAttempt = createPreviewLimiter();
export async function POST(request: NextRequest) {
  const settings = demoSettings();
  const headers = { "Cache-Control": "private, no-store" };
  if (!settings) return NextResponse.json({ code: "preview_disabled" }, { status: 404, headers });
  if (!previewOriginAllowed(request, settings))
    return NextResponse.json({ code: "preview_origin_denied" }, { status: 403, headers });
  if (!allowAttempt())
    return NextResponse.json(
      { code: "preview_rate_limited" },
      { status: 429, headers: { ...headers, "Retry-After": "60" } },
    );
  let password: string;
  try {
    password = await readPreviewForm(request, "password");
  } catch {
    return NextResponse.json({ code: "preview_form_invalid" }, { status: 400, headers });
  }
  if (!previewPasswordMatches(password, settings))
    return NextResponse.redirect(new URL("/demo?error=access", settings.origin), { status: 303, headers });
  const response = NextResponse.redirect(new URL("/demo", settings.origin), { status: 303, headers });
  response.cookies.set(demoCookie, createPreviewSession(settings), {
    httpOnly: true,
    secure: settings.secure,
    sameSite: "strict",
    path: "/demo",
    maxAge: demoLifetimeSeconds,
  });
  return response;
}
