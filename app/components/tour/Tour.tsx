"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  useEditorRegistry,
  type LiveEditor,
} from "@/app/components/editor/EditorRegistry";
import { useCanvasShell } from "@/app/components/editor/canvas/shell";
import { useOpenReviews } from "@/app/components/ReviewContext";
import { usePanels } from "@/app/components/PanelsContext";
import { prefillComposer } from "@/app/lib/ai/chat/prefill";
import { lineish, reveal, suspendCompletions } from "@/app/lib/ai/tourDrive";
import {
  clearSuggestion,
  setAction,
  setGhost,
} from "@/app/components/editor/ai/ghostText";
import { templateById } from "@/app/lib/onboarding/templates";
import type { Template } from "@/app/lib/onboarding/types";
import { CoachCard } from "./CoachCard";
import { Checklist, type ChecklistItem } from "./Checklist";
import { Spotlight } from "./Spotlight";
import { useRect, useTarget } from "./useRect";
import "./tour.css";

/** The three gated beats. Past the last one the guide stops being in the way. */
const GATED = 3;

/**
 * The first-run guide.
 *
 * Rides on the real editor rather than a sandbox: every keystroke it asks for
 * edits the user's actual first project, so they leave with work rather than a
 * demo that gets thrown away. It renders nothing at all unless a tour is
 * running on this project, which is the ordinary case for everyone but a brand
 * new account.
 */
export function Tour({
  projectId,
  pageId,
}: {
  projectId: Id<"projects">;
  pageId: Id<"pages"> | null;
}) {
  const profile = useQuery(api.profiles.get, {});
  const tour = profile?.status === "touring" ? (profile.tour ?? null) : null;
  const template = tour ? templateById(tour.template) : null;

  if (!tour || !template || tour.projectId !== projectId || !pageId) return null;
  return (
    <Running
      beat={tour.beat}
      done={tour.done}
      template={template}
      pageId={pageId}
      projectId={projectId}
    />
  );
}

