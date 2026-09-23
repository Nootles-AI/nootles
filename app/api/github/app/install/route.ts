import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { asUser } from "@/app/lib/convexServer";
import { session } from "@/app/lib/session";
import { safeReturn } from "../../oauth";
import { INSTALL_COOKIE, INSTALL_MAX_AGE, appSlug, installUrl, sealBinding } from "../flow";

/**
 * Send a workspace admin to GitHub to install the App:
 * `/api/github/app/install?workspace=<id>`. Only an admin of that workspace
 * gets past here — and `github/app.install` asks again when it records.
 */
export async function GET(req: Request) {
  const caller = await session();
  if (!caller?.userId) return new Response("Unauthorized", { status: 401 });

  const slug = appSlug();
  if (!slug) {
    return new Response(
      "The GitHub App is not set up on this deployment. Set GITHUB_APP_SLUG.",
      { status: 503 },
    );
  }

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
  if (!status.ready) return new Response(status.blocker, { status: 503 });

  const state = crypto.randomUUID();
  const returnTo = safeReturn(
    url.searchParams.get("returnTo") ?? `/w/${status.slug}/settings/integrations`,
  );
  const res = NextResponse.redirect(installUrl(slug, state));
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
