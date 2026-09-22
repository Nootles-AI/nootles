"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ABOUT, BACKGROUND } from "@/convex/ai/questions";
import { X } from "../Icons";

/**
 * What the user has said about the project — the two standing questions the
 * new-project dialog asks, and the entries anything else has added since.
 * Every lane's context pack starts with these, ahead of any page.
 */
export function ContextFields({ projectId }: { projectId: Id<"projects"> }) {
  const entries = useQuery(api.ai.context.list, { projectId });
  const add = useMutation(api.ai.context.add);
  const answer = useMutation(api.ai.context.answer);
  const remove = useMutation(api.ai.context.remove);

  /**
   * Write an answer to one of the standing questions, creating its row the
   * first time. A project made with only a title has no entries at all, and
   * asking someone to "add a note" before they can say what the project is
   * would be a worse form than the one they filled in to make it.
   */
  const say = (question: string, said: string) => {
    // Until the sheet has loaded there is no way to tell a new answer from an
    // edit to an existing one, and guessing wrong writes a second row saying
    // the same thing in the same words.
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

  const standing = new Set([ABOUT, BACKGROUND]);
  const also = entries?.filter((e) => !standing.has(e.question)) ?? [];

  return (
    <div>
      <Field
        id="ctx-about"
        label="Description"
        question={ABOUT}
        value={entries?.find((e) => e.question === ABOUT)?.answer ?? ""}
        placeholder="One line on what it is"
        onCommit={say}
      />
      <Field
        id="ctx-background"
        label="Context"
        question={BACKGROUND}
        value={entries?.find((e) => e.question === BACKGROUND)?.answer ?? ""}
        placeholder="Who it is for, what has been decided, anything to take as given"
        multiline
        onCommit={say}
      />

      {also.length > 0 && (
        <div className="mt-4">
          <div className="nt-field-label">
            Also noted
            <span className="nt-field-note">{also.length}</span>
          </div>
          <ul className="space-y-2">
            {also.map((entry) => (
              <li key={entry._id} className="nt-repo items-start">
                <span className="nt-repo-body">
                  <span className="nt-repo-note">{entry.question}</span>
                  <span className="block text-[13px] leading-snug">
                    {entry.answer || "—"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void remove({ id: entry._id })}
                  aria-label={`Remove “${entry.question}”`}
                  title="Remove"
                  className="nt-icon-btn is-sm"
                >
                  <X />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
  multiline,
  onCommit,
}: {
  id: string;
  label: string;
  question: string;
  value: string;
  placeholder: string;
  multiline?: boolean;
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
      {multiline ? (
        <textarea {...props} rows={6} spellCheck />
      ) : (
        <input {...props} autoComplete="off" />
      )}
    </>
  );
}
