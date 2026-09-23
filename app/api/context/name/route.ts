import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { AI } from "@/app/lib/ai/aiConfig";
import { nameRepository } from "@/app/lib/ai/context/name";
import { recordAiCall } from "@/app/lib/ai/recordCall";
import { asUser } from "@/app/lib/convexServer";
import { refuseIfSpent } from "@/app/lib/entitlementGate";
import { refuseIfLimited } from "@/app/lib/requestLimitGate";
import { session } from "@/app/lib/session";

/**
 * Names a freshly indexed repository's areas and concerns (stage 2).
 *
 * Asked for by the linker's own browser once indexing lands (`useRepoNaming`),
 * because this is where the model keys and the ledger live. The claim is what
 * bounds the spend: a repository is named once per index, whatever number of
 * tabs ask, and a repository not waiting to be named costs nothing to ask about.
 */
export async function POST(req: Request) {
  const caller = await session();
  if (!caller) return new Response("Unauthorized", { status: 401 });
  const { token } = caller;

  const { repoId, projectId } = ((await req.json().catch(() => null)) ?? {}) as {
    repoId?: unknown;
    projectId?: unknown;
  };
  if (typeof repoId !== "string") return new Response("`repoId` is required", { status: 400 });
  const project = typeof projectId === "string" ? projectId : undefined;

  const convex = asUser(token);
  const limited = await refuseIfLimited(convex, "agentGeneration");
  if (limited) return limited;
  // Before the claim, so a refusal leaves the repository waiting to be named.
  // See the reformat route: a named workspace project is that workspace's bill.
  const spent = await refuseIfSpent(token, null, project);
  if (spent) return spent;

  const outline = await convex
    .mutation(api.github.naming.claim, { repoId: repoId as Id<"projectRepos"> })
    .catch(() => null);
  if (!outline) return new Response(null, { status: 204 });

  const started = Date.now();
  try {
    // Not tied to the request: a tab closed mid-call would otherwise leave the
    // repository claimed and unnamed, and the claim would have to time out first.
    const { names, calls } = await nameRepository(outline);
    for (const call of calls) {
      recordAiCall(convex, {
        ownerId: caller.userId,
        feature: "context",
        model: AI.context.nameModel,
        projectId: project,
        promptTokens: call.promptTokens,
        completionTokens: call.completionTokens,
        latencyMs: Date.now() - started,
        ...(call.failure
          ? { status: "error" as const, errorCode: call.failure }
          : { status: "ok" as const }),
      });
    }
    if (names.length) {
      await convex.mutation(api.github.naming.apply, {
        repoId: repoId as Id<"projectRepos">,
        names,
      });
    } else {
      await convex.mutation(api.github.naming.skip, { repoId: repoId as Id<"projectRepos"> });
    }
    return Response.json({ named: names.length });
  } catch {
    // The directory names stand; a failed naming is not a failed index.
    await convex
      .mutation(api.github.naming.skip, { repoId: repoId as Id<"projectRepos"> })
      .catch(() => {});
    return Response.json({ named: 0 });
  }
}
