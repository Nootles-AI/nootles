import { NextResponse } from "next/server";
import { sessionToken } from "@/app/lib/session";
import {
  RETURN_COOKIE,
  STATE_COOKIE,
  STATE_MAX_AGE,
  authorizeUrl,
  oauthConfig,
  safeReturn,
} from "../oauth";

/**
 * Send the user to Notion's consent screen.
 *
 * A GET rather than a POST because it ends in a top-level navigation, and the
 * `state` cookie has to survive Notion redirecting the browser back — which is
 * what `sameSite: "lax"` buys and `strict` would break.
 */
export async function GET(req: Request) {
  const token = await sessionToken();
  if (!token) return new Response("Unauthorized", { status: 401 });

  const config = oauthConfig();
  if (!config) {
    return new Response(
      "Notion is not configured on this deployment. Set NOTION_CLIENT_ID, " +
        "NOTION_CLIENT_SECRET and NOTION_REDIRECT_URI.",
      { status: 503 },
    );
  }

  const state = crypto.randomUUID();
  const returnTo = safeReturn(new URL(req.url).searchParams.get("returnTo") ?? undefined);

  const res = NextResponse.redirect(authorizeUrl(config, state));
  const cookie = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: STATE_MAX_AGE,
  };
  res.cookies.set(STATE_COOKIE, state, cookie);
  res.cookies.set(RETURN_COOKIE, returnTo, cookie);
  return res;
}
