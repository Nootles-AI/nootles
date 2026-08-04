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
import {
  pacedMarkup,
  pacedStream,
  setCompletionSource,
} from "@/app/lib/ai/scriptedSource";
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
    />
  );
}

function Running({
  beat,
  done,
  template,
  pageId,
}: {
  beat: number;
  done: string[];
  template: Template;
  pageId: Id<"pages">;
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

  /* ---- Beats 0 and 1: the scripted lanes ------------------------------- */

  useEffect(() => {
    if (beat > 1) {
      setCompletionSource(null);
      return;
    }
    const seed = seedText(template, beat === 0 ? script.write.blockId : script.draw.blockId);
    setCompletionSource((req) => {
      if (req.lane === "diagram") {
        return beat === 1 ? pacedMarkup(script.draw.html) : null;
      }
      // Only while the line is still the one we wrote. Someone who has taken
      // the sentence somewhere of their own gets the real model, which is the
      // honest answer — a canned ending to a sentence they changed would be
      // the one moment in this flow that reads as a puppet show.
      if (!stillSeeded(req.before, seed)) return null;
      return beat === 0
        ? pacedStream(script.write.ghost)
        : pacedStream(`<nt-build-diagram>${script.draw.brief}</nt-build-diagram>`);
    });
    return () => setCompletionSource(null);
  }, [beat, script, template]);

  // Put the caret where the suggestion belongs. Moving it is itself what asks
  // for a completion — `useTabCompletion` schedules on selection as well as on
  // change — so this is the whole of "start the beat".
  useEffect(() => {
    if (!editor || beat > 1) return;
    const id = beat === 0 ? script.write.blockId : script.draw.blockId;
    const block = editor.document.find((b) => b.id === id);
    if (!block) return;
    editor.focus();
    editor.setTextCursorPosition(block, "end");
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

  useEffect(() => {
    if (beat !== 2) return;
    panels?.openChat();
    prefillComposer(script.ask);
  }, [beat, panels, script]);

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
          ? ".nt-composer"
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

  const reviewing = beat === 2 && openReviews.length > 0;
  const copy = reviewing ? REVIEWING : BEATS[beat];

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
  {
    title: "The agent works inside the document, not beside it.",
    action: "Send the question.",
  },
];

const REVIEWING: Copy = {
  title: "Nothing it wrote is yours until you say so.",
  action: "Keep the change, or throw it away.",
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

/** What the template put in that block, before anybody touched it. */
function seedText(template: Template, blockId: string): string {
  for (const page of template.pages) {
    for (const block of page.blocks) {
      if (block.id === blockId && typeof block.content === "string") {
        return block.content;
      }
    }
  }
  return "";
}

/**
 * Whether the caret still sits at the end of the sentence we seeded.
 *
 * The prefix arrives as the document's own markup with id markers in it, so
 * both are stripped before the comparison — what is being asked is about the
 * words, and only the last of them.
 */
function stillSeeded(before: string, seed: string): boolean {
  if (!seed) return false;
  const text = flat(before.replace(/<[^>]*>/g, "").replace(/⟦[^⟧]*⟧/g, ""));
  return text.endsWith(flat(seed));
}
