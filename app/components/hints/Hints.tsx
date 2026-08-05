"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  useEditorRegistry,
  type LiveEditor,
} from "@/app/components/editor/EditorRegistry";
import {
  setEditorHints,
  type EditorHint,
} from "@/app/components/editor/ai/hintText";
import { clearSuggestion, setGhost } from "@/app/components/editor/ai/ghostText";
import { reveal, suspendCompletions } from "@/app/lib/ai/tourDrive";
import { clearPrefill, prefillComposer } from "@/app/lib/ai/chat/prefill";
import { templateById } from "@/app/lib/onboarding/templates";
import type { Template } from "@/app/lib/onboarding/types";
import { useHints } from "./useHints";

const SLASH_HINT = "Type / for headings, tables, diagrams";

/**
 * The editor's first-touch hints, played over the seeded first project.
 *
 * There is no tour here: nothing is gated, nothing floats over the app, and
 * the order of lessons is whatever order the user reads the seeded page in.
 * This component renders nothing itself — it feeds the editor's hint plugin,
 * plays the one scripted completion, and retires each hint the moment its
 * lesson has been done for real.
 */
export function Hints({
  projectId,
  pageId,
}: {
  projectId: Id<"projects">;
  pageId: Id<"pages"> | null;
}) {
  const { profile } = useHints();
  const seed = profile?.status === "touring" ? profile.seed : undefined;
  const template = seed ? templateById(seed.template) : null;

  if (!seed || !template || seed.projectId !== projectId || !pageId) return null;
  return <Running template={template} projectId={projectId} pageId={pageId} />;
}

function Running({
  template,
  projectId,
  pageId,
}: {
  template: Template;
  projectId: Id<"projects">;
  pageId: Id<"pages">;
}) {
  const { alive, die } = useHints();
  const registry = useEditorRegistry();
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
   * What the hint plugin is currently showing, owned imperatively.
   *
   * The plugin draws straight from ProseMirror state, so nothing here needs a
   * re-render — each effect adds or removes its own entry and pushes the set.
   */
  const entries = useRef(new Map<string, EditorHint>());
  const sync = useCallback(() => {
    const view = editor?.prosemirrorView;
    if (view) setEditorHints(view, [...entries.current.values()]);
  }, [editor]);

  /* ---- Slash: the empty seeded line says what it is for ----------------- */

  const slashAlive = alive("slash");
  useEffect(() => {
    if (!editor || !slashAlive) return;
    const map = entries.current;
    map.set("slash", {
      blockId: "nt-hint-slash",
      text: SLASH_HINT,
      onlyEmpty: true,
    });
    sync();
    return () => {
      map.delete("slash");
      sync();
    };
  }, [editor, slashAlive, sync]);

  // The lesson is learned when a heading exists that did not before — made
  // through the menu the hint names, wherever they happened to be.
  useEffect(() => {
    if (!editor || !slashAlive) return;
    const count = () =>
      editor.document.filter((b) => b.type === "heading").length;
    const before = count();
    return editor.onChange(() => count() > before && die("slash"), false);
  }, [editor, slashAlive, die]);

  /* ---- Write: the hanging sentence finishes itself ---------------------- */

  const writeAlive = alive("write");
  const seedLead = useMemo(
    () => seedTextOf(template, script.write.blockId),
    [template, script],
  );

  /**
   * Armed when the caret sits at the end of the still-untouched hanging
   * sentence — the one position where "finish this line" is what the user is
   * plainly about to do. Never armed by force: the guide does not move the
   * caret, so the completion happens because they went there.
   */
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!editor || !writeAlive) return;
    const judge = () => {
      const view = editor.prosemirrorView;
      if (!view) return;
      const sel = view.state.selection;
      const atEnd =
        sel.empty && sel.$from.parentOffset === sel.$from.parent.content.size;
      let inBlock = false;
      try {
        inBlock = editor.getTextCursorPosition().block.id === script.write.blockId;
      } catch {
        inBlock = false;
      }
      const pristine =
        flat(textOf(editor.document.find((b) => b.id === script.write.blockId))) ===
        flat(seedLead);
      setArmed(atEnd && inBlock && pristine);
    };
    const offSel = editor.onSelectionChange(judge, false);
    const offDoc = editor.onChange(judge, false);
    return () => {
      offSel?.();
      offDoc?.();
    };
  }, [editor, writeAlive, script, seedLead]);

  useEffect(() => {
    if (!editor || !armed || !writeAlive) return;
    const view = editor.prosemirrorView;
    if (!view) return;
    const map = entries.current;

    // The real lane pauses while the scripted finish is on: two authors in one
    // suggestion slot is the collision that would make the lesson unreadable.
    suspendCompletions(true);
    const stop = reveal(script.write.ghost, (sofar, done) => {
      setGhost(view, sofar, !done);
      if (done) {
        // The one place first run says which key: a chip at the end of the
        // line, in the same voice every other "press Tab" in the app uses.
        map.set("write-key", {
          blockId: script.write.blockId,
          kbd: "Tab",
        });
        sync();
      }
    });

    // Escape is a verdict, not a glance away: they saw the suggestion and
    // declined it, so the hint is over. Capture phase, because the editor
    // consumes the key to dismiss the suggestion itself.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") die("write");
    };
    document.addEventListener("keydown", onKey, true);

    return () => {
      stop();
      document.removeEventListener("keydown", onKey, true);
      map.delete("write-key");
      sync();
      clearSuggestion(view);
      suspendCompletions(false);
    };
  }, [editor, armed, writeAlive, script, sync, die]);

  // Accepted: the sentence now contains its ending, however Tab landed it.
  useEffect(() => {
    if (!editor || !writeAlive) return;
    const landed = () =>
      flat(
        textOf(editor.document.find((b) => b.id === script.write.blockId)),
      ).includes(flat(script.write.ghost));
    return editor.onChange(() => landed() && die("write"), false);
  }, [editor, writeAlive, script, die]);

  /* ---- Chat: the question waits in the composer ------------------------- */

  const chatAlive = alive("chat");
  const threads = useQuery(api.chat.threads.list, { projectId });

  // Drafted early and held by the prefill store until the composer mounts —
  // whenever they open the chat, the question the page promised is sitting
  // there, editable like anything else they might have typed.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!chatAlive || prefilled.current) return;
    prefilled.current = true;
    prefillComposer(script.ask);
  }, [chatAlive, script]);

  // A thread whose updatedAt has moved past its createdAt has been spoken in —
  // the seeded conversation arrives with the two equal, and every sent message
  // bumps it. That first real message is the lesson.
  useEffect(() => {
    if (!chatAlive || !threads) return;
    if (threads.some((t) => t.updatedAt > t.createdAt)) {
      die("chat");
      clearPrefill();
    }
  }, [chatAlive, threads, die]);

  return null;
}

/** One line, one space between words — the form both sides of a comparison take. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A block's plain text, for asking whether the suggestion landed in it. */
function textOf(block: { content?: unknown } | undefined): string {
  const content = block?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((node) =>
      typeof node === "object" && node && "text" in node ? String(node.text) : "",
    )
    .join("");
}

/** What a template wrote into one of its blocks, before anybody touched it. */
function seedTextOf(template: Template, blockId: string): string {
  for (const page of template.pages) {
    for (const block of page.blocks) {
      if (block.id === blockId && typeof block.content === "string") {
        return block.content;
      }
    }
  }
  return "";
}
