"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useOpenPage } from "@/app/components/OpenPageContext";
import { useEditorRegistry } from "@/app/components/editor/EditorRegistry";
import { ReviewSession, type TurnReview } from "@/app/lib/ai/review/session";

const ReviewContext = createContext<ReviewSession | null>(null);

/**
 * The project's open reviews.
 *
 * Held above the workspace because a review outlives the turn that made it and
 * can span several pages: the conversation may move on, the user may switch
 * page, and the changes are still sitting there unanswered.
 */
export function ReviewProvider({
  projectId,
  children,
}: {
  projectId: Id<"projects">;
  children: ReactNode;
}) {
  const convex = useConvex();
  const registry = useEditorRegistry();
  // Only the page on screen has a mounted editor, and undoing a change needs
  // one — so answering a review on a page the user has since navigated away
  // from opens it, exactly as the agent's own tools do before editing.
  const { open } = useOpenPage();
  const [session] = useState(
    () =>
      new ReviewSession({
        convex,
        openPage: open,
        editorFor: (pageId) => registry.editorFor(pageId),
      }),
  );

  // Not a derived value — the session owns this state, and this is the one
  // moment it can be told what was already on the page when it was built.
  // `hydrate` ignores turns it already knows, so a re-query is a no-op.
  const unreviewed = useQuery(api.chat.turns.unreviewed, { projectId });
  useEffect(() => {
    if (unreviewed) session.hydrate(unreviewed);
  }, [session, unreviewed]);

  return <ReviewContext value={session}>{children}</ReviewContext>;
}

export function useReview(): ReviewSession {
  const session = useContext(ReviewContext);
  if (!session) throw new Error("Missing <ReviewProvider>");
  return session;
}

/** Every turn whose changes are on a page, and where each of them stands. */
export function useReviewTurns(): readonly TurnReview[] {
  const session = useReview();
  return useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
}
