"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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

import { ORIENT, SLASH, WRITE, CHAT, CANVAS, GATED } from "./beats";

/** The block the templates leave empty for the slash beat to fill. */
const SLASH_BLOCK = "nt-tour-slash";

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
  /**
   * Moved locally first, then confirmed.
   *
   * The beat is read back off the profile, so without this every step waits a
   * round trip before it acknowledges — and the frame it waits is the frame the
   * user has just succeeded in. Landing the diagram would clear the preview the
   * spotlight was holding, drop the scrim, and leave the card still asking for
   * the thing that had already happened. The step it advances to is unchanged;
   * only the lag before saying so is.
   */
  const setBeat = useMutation(api.profiles.setBeat).withOptimisticUpdate(
    (store, args) => {
      const profile = store.getQuery(api.profiles.get, {});
      if (!profile?.tour) return;
      store.setQuery(
        api.profiles.get,
        {},
        { ...profile, tour: { ...profile.tour, beat: args.beat } },
      );
    },
  );
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

  /* ---- Beat 0: the project, its pages, the way home --------------------- */

  const pages = useQuery(api.pages.listByProject, { projectId });
  const ordered = useMemo(
    () => pages?.slice().sort((a, b) => a.order - b.order),
    [pages],
  );
  // The tour's scripted blocks live in the template's first page; the second
  // exists so "a project holds pages" is something to see rather than believe.
  const first = ordered?.[0];
  const second = ordered?.[1];

  /**
   * Whether the user has been to the second page yet.
   *
   * State rather than a ref because the coach card reads it: the render in
   * which they arrive on the second page is the render its copy has to turn
   * over from "open it" to "head back". Latched during render — the sanctioned
   * pattern for state that follows a prop — because this is history, not a
   * derivation: nothing on screen says where they have already been.
   */
  const [went, setWent] = useState(false);
  if (beat === ORIENT && second && pageId === second._id && !went) setWent(true);

  useEffect(() => {
    if (beat !== ORIENT || !ordered) return;
    // A project someone has trimmed to one page has no round trip to make.
    if (ordered.length < 2) {
      advance(SLASH);
      return;
    }
    if (went && pageId === ordered[0]._id) advance(SLASH);
  }, [beat, ordered, went, pageId, advance]);

  /** The editor beats all happen on the first page; elsewhere, point home. */
  const offPage = Boolean(first && pageId !== first._id);

  /* ---- Slash, write and draw: the guide runs them itself ---------------- */

  // No model is called while the guide is driving: the scripted ghost text
  // writes into the same plugin a real completion would, and two authors in
  // one buffer is the one collision that would make the lesson unreadable.
  //
  // It stops at the tail, which is the point the user is working in their own
  // document. Tying it to the component's lifetime instead left the lane dead
  // until someone dismissed the checklist — and since that X is the only thing
  // that ever calls `finish`, anyone who left it up lost inline completion for
  // good, across reloads, having just been asked to choose how much of it they
  // wanted.
  const gated = beat < GATED;
  useEffect(() => {
    if (!gated) return;
    suspendCompletions(true);
    return () => suspendCompletions(false);
  }, [gated]);

  /**
   * Whether a drawn diagram exists on the open page.
   *
   * This is what splits the canvas beat into its two halves — no diagram means
   * one is being drawn and Tab places it; a diagram means the lesson is that
   * it can be entered and dragged. Read through a subscription because the
   * document is not React state: the render after the diagram lands is the
   * render the card has to turn over on.
   */
  const subscribeDoc = useCallback(
    (onDocChange: () => void) => {
      if (!editor) return () => {};
      const off = editor.onChange(onDocChange, false);
      return () => off?.();
    },
    [editor],
  );
  const drew = useSyncExternalStore(
    subscribeDoc,
    () => (editor ? drawnIn(editor) : false),
    () => false,
  );

  /**
   * Put the caret where the suggestion belongs, then write the suggestion.
   *
   * Straight into the same plugin the completion lane writes into, so `Tab` is
   * handled by `acceptSuggestion` exactly as it always is — ghost text inserts
   * itself, and an action with no batch calls `onAccept`. Nothing downstream
   * knows or cares that no model was involved.
   */
  useEffect(() => {
    if (!editor) return;
    const draw = beat === CANVAS && !drew;
    if (beat !== SLASH && beat !== WRITE && !draw) return;
    const view = editor.prosemirrorView;
    if (!view) return;

    const target =
      beat === SLASH
        ? SLASH_BLOCK
        : draw
          ? script.draw.blockId
          : script.write.blockId;
    const block = editor.document.find((b) => b.id === target);
    if (!block) return;

    editor.focus();
    editor.setTextCursorPosition(block, "end");

    // The slash beat has nothing to draw: the menu is the product's, and the
    // whole point is that they open it themselves.
    if (beat === SLASH) return;

    /**
     * Keep the drawing on screen while it is being drawn.
     *
     * The preview is a widget UNDER the caret, and it grows a line at a time —
     * so on a short viewport it walks off the bottom of the window while the
     * user is watching it, which reads exactly like the suggestion being
     * withdrawn. It was never withdrawn; it left.
     *
     * Centred on first sight and then left alone unless it drifts out, with a
     * floor between scrolls: a diagram taller than the window is never fully in
     * view, and re-centring it on every line would be a scroll that never
     * settles.
     */
    let lastScroll = 0;
    const follow = () => {
      requestAnimationFrame(() => {
        const el = document.querySelector(".nt-diagram-preview");
        if (!el) return;
        const box = el.getBoundingClientRect();
        const settled = box.top >= 0 && box.bottom <= window.innerHeight;
        const now = performance.now();
        if (lastScroll && (settled || now - lastScroll < 450)) return;
        lastScroll = now;
        el.scrollIntoView({
          block: "center",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
      });
    };

    const stop = draw
      ? reveal(
          script.draw.html,
          (sofar, done) => {
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
            });
            follow();
          },
          { stepMs: 70, chunk: lineish },
        )
      : reveal(script.write.ghost, (sofar, done) =>
          setGhost(view, sofar, !done),
        );

    return () => {
      stop();
      clearSuggestion(view);
    };
  }, [editor, beat, drew, script]);

  /**
   * Advance on the real outcome, never on the keypress.
   *
   * What ends a beat is the document having changed in the way the beat was
   * about — a heading that exists, a sentence that got finished. Watching for
   * the key instead would let a step be "completed" by someone who pressed it
   * with nothing selected. The canvas beat is absent here on purpose: its two
   * halves turn over on `drew`, and it ends when a shape moves.
   */
  useEffect(() => {
    if (!editor) return;
    if (beat !== SLASH && beat !== WRITE) return;

    const headings = () =>
      editor.document.filter((b) => b.type === "heading").length;
    const headingsBefore = headings();

    const landed = () => {
      if (beat === SLASH) return headings() > headingsBefore;
      // Compared loosely on whitespace: a line break landing differently is
      // not a different sentence.
      return flat(
        textOf(editor.document.find((b) => b.id === script.write.blockId)),
      ).includes(flat(script.write.ghost));
    };

    if (landed()) {
      advance(beat + 1);
      return;
    }
    return editor.onChange(() => landed() && advance(beat + 1), false);
  }, [editor, beat, script, advance]);

  /**
   * The canvas beat ends when a shape moves.
   *
   * Identity, not equality: every op returns the same objects for the parts it
   * did not touch, so a new scene object IS an edit. The grace window covers
   * the reflow that entering a canvas can cause on its own, which would
   * otherwise tick the beat before the user had touched anything.
   */
  const active = shell.active;
  useEffect(() => {
    if (beat !== CANVAS || !drew || !active) return;
    const store = active.api.store;
    const entered = store.getScene();
    const opened = performance.now();
    return store.subscribe(() => {
      if (performance.now() - opened > 500 && store.getScene() !== entered) {
        advance(beat + 1);
      }
    });
  }, [beat, drew, active, advance]);

  /* ---- Beat 3: the agent, and answering for it ------------------------- */

  /**
   * Where the chat beat has got to.
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
    if (beat !== CHAT) return;
    panels?.openChat();
  }, [beat, panels]);

  // Written only once they have somewhere of their own to put it. Prefilling on
  // arrival would drop the question into the seeded conversation, which is the
  // one thing this beat is trying to teach them not to do.
  //
  // Latched, like `advance` is, because `phase` is derived and comes back: the
  // moment the review is answered it falls from "review" to "ask" while the
  // beat is still catching up, and an unlatched effect takes that as its cue to
  // type the question they have just had answered back over whatever they had
  // started writing.
  const prefilled = useRef(false);
  useEffect(() => {
    if (beat !== CHAT || phase !== "ask" || prefilled.current) return;
    prefilled.current = true;
    prefillComposer(script.ask);
  }, [beat, phase, script]);

  // The beat ends when the review does — the last thing this teaches is that
  // the change was never applied behind their back.
  const answered = useRef(false);
  useEffect(() => {
    if (beat !== CHAT) return;
    if (openReviews.length) {
      answered.current = true;
      return;
    }
    if (answered.current) advance(beat + 1);
  }, [beat, openReviews.length, advance]);

  /* ---- The free tail --------------------------------------------------- */

  const items = useMemo(
    (): ChecklistItem[] => [
      {
        id: "block",
        label: `Press / for a ${script.suggest.label.toLowerCase()}`,
        hint: script.suggest.hint,
      },
      {
        id: "page",
        label: "Start another page",
        hint: "The + beside Pages in the sidebar.",
      },
      {
        id: "projects",
        label: "Visit the Projects screen",
        hint: "The Projects link, top left, lists every project you have.",
      },
    ],
    [script],
  );
  const ticked = useMemo(() => new Set(done), [done]);
  const tick = (id: string) => {
    if (!ticked.has(id)) void check({ id }).catch(() => {});
  };

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

  const pageCount = pages?.length ?? 0;
  const seededPages = template.pages.length;
  useEffect(() => {
    if (beat >= GATED && pageCount > seededPages) tick("page");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat, pageCount, seededPages, ticked]);

  /**
   * Take the guide's own scaffolding back out on the way out.
   *
   * The slash beat needs somewhere to point, so the templates seed an empty
   * paragraph for it. Taught, it becomes the heading the user makes; skipped,
   * it is a blank block sitting in the middle of the first document they own,
   * and they have no way of knowing it was ever for anything.
   *
   * Only ever removes a paragraph that is still empty, so a heading made in it
   * — the thing the beat was asking for — is never what gets deleted.
   */
  const tidy = () => {
    const block = editor?.document.find((b) => b.id === SLASH_BLOCK);
    if (!editor || !block) return;
    if (block.type !== "paragraph" || textOf(block).trim()) return;
    editor.removeBlocks([block]);
  };

  const leave = () => {
    tidy();
    void skip().catch(() => {});
  };

  const close = () => {
    tidy();
    void finish().catch(() => {});
  };

  /* ---- What is on screen ----------------------------------------------- */

  const row = (page: { _id: Id<"pages"> } | undefined) =>
    page ? `[data-page-id="${page._id}"]` : null;

  const selector =
    beat === ORIENT
      ? went
        ? row(first)
        : row(second)
      : beat === CHAT
        ? CHAT_TARGET[phase]
        : offPage
          ? row(first)
          : beat === SLASH
            ? `[data-id="${SLASH_BLOCK}"]`
            : beat === WRITE
              ? `[data-id="${script.write.blockId}"]`
              : beat === CANVAS
                ? drew
                  ? ".nt-canvas"
                  : `[data-id="${script.draw.blockId}"]`
                : null;
  // While a diagram is being drawn, the drawing IS the subject — lighting the
  // line above it would leave the spotlight pointing at the caret while the
  // thing worth looking at grows underneath, unlit and off the bottom.
  const drawing = useTarget(
    beat === CANVAS && !drew && !offPage ? ".nt-diagram-preview" : null,
  );
  const anchor = useTarget(selector);
  const rect = useRect(drawing ?? anchor, 8);

  if (beat >= GATED) {
    return <Checklist items={items} done={ticked} drew={drew} onDismiss={close} />;
  }

  const copy: Copy =
    beat === ORIENT
      ? went
        ? {
            title: "Same project, different page — each page is its own document.",
            action: `Head back to “${first?.title || "Untitled"}” for the rest of the guide.`,
          }
        : {
            title:
              "This is a project. The sidebar lists its pages, and Projects — top left — leads back to all of your projects.",
            action: `Open “${second?.title || "Untitled"}”.`,
          }
      : beat === CHAT
        ? CHAT_COPY[phase]
        : offPage
          ? {
              title: `The next step is on “${first?.title || "Untitled"}”.`,
              action: "Open it in the sidebar.",
            }
          : beat === CANVAS
            ? drew
              ? DRAG_COPY
              : DRAW_COPY
            : beat === SLASH
              ? SLASH_COPY
              : WRITE_COPY;

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
        onSkip={leave}
      />
    </>
  );
}

