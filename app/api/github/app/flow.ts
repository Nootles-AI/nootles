import { ConvexError } from "convex/values";
import type { InstallRefusal } from "@/convex/github/app";

/**
 * What the two halves of installing the GitHub App agree on
 * (docs/github-app.md): the install route that sends an admin to GitHub, and
 * the setup route GitHub sends them back to.
 *
 * The state cookie binds the round trip to one Nootles user and one
 * workspace, so a setup URL someone else started — or one GitHub reaches
 * without us, from its own install page — records nothing. It is not the
 * proof that the installation is theirs to attach; `github/app.install`
 * makes that with GitHub itself.
 */

export const INSTALL_COOKIE = "github_app_install";
/** Long enough to choose repositories on GitHub, short enough that a stale one dies. */
export const INSTALL_MAX_AGE = 900;

export type Binding = {
  state: string;
  workspaceId: string;
  userId: string;
  returnTo: string;
};

/**
 * Why an install did not land, as the setup route writes it into `?reason=`:
 * its own checks, then `github/app.install`'s refusals, and `verify` for any
 * other failure.
 */
export type InstallFailure = "state" | "no_code" | "no_installation" | "verify" | InstallRefusal;

const REFUSALS: readonly InstallRefusal[] = ["unconfigured", "unauthorised", "unreachable", "not_owner", "not_holder"];

/** The refusal `github/app.install` threw, or `verify` for anything that isn't one. */
export function failureOf(error: unknown): InstallFailure {
  if (!(error instanceof ConvexError)) return "verify";
  const refused = (error.data as { refused?: unknown } | null)?.refused;
  return REFUSALS.find((r) => r === refused) ?? "verify";
}

export function installUrl(slug: string, state: string): string {
  const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export function sealBinding(binding: Binding): string {
  return Buffer.from(JSON.stringify(binding)).toString("base64url");
}

export function openBinding(value: string | undefined): Binding | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString()) as Partial<Binding>;
    const { state, workspaceId, userId, returnTo } = parsed;
    if (![state, workspaceId, userId, returnTo].every((field) => typeof field === "string")) {
      return null;
    }
    return parsed as Binding;
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
