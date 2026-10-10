import { NextRequest, NextResponse } from "next/server";
import {
  demoCookie,
  demoSettings,
  previewOriginAllowed,
  readPreviewForm,
  verifyPreviewCsrf,
  verifyPreviewSession,
} from "../../../lib/hosted-demo-access";

export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const settings = demoSettings();
  const token = request.cookies.getAll(demoCookie);
  const headers = { "Cache-Control": "private, no-store" };
  if (!settings) return NextResponse.json({ code: "preview_disabled" }, { status: 404, headers });
  if (
    !previewOriginAllowed(request, settings) ||
    token.length !== 1 ||
    !verifyPreviewSession(token[0].value, settings)
  )
    return NextResponse.json({ code: "preview_access_denied" }, { status: 403, headers });
  let csrf: string;
  try {
    csrf = await readPreviewForm(request, "csrf");
  } catch {
    return NextResponse.json({ code: "preview_form_invalid" }, { status: 400, headers });
  }
  if (!verifyPreviewCsrf(csrf, token[0].value, settings))
    return NextResponse.json({ code: "preview_csrf_denied" }, { status: 403, headers });
  const response = NextResponse.redirect(new URL("/demo", settings.origin), { status: 303, headers });
  response.cookies.set(demoCookie, "", {
    httpOnly: true,
    secure: settings.secure,
    sameSite: "strict",
    path: "/demo",
    maxAge: 0,
  });
  return response;
}