type Copy = { title: string; action: string; hint?: string };

/**
 * One idea per beat, said plainly.
 *
 * Each card leads with what the user is looking at and only then says what to
 * do about it. The orientation and off-page cards are built inline because
 * they name real page titles; these four never change.
 */
const SLASH_COPY: Copy = {
  title:
    "Every block starts from the slash menu — headings, tables, code, diagrams.",
  action: "Type / here, then h2 to add a heading.",
};

const WRITE_COPY: Copy = {
  title: "The editor read the page and wrote an ending for this line.",
  action: "Keep it with",
  hint: "⇥",
};

const DRAW_COPY: Copy = {
  title: "This line asked for a diagram, so the editor is drawing one.",
  action: "Place it with",
  hint: "⇥",
};

const DRAG_COPY: Copy = {
  // The rails turn over when the canvas is entered, not when it lands — and
  // this half cannot end until it is entered either, since what it waits for
  // is a shape moving. So the sentence asks for the click rather than
  // describing a screen the reader is not looking at yet.
  title:
    "That is a real canvas, not an image. Click into it — layers open on the left, the shape's properties on the right.",
  action: "Drag a box and the connectors follow.",
};

/** The chat beat is four moments, not one. */
type ChatPhase = "newChat" | "ask" | "watching" | "review";

const CHAT_TARGET: Record<ChatPhase, string> = {
  newChat: '[aria-label="New chat"]',
  ask: ".nt-composer",
  // The whole rail: what is worth looking at while it works is not the box you
  // typed into, it is the running account of what it is doing above it.
  watching: 'aside[aria-label="Chat"]',
  review: ".nt-review-bar",
};

const CHAT_COPY: Record<ChatPhase, Copy> = {
  newChat: {
    title:
      "There is already a conversation here — chats belong to the project, so they stay when you switch pages.",
    action: "Start a fresh one.",
  },
  ask: {
    title: "The agent edits the document itself, not just the chat.",
    action: "Send the question.",
  },
  watching: {
    title:
      "Everything it does shows up here — the pages it opens, the searches it runs, the edits it makes.",
    action: "Nothing is applied until you approve it.",
  },
  review: {
    title: "The agent's change is waiting on you — nothing is applied yet.",
    action: "Keep the change, or throw it away.",
  },
};

/** Whether a drawn diagram exists — a canvas block starts life with `data: ""`. */
const drawnIn = (editor: LiveEditor): boolean =>
  editor.document.some(
    (b) => b.type === "canvas" && Boolean((b.props as { data?: string })?.data),
  );

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
