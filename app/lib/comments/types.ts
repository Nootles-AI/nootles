import type {
  NmlCommentAnchor,
  NmlCommentBlock,
  NmlCommentThreadBlock,
  NmlDocument,
  NmlInlineContent,
} from "@/app/lib/nml/schema";
import { NML_SCHEMA_VERSION } from "@/app/lib/nml/schema";

/**
 * Comments as the product reads them, over the NML the comments document
 * stores. A thread is a `commentThread` block and its comments are the
 * `comment` blocks beneath it; these view types are what every surface —
 * margin cards, the panel, the assistant's digest — works with, so none of
 * them has to know the block shape.
 *
 * Read-only conversions live here. Writing goes through the NML command
 * executor (the comments store), never by editing these values.
 */

/** How much text either side of a quotation an anchor keeps. */
export const CONTEXT_CHARS = 32;

export type CommentAnchor = NmlCommentAnchor;
export type ThreadStatus = NmlCommentThreadBlock["props"]["status"];

export type Comment = {
  id: string;
  authorId: string;
  createdAt: number;
  editedAt?: number;
  content: NmlInlineContent;
};

export type Thread = {
  id: string;
  anchor: CommentAnchor;
  status: ThreadStatus;
  resolvedBy?: string;
  resolvedAt?: number;
  /** Set while the anchor resolves nowhere; a cache, cleared when it does. */
  orphanedAt?: number;
  /** The quotation matched more than once when last resolved. */
  ambiguous: boolean;
  comments: Comment[];
};

export function commentFromBlock(block: NmlCommentBlock): Comment {
  const { authorId, createdAt, editedAt } = block.props;
  return {
    id: block.id,
    authorId,
    createdAt,
    ...(editedAt !== undefined ? { editedAt } : {}),
    content: block.content,
  };
}

export function threadFromBlock(block: NmlCommentThreadBlock): Thread {
  const { anchor, status, resolvedBy, resolvedAt, orphanedAt, ambiguous } = block.props;
  return {
    id: block.id,
    anchor: { ...anchor },
    status,
    ...(resolvedBy !== undefined ? { resolvedBy } : {}),
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(orphanedAt !== undefined ? { orphanedAt } : {}),
    ambiguous: ambiguous === true,
    comments: block.children.flatMap((child) =>
      child.type === "comment" ? [commentFromBlock(child)] : [],
    ),
  };
}

/** Every thread in a comments document, in document order. */
export function threadsOf(document: NmlDocument): Thread[] {
  if (document.kind !== "comments") throw new Error("Not a comments document.");
  return document.blocks.flatMap((block) =>
    block.type === "commentThread" ? [threadFromBlock(block)] : [],
  );
}

export function commentBlock(comment: Comment): NmlCommentBlock {
  return {
    id: comment.id,
    type: "comment",
    props: {
      authorId: comment.authorId,
      createdAt: comment.createdAt,
      ...(comment.editedAt !== undefined ? { editedAt: comment.editedAt } : {}),
    },
    content: comment.content,
    children: [],
  };
}

export function threadBlock(thread: Thread): NmlCommentThreadBlock {
  return {
    id: thread.id,
    type: "commentThread",
    props: {
      anchor: { ...thread.anchor },
      status: thread.status,
      ...(thread.resolvedBy !== undefined ? { resolvedBy: thread.resolvedBy } : {}),
      ...(thread.resolvedAt !== undefined ? { resolvedAt: thread.resolvedAt } : {}),
      ...(thread.orphanedAt !== undefined ? { orphanedAt: thread.orphanedAt } : {}),
      ...(thread.ambiguous ? { ambiguous: true as const } : {}),
    },
    children: thread.comments.map(commentBlock),
  };
}

/** A page's comments document before anyone has commented. */
export function emptyCommentsDocument(documentId: string): NmlDocument {
  return { schemaVersion: NML_SCHEMA_VERSION, documentId, kind: "comments", blocks: [] };
}

/**
 * A comment's words as plain text — what a notification or a digest quotes.
 * Atoms read as what a reader sees of them: a page mention by its title, math
 * by its source, a tick box not at all.
 */
export function commentText(content: NmlInlineContent): string {
  return content
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "link":
          return node.content.map((run) => run.text).join("");
        case "math":
          return node.latex;
        case "pageRef":
          return node.fallbackTitle;
        case "checkbox":
          return "";
      }
    })
    .join("");
}