function Running({
  beat,
  done,
  template,
  pageId,
  projectId,
}: {
  beat: number;
  done: string[];
  template: Template;
  pageId: Id<"pages">;
  projectId: Id<"projects">;
}) {
  const registry = useEditorRegistry();
  const panels = usePanels();
  const shell = useCanvasShell();
  const openReviews = useOpenReviews();
  const setBeat = useMutation(api.profiles.setBeat);
  const check = useMutation(api.profiles.check);
  const skip = useMutation(api.profiles.skip);
  const finish = useMutation(api.profiles.finish);

  const script = template.script;
  const [editor, setEditor] = useState<LiveEditor | null>(null);

  useEffect(() => {
    let live = true;
    registry
      .editorFor(pageId)
      .then((found) => live && setEditor(found))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [registry, pageId]);

  /**
   * Move to a beat, once.
   *
   * Deferred because Convex mutations set React state, and these are called
   * from inside the editor's own transaction cycle — dispatching from there
   * re-enters rendering. Latched because the change that ends a beat keeps
   * being true afterwards: `onChange` fires on every keystroke that follows,
   * and each one would otherwise re-send the same advance.
   */
  const sent = useRef(-1);
  const advance = useCallback(
    (to: number) => {
      if (sent.current >= to) return;
      sent.current = to;
      setTimeout(() => void setBeat({ beat: to }).catch(() => {}), 0);
    },
    [setBeat],
  );

  /* ---- Beats 0 and 1: the guide draws them itself ---------------------- */

  // No model is called during first run. The lane stays off for the whole
  // tour — including the free tail, where a real completion arriving over a
  // checklist would be its own kind of confusing.
  useEffect(() => {
    suspendCompletions(true);
    return () => suspendCompletions(false);
  }, []);

  /**
   * Put the caret where the suggestion belongs, then write the suggestion.
   *
   * Straight into the same plugin the completion lane writes into, so `Tab` is
   * handled by `acceptSuggestion` exactly as it always is — ghost text inserts
   * itself, and an action with no batch calls `onAccept`. Nothing downstream
   * knows or cares that no model was involved.
   */
  useEffect(() => {
    if (!editor || beat > 1) return;
    const view = editor.prosemirrorView;
    if (!view) return;

    const draw = beat === 1;
    const target = draw ? script.draw.blockId : script.write.blockId;
    const block = editor.document.find((b) => b.id === target);
    if (!block) return;

    editor.focus();
    editor.setTextCursorPosition(block, "end");

    const stop = draw
      ? reveal(
          script.draw.html,
          (sofar, done) =>
            setAction(view, {
              label: "Add diagram",
              batch: null,
              preview: { kind: "diagram", source: sofar },
              // Placed by us, because we are the ones who drew it. A real block
              // in the real document — the point of the tour is that the user
              // keeps what it makes.
              onAccept: done
                ? () =>
                    editor.insertBlocks(
                      [{ type: "canvas", props: { data: script.draw.html } }],
                      target,
                      "after",
                    )
                : undefined,
            }),
          { stepMs: 70, chunk: lineish },
        )
      : reveal(script.write.ghost, (sofar, done) =>
          setGhost(view, sofar, !done),
        );

    return () => {
      stop();
      clearSuggestion(view);
    };
  }, [editor, beat, script]);

  // Advance on the real outcome, not on the keypress: what ends a beat is the
  // suggestion having landed in the document.
  useEffect(() => {
    if (!editor || beat > 1) return;
    const landed = () =>
      beat === 0
        ? // Compared loosely on whitespace: what the applier writes into the
          // block is the completion re-serialized, not the string we scripted,
          // and a line break landing differently is not a different sentence.
          flat(textOf(editor.document.find((b) => b.id === script.write.blockId))).includes(
            flat(script.write.ghost),
          )
        : editor.document.some(
            (b) => b.type === "canvas" && Boolean((b.props as { data?: string })?.data),
          );
    if (landed()) {
      advance(beat + 1);
      return;
    }
    return editor.onChange(() => landed() && advance(beat + 1), false);
  }, [editor, beat, script, advance]);

  /* ---- Beat 2: the agent, and answering for it ------------------------- */

  /**
   * Where the last beat has got to.
   *
   * Read off the app rather than tracked, so it survives a reload and cannot
   * disagree with what is on screen. The one that looks like a hack — asking
   * the DOM whether the thinking indicator is up — is the honest signal here:
   * `busy` lives inside the chat panel's own hook, and lifting it out would
   * mean threading state through two components that have no use for it just
   * so the guide can read one boolean.
   */
  const threads = useQuery(api.chat.threads.list, { projectId });
  const working = useTarget(".nt-turn-pending, .nt-turn-step.is-running") !== null;
  const phase: ChatPhase = openReviews.length
    ? "review"
    : working
      ? "watching"
      : (threads?.length ?? 1) > 1
        ? "ask"
        : "newChat";

  useEffect(() => {
    if (beat !== 2) return;
    panels?.openChat();
  }, [beat, panels]);

  // Written only once they have somewhere of their own to put it. Prefilling on
  // arrival would drop the question into the seeded conversation, which is the
  // one thing this beat is trying to teach them not to do.
  useEffect(() => {
    if (beat !== 2 || phase !== "ask") return;
    prefillComposer(script.ask);
  }, [beat, phase, script]);

  // The beat ends when the review does — the last thing this teaches is that
  // the change was never applied behind their back.
  const answered = useRef(false);
  useEffect(() => {
    if (beat !== 2) return;
    if (openReviews.length) {
      answered.current = true;
      return;
    }
    if (answered.current) advance(GATED);
  }, [beat, openReviews.length, advance]);

  /* ---- The free tail --------------------------------------------------- */

  const items = useMemo(
    (): ChecklistItem[] => [
      {
        id: "enter",
        label: "Click into the diagram",
        hint: "Both side panels turn over to it.",
      },
      { id: "move", label: "Move a shape", hint: "Connectors redraw themselves." },
      {
        id: "block",
        label: `Press / for a ${script.suggest.label.toLowerCase()}`,
        hint: script.suggest.hint,
      },
    ],
    [script],
  );
  const ticked = useMemo(() => new Set(done), [done]);
  const tick = (id: string) => {
    if (!ticked.has(id)) void check({ id }).catch(() => {});
  };

  const active = shell.active;
  useEffect(() => {
    if (beat < GATED || !active) return;
    tick("enter");
    // Identity, not equality: every op returns the same objects for the parts
    // it did not touch, so a new scene object IS an edit. The grace window is
    // for the reflow that entering a canvas can itself cause.
    const store = active.api.store;
    const entered = store.getScene();
    const opened = Date.now();
    return store.subscribe(() => {
      if (Date.now() - opened > 400 && store.getScene() !== entered) tick("move");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat, active, ticked]);

  useEffect(() => {
    if (beat < GATED || !editor) return;
    const count = () =>
      editor.document.filter((b) => b.type === script.suggest.type).length;
    // How many there were when the tail began, not whether there are any. The
    // agent's turn is asked for exactly this kind of block on several of the
    // templates, so by the time anyone reads this list one may already exist —
    // and an item that ticks itself before it has been read teaches nothing.
    const before = count();
    return editor.onChange(() => count() > before && tick("block"), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat, editor, script, ticked]);

  /* ---- What is on screen ----------------------------------------------- */

  const selector =
    beat === 0
      ? `[data-id="${script.write.blockId}"]`
      : beat === 1
        ? `[data-id="${script.draw.blockId}"]`
        : beat === 2
          ? CHAT_TARGET[phase]
          : null;
  const target = useTarget(selector);
  const rect = useRect(target, 8);

  if (beat >= GATED) {
    return (
      <Checklist
        items={items}
        done={ticked}
        onDismiss={() => void finish().catch(() => {})}
      />
    );
  }

  const copy = beat === 2 ? CHAT[phase] : BEATS[beat];

  return (
    <>
      <Spotlight rect={rect} />
      <CoachCard
        rect={rect}
        step={beat + 1}
        total={GATED}
        title={copy.title}
        action={copy.action}
        hint={copy.hint}
        onNext={() => advance(beat + 1)}
        onSkip={() => void skip().catch(() => {})}
      />
    </>
  );
}

type Copy = { title: string; action: string; hint?: string };

/**
 * One idea per beat, and the idea is never the feature.
 *
 * "Press Tab to accept an inline completion" describes a control. What a person
 * needs on their first morning is what the control is FOR, which is why each of
 * these leads with what just happened and only then says which key.
 */
const BEATS: Copy[] = [
  {
    title: "It read the page and wrote the rest of the line.",
    action: "Keep it with",
    hint: "⇥",
  },
  {
    title: "This line wanted a picture, so it is drawing one.",
    action: "Place it with",
    hint: "⇥",
  },
];

/** The last beat is four moments, not one. */
type ChatPhase = "newChat" | "ask" | "watching" | "review";

const CHAT_TARGET: Record<ChatPhase, string> = {
  newChat: '[aria-label="New chat"]',
  ask: ".nt-composer",
  // The whole rail: what is worth looking at while it works is not the box you
  // typed into, it is the running account of what it is doing above it.
  watching: 'aside[aria-label="Chat"]',
  review: ".nt-review-bar",
};

const CHAT: Record<ChatPhase, Copy> = {
  newChat: {
    title: "There is already a conversation here — chats belong to the project and outlive the page.",
    action: "Start a fresh one.",
  },
  ask: {
    title: "The agent works inside the document, not beside it.",
    action: "Send the question.",
  },
  watching: {
    title: "Everything it does shows up here — the pages it opens, the searches it runs, the edits it makes.",
    action: "Nothing is hidden, and nothing has been decided yet.",
  },
  review: {
    title: "Nothing it wrote is yours until you say so.",
    action: "Keep the change, or throw it away.",
  },
};

/** One line, one space between words — the form both sides of a comparison take. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A block's plain text, for asking whether a suggestion landed in it. */
function textOf(block: { content?: unknown } | undefined): string {
  const content = block?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((node) =>
      typeof node === "object" && node && "text" in node ? String(node.text) : "",
    )
    .join("");
}

