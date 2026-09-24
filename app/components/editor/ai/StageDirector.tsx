"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import type { BlockNoteEditor } from "@blocknote/core";
import type { Id } from "@/convex/_generated/dataModel";
import { reveal, suspendCompletions } from "@/app/lib/ai/tourDrive";
import { TAB_SCRIPTS, type TabScript } from "@/app/lib/ai/staged/tab";
import { useCompletionProject } from "./CompletionContext";
import { clearSuggestion, setAction, setGhost } from "./ghostText";

/**
 * The three Tab moments, painted rather than fetched.
 *
 * `tourDrive` carries the reason in full: the completion lane was once scripted
 * at the network layer, and the pipeline kept withdrawing the suggestion —
 * superseded, unparsed, ungrounded, nothing left after the block gate. A demo
 * cannot promise "press Tab" on top of machinery allowed to change its mind.
 *
 * So this paints through the same plugin the real lane paints through, and Tab
 * accepts through the same `acceptSuggestion`. What lands is real document
 * state: it syncs, it undoes, and it is in context for every call after it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

/**
 * The Tab lane's half of the allowlist.
 *
 * The chat lane is gated on the server, where the Clerk subject is verified and
 * the list never leaves the machine. This lane paints in the browser, so its
 * check has to happen here — which means the allowlist ships in the bundle.
 * That is acceptable precisely because a Clerk user id is not a secret: it
 * identifies an account, it does not authenticate one, and nothing here grants
 * access to anything. Without this check `NEXT_PUBLIC_STAGED_DEMO=1` would
 * paint scripted completions into every signed-in person's document.
 */
const DEMO_ON = process.env.NEXT_PUBLIC_STAGED_DEMO === "1";
const DEMO_USERS = (process.env.NEXT_PUBLIC_STAGED_DEMO_USERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function staged(userId: string | null | undefined): boolean {
  return DEMO_ON && !!userId && DEMO_USERS.includes(userId);
}

/** How much of the line before the caret a tab regex is matched against. */
const LOOKBEHIND = 240;

export function StageDirector({ editor }: { editor: Editor | null }) {
  const { user } = useUser();
  const ON = staged(user?.id);
  const projectId = useCompletionProject();
  const [armed, setArmed] = useState<TabScript | null>(null);
  const painting = useRef(false);

  /**
   * Which script the caret is sitting in front of, if any.
   *
   * Armed only at the end of a block with the caret at the end of it — the one
   * position where "finish this line" is plainly what the presenter is about
   * to do. The director never moves the caret: the suggestion appears because
   * they typed their way to it.
   */
  const judge = useCallback(() => {
    if (!ON || !editor) return;
    const view = editor.prosemirrorView;
    if (!view) return setArmed(null);

    const sel = view.state.selection;
    if (!sel.empty || sel.$from.parentOffset !== sel.$from.parent.content.size) {
      return setArmed(null);
    }

    let block: { type?: string } | null = null;
    try {
      block = editor.getTextCursorPosition().block as { type?: string };
    } catch {
      return setArmed(null);
    }

    const before = view.state.doc.textBetween(
      Math.max(0, sel.from - LOOKBEHIND),
      sel.from,
      "\n",
      "\n",
    );

    const found =
      TAB_SCRIPTS.find(
        (script) =>
          (!script.inBlock || script.inBlock === block?.type) && script.match.test(before),
      ) ?? null;
    setArmed(found);
  }, [editor, ON]);

  useEffect(() => {
    if (!ON || !editor) return;
    // One evaluation for the caret that is already where a script wants it —
    // mounting fires no selection event. On the next frame rather than in the
    // effect body, which would be a cascading render.
    const first = requestAnimationFrame(judge);
    const offSel = editor.onSelectionChange(judge, false);
    const offDoc = editor.onChange(judge, false);
    return () => {
      cancelAnimationFrame(first);
      offSel?.();
      offDoc?.();
    };
  }, [editor, judge, ON]);

  useEffect(() => {
    if (!ON || !editor || !armed) return;
    const view = editor.prosemirrorView;
    if (!view) return;

    // Two authors in one suggestion slot is the collision that would make the
    // beat unreadable, so the real lane stands down while this one paints.
    suspendCompletions(true);
    painting.current = true;

    let stop = () => {};
    if (armed.id === "T-10") {
      // Structural: accepting this has to run a macro, not insert a string.
      // The action's own `onAccept` is the hook the diagram lane already uses
      // to place something that is still being drawn.
      stop = reveal(armed.ghost, (sofar, done) => {
        if (!done) return;
        setAction(view, {
          label: "Build the diagram",
          batch: null,
          onAccept: () => void buildDiagram(editor, armed.ghost, projectId),
        });
      });
    } else {
      // Prose and code: what is shown is what is inserted. `markup` renders the
      // inline tags; `text` is what lands, so a `<code>` never arrives as five
      // literal characters.
      const plain = stripTags(armed.ghost);
      stop = reveal(plain, (sofar, done) =>
        setGhost(view, sofar, !done, done ? armed.ghost : undefined),
      );
    }

    return () => {
      stop();
      clearSuggestion(view);
      suspendCompletions(false);
      painting.current = false;
    };
  }, [editor, armed, ON, projectId]);

  return null;
}

/** Inline markup off a completion, leaving what actually gets inserted. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/**
 * T-10's accept: the canvas, streamed into the document as it arrives.
 *
 * Through `insertBlocks`/`updateBlock` rather than by painting, so the board
 * lands on the real path — Yjs, sync, review, one step on the undo stack — and
 * is a diagram the presenter can drag a box on the moment it settles.
 */
async function buildDiagram(editor: Editor, ghost: string, projectId: Id<"projects"> | null) {
  const brief = /<nt-build-diagram>([\s\S]*?)<\/nt-build-diagram>/i.exec(ghost)?.[1] ?? "";
  const here = editor.getTextCursorPosition().block;
  const [placed] = editor.insertBlocks(
    [{ type: "canvas", props: { data: "" } }],
    here,
    "after",
  ) as unknown as { id: string }[];

  try {
    const res = await fetch("/api/diagram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The project, as the lane's own diagrams send it: its look, and its ledger.
      body: JSON.stringify({ brief, page: "", title: "", projectId }),
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let out = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += value;
      // Only once the element has closed is it markup a canvas can read; before
      // that it is half a tag, and half a tag is not a shape.
      const whole = /<nt-diagram[\s\S]*?<\/nt-diagram>/i.exec(out)?.[0];
      const partial = whole ?? `${out}\n</nt-diagram>`;
      if (/<nt-(rect|ellipse|polygon|path|group|text)\b/i.test(partial)) {
        editor.updateBlock(placed.id, { props: { data: partial } });
      }
    }
  } catch {
    // A demo machine with no network still gets a block it can type into,
    // rather than a half-written one it cannot.
  }
}
