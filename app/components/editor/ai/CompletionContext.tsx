"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AI } from "@/app/lib/ai/aiConfig";
import { completionSeed } from "@/app/lib/ai/context/pack";

/**
 * The project the completion lane draws its context from.
 *
 * A context rather than a prop because the editor sits several components below
 * anything that knows the project. Empty is the ordinary case off the
 * workspace: the shared surface mounts no provider, and completes exactly as
 * before.
 */
const CompletionProject = createContext<Id<"projects"> | null>(null);

export function CompletionContextProvider({
  projectId,
  children,
}: {
  projectId: Id<"projects">;
  children: ReactNode;
}) {
  return <CompletionProject value={projectId}>{children}</CompletionProject>;
}

/** The project completions are written in, or null off the workspace. */
export function useCompletionProject(): Id<"projects"> | null {
  return useContext(CompletionProject);
}

/**
 * The seed for completions on one page, or "" anywhere the provider isn't
 * mounted. A subscription rather than a fetch per completion, because the pack
 * only changes when the project's context does, while completions fire on
 * every pause in typing.
 */
export function useCompletionContext(pageId: Id<"pages"> | null | undefined): string {
  const projectId = useContext(CompletionProject);
  const inputs = useQuery(
    api.context.read.packInputs,
    projectId ? { projectId, ...(pageId ? { pageId } : {}) } : "skip",
  );
  return useMemo(
    () => (inputs ? completionSeed(inputs, pageId ?? undefined, AI.fim.context.maxChars) : ""),
    [inputs, pageId],
  );
}
