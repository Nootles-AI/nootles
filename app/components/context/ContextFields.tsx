"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ABOUT } from "@/convex/ai/questions";

/**
 * The one thing about a project still typed rather than sourced: a line on
 * what it is. Everything else the assistant knows comes in through the
 * context sources (`ContextSources`) — including anything written freehand
 * before there were sources, which shows there as a note card.
 */
export function ContextFields({ projectId }: { projectId: Id<"projects"> }) {
  const entries = useQuery(api.ai.context.list, { projectId });
  const add = useMutation(api.ai.context.add);
  const answer = useMutation(api.ai.context.answer);
  const remove = useMutation(api.ai.context.remove);

  /**
   * Write the description, creating its row the first time. Until the sheet
   * has loaded there is no way to tell a new answer from an edit, and guessing
   * wrong writes a second row saying the same thing in the same words.
   */
  const say = (question: string, said: string) => {
    if (!entries) return;
    const existing = entries.find((e) => e.question === question);
    const value = said.trim();
    if (existing) {
      if ((existing.answer ?? "") === value) return;
      if (value) void answer({ id: existing._id, answer: value });
      else void remove({ id: existing._id });
    } else if (value) {
      void add({ projectId, question, answer: value, source: "human" });
    }
  };

  return (
    <Field
      id="ctx-about"
      label="Description"
      question={ABOUT}
      value={entries?.find((e) => e.question === ABOUT)?.answer ?? ""}
      placeholder="One line on what it is"
      onCommit={say}
    />
  );
}

/**
 * A standing question, drawn as the field it was originally asked as.
 *
 * Held locally while it is being typed and written on blur, the way the rest of
 * the app treats a name being edited — a mutation per keystroke would be a
 * write per keystroke, and this is the one form where what you type IS what the
 * model reads.
 */
function Field({
  id,
  label,
  question,
  value,
  placeholder,
  onCommit,
}: {
  id: string;
  label: string;
  question: string;
  value: string;
  placeholder: string;
  onCommit: (question: string, said: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const props = {
    id,
    value: shown,
    placeholder,
    className: "nt-input",
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      onCommit(question, shown);
      setDraft(null);
    },
  };

  return (
    <>
      <label className="nt-field-label mt-4 first:mt-0" htmlFor={id}>
        {label}
      </label>
      <input {...props} autoComplete="off" />
    </>
  );
}
