import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { CommentsHistory } from "@/app/lib/comments/history";
import { CommentsStore, readThreads } from "@/app/lib/comments/store";
import { emptyCommentsDocument, type CommentAnchor } from "@/app/lib/comments/types";
import { createNmlYDoc } from "@/app/lib/nml/yjs";
import { WorkspaceHistory, type DomainStep } from "./spine";
import {
  COMMENTS_SCOPE_ATTR,
  commentsScope,
  UNDO_SCOPE_ATTR,
  undoKeyOf,
  undoRoute,
  type FocusTarget,
} from "./undoRoute";

/**
 * An element as routing sees it: a tag, whether it is editable text, and the
 * attributes on it and its ancestors (nearest first).
 */
function el(tagName: string, ancestors: Record<string, string>[] = [], isContentEditable = false): FocusTarget {
  return {
    tagName,
    isContentEditable,
    closest(selector) {
      const name = /^\[([^\]=]+)\]$/.exec(selector)?.[1];
      if (!name) throw new Error(`unexpected selector ${selector}`);
      const hit = ancestors.find((attrs) => name in attrs);
      return hit ? { getAttribute: (attr) => hit[attr] ?? null } : null;
    },
  };
}

const DOCUMENT = { [UNDO_SCOPE_ATTR]: "" };
const COMMENTS = commentsScope("page_1");

describe("undoKeyOf", () => {
  const press = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
    undoKeyOf({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

  it("reads undo and redo on either platform", () => {
    expect(press("z", { metaKey: true })).toBe("undo");
    expect(press("z", { ctrlKey: true })).toBe("undo");
    expect(press("Z", { metaKey: true, shiftKey: true })).toBe("redo");
    expect(press("z", { ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(press("y", { ctrlKey: true })).toBe("redo");
  });

  it("ignores everything else", () => {
    expect(press("z")).toBeNull();
    expect(press("z", { shiftKey: true })).toBeNull();
    expect(press("z", { metaKey: true, altKey: true })).toBeNull();
    expect(press("x", { metaKey: true })).toBeNull();
  });
});

describe("undoRoute", () => {
  it("sends the document, a diagram and a bare body to the spine", () => {
    expect(undoRoute(el("DIV", [DOCUMENT], true))).toEqual({ to: "spine" });
    expect(undoRoute(el("DIV", [DOCUMENT]))).toEqual({ to: "spine" });
    expect(undoRoute(el("BODY"))).toEqual({ to: "spine" });
    expect(undoRoute(null)).toEqual({ to: "spine" });
  });

  it("leaves an untracked text field its native undo", () => {
    expect(undoRoute(el("TEXTAREA"))).toEqual({ to: "native" });
    expect(undoRoute(el("input"))).toEqual({ to: "native" });
    expect(undoRoute(el("DIV", [], true))).toEqual({ to: "native" });
    expect(undoRoute(el("MATH-FIELD"))).toEqual({ to: "native" });
  });

  it("sends a focused comment card or panel to that page's comments", () => {
    expect(undoRoute(el("DIV", [COMMENTS]))).toEqual({ to: "comments", pageId: "page_1" });
    expect(undoRoute(el("BUTTON", [{}, COMMENTS]))).toEqual({ to: "comments", pageId: "page_1" });
  });

  it("keeps native undo in a comment composer, typing a draft", () => {
    expect(undoRoute(el("TEXTAREA", [COMMENTS]))).toEqual({ to: "native" });
    expect(undoRoute(el("INPUT", [COMMENTS]))).toEqual({ to: "native" });
    expect(undoRoute(el("DIV", [COMMENTS], true))).toEqual({ to: "native" });
  });

  it("lets a comment surface inside the document win over the document", () => {
    // A card or composer mounted inside the editor's subtree is still a comment surface.
    expect(undoRoute(el("DIV", [COMMENTS, DOCUMENT]))).toEqual({ to: "comments", pageId: "page_1" });
    expect(undoRoute(el("TEXTAREA", [COMMENTS, DOCUMENT]))).toEqual({ to: "native" });
  });

  it("answers nothing for a comment surface that names no page", () => {
    expect(undoRoute(el("DIV", [{ [COMMENTS_SCOPE_ATTR]: "" }]))).toEqual({ to: "native" });
  });
});

const ANCHOR: CommentAnchor = { blockId: "p1", exact: "Friday", prefix: "ship it by ", suffix: "", offsetHint: 11 };

/**
 * The two timelines side by side, as the key handlers drive them: the page's
 * text on the spine through a Y.UndoManager domain (as `textDomain` registers
 * it), and the comments document on its own history. Whatever the order of
 * edits, a spine step touches only the page and a comments step only the
 * comments.
 */
function workspace() {
  const spine = new WorkspaceHistory();
  const page = new Y.Doc();
  const text = page.getText("prosemirror");
  const pageUndo = new Y.UndoManager(text, { captureTimeout: 0 });
  pageUndo.on("stack-item-added", (event: { type: "undo" | "redo" }) => {
    if (event.type === "undo" && !stepping) spine.record("text:page", "edit");
  });
  let stepping = false;
  const step = (direction: "undo" | "redo"): DomainStep => {
    const from = direction === "undo" ? pageUndo.undoStack : pageUndo.redoStack;
    const before = from.length;
    stepping = true;
    try {
      if (direction === "undo") pageUndo.undo();
      else pageUndo.redo();
    } finally {
      stepping = false;
    }
    return { consumed: before - from.length, redoable: true };
  };
  spine.register("text:page", { undo: () => step("undo"), redo: () => step("redo") }, "page_1");

  const comments = createNmlYDoc(emptyCommentsDocument("comments-doc"));
  const history = new CommentsHistory(comments, { localUserId: "user_ada" });
  const store = new CommentsStore(comments, { actor: { userId: "user_ada", kind: "human" }, authorize: () => true });
  return { spine, text, history, store, comments };
}

describe("the page and its comments keep separate timelines", () => {
  it("⌘Z in the document steps over a newer comment; ⌘Z on a comment steps over newer typing", async () => {
    const { spine, text, history, store, comments } = workspace();
    text.insert(0, "ship it by Friday");
    await store.createThread({ anchor: ANCHOR, body: "Too soon?", authorId: "user_ada" });
    text.insert(text.length, "!");

    // A comment action is not on the spine.
    expect(spine.canUndo()).toBe(true);
    await spine.undo();
    expect(text.toString()).toBe("ship it by Friday");
    await spine.undo();
    expect(text.toString()).toBe("");
    expect(spine.canUndo()).toBe(false);
    expect(readThreads(comments)).toHaveLength(1);

    // And the comments history holds only the comment.
    await spine.redo();
    expect(history.undo()).toBe(true);
    expect(readThreads(comments)).toHaveLength(0);
    expect(text.toString()).toBe("ship it by Friday");
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(true);
    expect(readThreads(comments)).toHaveLength(1);
    expect(text.toString()).toBe("ship it by Friday");
  });

  it("a comment action keeps the document's redo, as it touches nothing there", async () => {
    const { spine, text, store } = workspace();
    text.insert(0, "draft");
    await spine.undo();
    expect(spine.canRedo()).toBe(true);
    await store.createThread({ anchor: ANCHOR, body: "Note", authorId: "user_ada" });
    expect(spine.canRedo()).toBe(true);
    await spine.redo();
    expect(text.toString()).toBe("draft");
  });
});
