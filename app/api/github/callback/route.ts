import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { asUser } from "@/app/lib/convexServer";
import { sessionToken } from "@/app/lib/session";
import {
  RETURN_COOKIE,
  STATE_COOKIE,
  exchangeCode,
  oauthConfig,
  safeReturn,
  type FailureReason,
} from "../oauth";

/**
 * Where GitHub sends the browser back.
 *
 * In Next rather than a Convex HTTP action for the reason the Notion callback
 * is: the Clerk session cookie is on this origin, so the callback knows which
 * Nootles account is connecting without trusting anything GitHub round-tripped.
 * The token is handed straight to Convex to be checked and sealed, and is never
 * written anywhere here.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;
  const returnTo = safeReturn(readCookie(req, RETURN_COOKIE));
  const done = (query: Record<string, string>) => {
    const target = new URL(returnTo, url.origin);
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    const res = NextResponse.redirect(target);
    res.cookies.delete(STATE_COOKIE);
    res.cookies.delete(RETURN_COOKIE);
    return res;
  };
  const failed = (reason: FailureReason) => done({ github: "error", reason });

  // Cancel on GitHub's consent screen: nothing broke, but say something.
  if (params.get("error")) return done({ github: "cancelled" });

  const token = await sessionToken();
  if (!token) return new Response("Unauthorized", { status: 401 });

  const config = oauthConfig();
  if (!config) return failed("unconfigured");

  // The state cookie is the whole CSRF defence: without it, anyone could walk a
  // signed-in user onto this URL carrying their own authorization code and
  // attach their GitHub account to somebody else's.
  const expected = readCookie(req, STATE_COOKIE);
  const state = params.get("state");
  if (!expected || !state || state !== expected) return failed("state");

  const code = params.get("code");
  if (!code) return failed("no_code");

  try {
    const granted = await exchangeCode(config, code);
    await asUser(token).action(api.github.account.connect, { token: granted });
    return done({ github: "connected" });
  } catch {
    // Not forwarded: the message can carry the client secret's rejection detail.
    return failed("exchange");
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
