"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { contextSeed } from "@/app/lib/ai/contextSeed";

/**
 * The project's standing context, rendered once for the completion lane.
 *
 * A context rather than a prop because the editor sits several components below
 * anything that knows the project — and a subscription here rather than a fetch
 * per completion because the note only changes when the context sheet or a
 * file does, while completions fire on every pause in typing.
 *
 * Empty is the ordinary case: viewers, the shared surface, and every project
 * with nothing on its sheet all complete exactly as before.
 */
const CompletionContext = createContext("");

export function CompletionContextProvider({
  projectId,
  children,
}: {
  projectId: Id<"projects">;
  children: ReactNode;
}) {
  const project = useQuery(api.ai.context.forPrompt, { projectId });
  const seed = useMemo(() => contextSeed(project ?? null), [project]);
  return <CompletionContext value={seed}>{children}</CompletionContext>;
}

/** The seed addition, or "" anywhere the provider isn't mounted. */
export function useCompletionContext(): string {
  return useContext(CompletionContext);
}
