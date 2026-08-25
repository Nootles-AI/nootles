import type { MutationCtx } from "./_generated/server";
import { requireOwner } from "./auth";

/**
 * The upload door's authorization, stated once.
 *
 * Signed-in only, which is as far as ownership can reach: a storage id is not a
 * row, so there is nothing to hang an `ownerId` off. Four surfaces open this
 * door — album media, chat attachments, project context files and feedback
 * screenshots — and each keeps its own `generateUploadUrl` at the path its
 * client already calls. What they must not keep is four copies of the policy:
 * hardening it (recording who uploaded what, size caps, rate limits) would then
 * be four chances to miss one.
 */
export async function uploadUrl(ctx: MutationCtx): Promise<string> {
  await requireOwner(ctx);
  return await ctx.storage.generateUploadUrl();
}
