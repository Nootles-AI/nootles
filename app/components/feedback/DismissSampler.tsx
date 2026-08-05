"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { track } from "@/app/lib/telemetry";
import { onSampleDue } from "./sampler";

const REASONS = ["Wrong", "Too early", "Meh"];

/**
 * After every ~15th dismissed suggestion: one line, three chips, gone in 8s.
 * Labeled rejections are the cheapest training signal there is, and this is
 * the only place they can be asked for without interrupting anyone.
 */
export function DismissSampler() {
  const [open, setOpen] = useState(false);
  const answer = useMutation(api.surveys.answer);

  useEffect(() => {
    onSampleDue(() => setOpen(true));
    return () => onSampleDue(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), 8000);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const pick = (reason: string) => {
    setOpen(false);
    void answer({
      survey: "dismiss_reason",
      answer: reason,
      dismissed: false,
    }).catch(() => {});
    track("survey_answered", { survey: "dismiss_reason", answered: true });
  };

  return (
    <div className="nt-sampler" role="status">
      <span className="nt-sampler-q">Skipping the suggestions — why?</span>
      {REASONS.map((r) => (
        <button key={r} className="nt-sampler-chip" onClick={() => pick(r)}>
          {r}
        </button>
      ))}
    </div>
  );
}
