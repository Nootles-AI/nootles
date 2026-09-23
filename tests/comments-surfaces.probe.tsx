import { useRef, useState, type ComponentProps } from "react";
import { Editor as RealEditor } from "../app/components/editor/Editor";
import { SharedEditor as RealSharedEditor } from "../app/components/share/SharedEditor";
import { usePageComments } from "../app/components/comments/PageComments";
import {
  useCommentableSelection,
  type CommentableSelection,
} from "../app/components/comments/useCommentableSelection";
import { commentsScope } from "../app/lib/history/undoRoute";

/**
 * A comment surface as the margin-card wave will draw one, reduced to what
 * the harness drives: it reads only `usePageComments` and
 * `useCommentableSelection`, and it is a `commentsScope` — a focusable card
 * holding a composer. The runner swaps it in beside each page's real editor,
 * inside the real `PageCommentsProvider`.
 */
function Probe() {
  const comments = usePageComments();
  const selection = useCommentableSelection();
  // Captured on the way down, as an affordance that takes focus must: the
  // selection is gone once the composer has it.
  const held = useRef<CommentableSelection | null>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  if (!comments) return <aside id="probe" data-missing="" />;

  const start = async () => {
    const target = held.current;
    held.current = null;
    if (!target) return setError("nothing selected");
    if (target.kind === "signIn") return target.signIn();
    try {
      const store = await comments.ensureStore();
      await store.createThread({ anchor: target.anchor, body: body.current?.value || "A comment", authorId: comments.userId! });
      if (body.current) body.current.value = "";
      setError(null);
    } catch (thrown) {
      setError((thrown as Error).message);
    }
  };

  return (
    <aside
      id="probe"
      data-status={comments.status}
      data-can-read={String(comments.access.canRead)}
      data-can-comment={String(comments.access.canComment)}
      data-sign-in={String(Boolean(comments.access.signIn))}
      data-has-store={String(Boolean(comments.store))}
      data-has-history={String(Boolean(comments.history))}
      data-threads={JSON.stringify(comments.threads.map((thread) => ({ id: thread.id, exact: thread.anchor.exact, comments: thread.comments.length })))}
      data-selection={JSON.stringify(
        selection && { kind: selection.kind, exact: selection.anchor.exact, blockId: selection.anchor.blockId, prefix: selection.anchor.prefix },
      )}
      data-error={error ?? ""}
      style={{ position: "fixed", left: 280, bottom: 16, zIndex: 10000, background: "#fff", border: "1px solid #ddd", padding: 8, width: 260 }}
    >
      <div id="comment-card" tabIndex={-1} {...commentsScope(comments.pageId)} style={{ padding: 8, outline: "1px dashed #ccc" }}>
        <p id="card-label" style={{ margin: 0, fontSize: 12 }}>Comment card</p>
        <textarea id="comment-body" rows={2} style={{ width: "100%" }} />
        <button
          id="comment-start"
          type="button"
          onPointerDown={(event) => {
            held.current = selection;
            event.preventDefault();
          }}
          onClick={() => void start()}
        >
          {selection?.kind === "signIn" ? "Sign in to comment" : "Comment"}
        </button>
      </div>
    </aside>
  );
}

export function Editor(props: ComponentProps<typeof RealEditor>) {
  return (
    <>
      <RealEditor {...props} />
      <Probe />
    </>
  );
}

export function SharedEditor(props: ComponentProps<typeof RealSharedEditor>) {
  return (
    <>
      <RealSharedEditor {...props} />
      <Probe />
    </>
  );
}
