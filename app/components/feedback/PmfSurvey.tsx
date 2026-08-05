"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { track } from "@/app/lib/telemetry";
import { X } from "../Icons";

const WAIT_MS = 3 * 24 * 60 * 60 * 1000;

/** Read at module load — "old enough" does not change mid-session. */
const LOADED_AT = Date.now();

const ANSWERS = ["Very disappointed", "Somewhat disappointed", "Not disappointed"];

/**
 * The one PMF question, asked once ever: after three days, and only of
 * someone who has actually used the AI (≥1 accepted suggestion). Any answer
 * or a dismissal retires it for good, server-side, across devices.
 */
export function PmfSurvey() {
  const profile = useQuery(api.profiles.get, {});
  const hasAccepted = useQuery(api.ai.suggestions.hasAccepted, {});
  const seen = useQuery(api.surveys.seen, { survey: "pmf" });
  const answer = useMutation(api.surveys.answer);
  const [gone, setGone] = useState(false);

  const due =
    !gone &&
    seen === false &&
    hasAccepted === true &&
    !!profile &&
    LOADED_AT - profile.createdAt > WAIT_MS;
  if (!due) return null;

  const settle = (choice: string | null) => {
    setGone(true);
    void answer({
      survey: "pmf",
      ...(choice ? { answer: choice } : {}),
      dismissed: choice === null,
    }).catch(() => {});
    track("survey_answered", { survey: "pmf", answered: choice !== null });
  };

  return (
    <div className="nt-pmf" role="dialog" aria-label="One quick question">
      <div className="nt-pmf-head">
        <p>How would you feel if you could no longer use Nootles?</p>
        <button
          className="nt-pmf-x"
          aria-label="Dismiss"
          onClick={() => settle(null)}
        >
          <X width={12} height={12} />
        </button>
      </div>
      <div className="nt-pmf-choices">
        {ANSWERS.map((a) => (
          <button key={a} className="nt-pmf-chip" onClick={() => settle(a)}>
            {a}
          </button>
        ))}
      </div>
    </div>
  );
}
