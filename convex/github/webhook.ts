import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

/**
 * GitHub's webhook for the App, as `convex/http.ts` serves it at
 * `/github/webhook`: the signature check, then what each event changes.
 * Events it has no use for are acknowledged and dropped, so GitHub does not
 * retry them.
 */

/**
 * Whether `header` (`X-Hub-Signature-256`) is the HMAC-SHA256 of the exact
 * bytes GitHub sent, under the App's webhook secret. Compared in constant
 * time, so the answer's timing says nothing about how close a guess was.
 */
export async function signatureValid(
  secret: string,
  body: ArrayBuffer,
  header: string | null,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  const expected = Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return constantTimeEqual(expected, header.slice("sha256=".length).toLowerCase());
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Payload = {
  action?: string;
  installation?: { id?: number; repository_selection?: string };
  repository?: { full_name?: string };
  ref?: string;
  repositories_removed?: { full_name?: string }[];
  organization?: { login?: string };
  membership?: { user?: { login?: string } };
};

const BRANCH = "refs/heads/";

/** Applies one delivery. Every handler is idempotent: GitHub redelivers. */
export async function deliver(ctx: ActionCtx, event: string, payload: Payload): Promise<void> {
  const installationId = payload.installation?.id;
  if (typeof installationId !== "number") return;

  if (event === "push") {
    const fullName = payload.repository?.full_name;
    const ref = payload.ref;
    if (!fullName || !ref?.startsWith(BRANCH)) return;
    await ctx.runMutation(internal.github.installations.onPush, {
      installationId,
      fullName,
      branch: ref.slice(BRANCH.length),
    });
    return;
  }

  if (event === "installation") {
    const action = payload.action;
    if (action === "deleted" || action === "suspend" || action === "unsuspend") {
      await ctx.runMutation(internal.github.installations.onInstallation, { installationId, action });
    }
    return;
  }

  if (event === "installation_repositories") {
    const selection = payload.installation?.repository_selection;
    await ctx.runMutation(internal.github.installations.onRepositories, {
      installationId,
      removed: (payload.repositories_removed ?? [])
        .map((repo) => repo.full_name)
        .filter((name): name is string => !!name),
      ...(selection === "all" || selection === "selected" ? { selection } : {}),
    });
    return;
  }

  if (event === "organization" && payload.action === "member_removed") {
    const org = payload.organization?.login;
    const login = payload.membership?.user?.login;
    if (org && login) {
      await ctx.runMutation(internal.github.installations.onOrgMemberRemoved, {
        installationId,
        org,
        login,
      });
    }
  }
}
