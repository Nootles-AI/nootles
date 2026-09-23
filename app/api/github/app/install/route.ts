import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { asUser } from "@/app/lib/convexServer";
import { session } from "@/app/lib/session";
import { safeReturn } from "../../oauth";
import { INSTALL_COOKIE, INSTALL_MAX_AGE, installUrl, sealBinding } from "../flow";

/**
 * Send a workspace admin to GitHub to install the App:
 * `/api/github/app/install?workspace=<id>`. Only an admin of that workspace
 * gets past here — and `github/app.install` asks again when it records.
 */
export async function GET(req: Request) {
  const caller = await session();
  if (!caller?.userId) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace");
  if (!workspaceId) return new Response("Name a workspace", { status: 400 });

  const status = await asUser(caller.token)
    .query(api.github.app.status, { workspaceId: workspaceId as Id<"workspaces"> })
    // A malformed id is a workspace nobody has.
    .catch(() => null);
  if (!status) return new Response("Not found", { status: 404 });
  if (!status.canManage) {
    return new Response("Only a workspace admin can install the GitHub App.", { status: 403 });
  }
  if (!status.ready || !status.appSlug) {
    return new Response(
      `The GitHub App isn’t set up on this deployment (missing ${status.missing.join(", ")}). See docs/github-app.md.`,
      { status: 503 },
    );
  }

  const state = crypto.randomUUID();
  const integrations = `/w/${status.slug}/settings/integrations`;
  // A return that would leave the app lands where the outcome is shown instead.
  const asked = safeReturn(url.searchParams.get("returnTo") ?? integrations);
  const returnTo = asked === "/" ? integrations : asked;
  const res = NextResponse.redirect(installUrl(status.appSlug, state));
  res.cookies.set(
    INSTALL_COOKIE,
    sealBinding({ state, workspaceId, userId: caller.userId, returnTo }),
    {
      httpOnly: true,
      // Lax, so the cookie survives GitHub redirecting the browser back.
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: INSTALL_MAX_AGE,
    },
  );
  return res;
}
