"use client";

import { createContext, useContext } from "react";
import type { ProjectRole } from "@/convex/auth";

/**
 * What the surrounding surface may do with a page's comments — the client's
 * courtesy copy of the comments channel's gate (`auth.channelAdmits`), so a
 * surface can leave out what the server would refuse rather than offer it and
 * fail. The server still decides; this only decides what to draw.
 */
export type CommentAccess = {
  canRead: boolean;
  canComment: boolean;
  /**
   * Present only where signing in is what would let this visitor comment — a
   * signed-out guest on a comment link. A comment affordance calls it instead
   * of hiding, and it opens the share route's sign-in door.
   */
  signIn?: () => void;
};

/** Nobody signed in, or not yet known: comments fail closed. */
export const NO_COMMENT_ACCESS: CommentAccess = { canRead: false, canComment: false };

const READ_ONLY: CommentAccess = { canRead: true, canComment: false };
const FULL: CommentAccess = { canRead: true, canComment: true };

/**
 * The access a resolved project role carries. `null`/`undefined` — a
 * signed-out link visitor, a stranger, a query still loading — reads nothing:
 * a signed-out visitor has no identity to be answerable for a conversation
 * with. An operator standing in arrives here already told "viewer" by
 * `projects.myRole`, so reads and never writes, matching the server.
 */
export function commentAccessFor(role: ProjectRole | null | undefined): CommentAccess {
  switch (role) {
    case "owner":
    case "editor":
    case "commenter":
      return FULL;
    case "viewer":
      return READ_ONLY;
    default:
      return NO_COMMENT_ACCESS;
  }
}

export const CommentAccessContext = createContext<CommentAccess>(NO_COMMENT_ACCESS);

export function useCommentAccess(): CommentAccess {
  return useContext(CommentAccessContext);
}
