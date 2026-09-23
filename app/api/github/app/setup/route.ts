import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { asUser } from "@/app/lib/convexServer";
import { session } from "@/app/lib/session";
import { safeReturn } from "../../oauth";
import { INSTALL_COOKIE, openBinding, readCookie, type InstallFailure } from "../flow";

/**
 * The App's setup URL, where GitHub sends the browser after an install.
 *
 * GitHub's `installation_id` here is only a claim. The state cookie proves
 * this is the round trip this user started for this workspace; the `code`
 * (from "request user authorization during installation") is what
 * `github/app.install` trades with GitHub to prove the user can reach the
 * installation before it is recorded.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;
  const bound = openBinding(readCookie(req, INSTALL_COOKIE));
  const done = (query: Record<string, string>) => {
    const target = new URL(safeReturn(bound?.returnTo), url.origin);
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    const res = NextResponse.redirect(target);
    res.cookies.delete(INSTALL_COOKIE);
    return res;
  };
  const failed = (reason: InstallFailure) => done({ github: "error", reason });

  const caller = await session();
  if (!caller) return new Response("Unauthorized", { status: 401 });
  if (!bound || bound.userId !== caller.userId || params.get("state") !== bound.state) {
    return failed("state");
  }

  // An organisation member without the right to install asked its owners to;
  // nothing is installed until one of them approves.
  if (params.get("setup_action") === "request") return done({ github: "requested" });

  const installationId = Number(params.get("installation_id"));
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return failed("no_installation");
  }
  const code = params.get("code");
  if (!code) return failed("no_code");

  try {
    await asUser(caller.token).action(api.github.app.install, {
      workspaceId: bound.workspaceId as Id<"workspaces">,
      installationId,
      code,
    });
    return done({ github: "installed" });
  } catch {
    return failed("verify");
  }
}
