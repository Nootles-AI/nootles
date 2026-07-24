import { Auth } from "convex/server";

/**
 * v0 is single-user (no sharing/teams). Until real auth lands we resolve a
 * stable local owner id. Centralized here so swapping in Convex Auth later is a
 * one-file change: read the identity and return its subject instead.
 */
export const DEV_OWNER_ID = "local-user";

export async function getOwnerId(_ctx: { auth: Auth }): Promise<string> {
  // TODO(auth): return (await ctx.auth.getUserIdentity())?.subject once
  // multiplayer/tenancy is introduced.
  return DEV_OWNER_ID;
}
