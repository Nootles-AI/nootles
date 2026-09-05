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
} from "../oauth";

/**
 * Where Notion sends the browser back.
 *
 * This lives in Next rather than in a Convex HTTP action for one reason: the
 * Clerk session cookie is on this origin, so the callback knows which Nootles
 * account is connecting without trusting anything Notion round-tripped. The
 * token it receives is handed straight to Convex to be sealed and is never
 * written anywhere here.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;
  const returnTo = safeReturn(req.headers.get("cookie") ? readCookie(req, RETURN_COOKIE) : undefined);
  const done = (query: Record<string, string>) => {
    const target = new URL(returnTo, url.origin);
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    const res = NextResponse.redirect(target);
    res.cookies.delete(STATE_COOKIE);
    res.cookies.delete(RETURN_COOKIE);
    return res;
  };

  // The user pressed Cancel on Notion's consent screen. Not an error worth a
  // stack trace, but the UI should say something rather than silently return.
  const denied = params.get("error");
  if (denied) return done({ notion: "cancelled" });

  const token = await sessionToken();
  if (!token) return new Response("Unauthorized", { status: 401 });

  const config = oauthConfig();
  if (!config) return done({ notion: "error", reason: "unconfigured" });

  // The state cookie is the whole CSRF defence: without it, anyone could walk a
  // signed-in user onto this URL carrying their own authorization code and
  // attach their Notion workspace to somebody else's account.
  const expected = readCookie(req, STATE_COOKIE);
  const state = params.get("state");
  if (!expected || !state || state !== expected) {
    return done({ notion: "error", reason: "state" });
  }

  const code = params.get("code");
  if (!code) return done({ notion: "error", reason: "no_code" });

  try {
    const granted = await exchangeCode(config, code);
    await asUser(token).action(api.notion.account.connect, {
      token: granted.access_token,
      workspaceId: granted.workspace_id,
      workspaceName: granted.workspace_name ?? "Notion",
      ...(granted.workspace_icon ? { workspaceIcon: granted.workspace_icon } : {}),
    });
    return done({ notion: "connected" });
  } catch {
    // The message is not forwarded: it can carry the client secret's rejection
    // detail, and the useful half is already a sentence the UI can write.
    return done({ notion: "error", reason: "exchange" });
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
