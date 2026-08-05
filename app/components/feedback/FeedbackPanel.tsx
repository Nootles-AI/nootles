"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import posthog from "posthog-js";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { dump } from "@/app/lib/debugRing";
import {
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
} from "@/app/lib/ai/categorize";
import { track } from "@/app/lib/telemetry";
import { Bug, Sparkles, X } from "../Icons";

const TABS = [
  { id: "issue" as const, label: "Bug report", Icon: Bug },
  { id: "wish" as const, label: "Feature request", Icon: Sparkles },
];

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  canvas: "Canvas & diagrams",
  code: "Code",
  math: "Math",
  tables: "Tables",
  autocomplete: "Autocomplete",
  chat: "Chat agent",
  editor: "Text editing",
  sharing: "Sharing",
  account: "Account & sign-in",
  general: "General / other",
};

/** Recent op kinds, deduped — the classifier's view of what was being done. */
function opKinds(): string {
  return [
    ...new Set(
      dump()
        .ops.map((o) => (o as { kind?: string }).kind)
        .filter((k): k is string => !!k),
    ),
  ].join(", ");
}

/**
 * The report form. One text field; everything else — screenshot, console
 * tail, recent ops, replay link — is gathered quietly and shown where it can
 * be removed, so what is sent is always visible.
 */
export function FeedbackPanel({
  projectId,
  pageId,
  onClose,
}: {
  projectId: Id<"projects">;
  pageId: Id<"pages"> | null;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"issue" | "wish">("issue");
  const [text, setText] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("general");
  // Once the reporter picks, the classifier stops second-guessing them.
  const pickedRef = useRef(false);
  const classifySeq = useRef(0);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [state, setState] = useState<"editing" | "sending" | "sent" | "failed">(
    "editing",
  );
  const generateUploadUrl = useMutation(api.feedback.generateUploadUrl);
  const submit = useMutation(api.feedback.submit);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // The classifier reads what the report already carries — the words as they
  // are typed, the recent op kinds, the console tail — and pre-fills the
  // select. A suggestion only: it never overrides a hand-picked value.
  useEffect(() => {
    if (pickedRef.current || text.trim().length < 12) return;
    const mySeq = ++classifySeq.current;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const consoleTail = dump()
            .console.slice(-10)
            .map((e) => `[${e.level}] ${e.message}`)
            .join("\n");
          const res = await fetch("/api/categorize", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, ops: opKinds(), consoleTail }),
          });
          if (!res.ok) return;
          const { category: guess } = (await res.json()) as {
            category: FeedbackCategory;
          };
          if (
            mySeq === classifySeq.current &&
            !pickedRef.current &&
            FEEDBACK_CATEGORIES.includes(guess)
          ) {
            setCategory(guess);
          }
        } catch {
          // A missing guess is fine; the select still works by hand.
        }
      })();
    }, 800);
    return () => clearTimeout(t);
  }, [text]);

  // The screenshot is of the state being reported — the screen as it was
  // when the form opened, scroll positions included (see capture.ts).
  // Rasterizing the whole document is heavy, so it waits for the morph to
  // land; nothing changes underneath in that time. Focus waits with it.
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    const t = setTimeout(() => {
      textRef.current?.focus({ preventScroll: true });
      void (async () => {
        try {
          const { captureViewport } = await import("./capture");
          const blob = await captureViewport();
          if (blob && alive) {
            url = URL.createObjectURL(blob);
            setShot({ blob, url });
          }
        } catch {
          // No screenshot is fine; the report still carries its other context.
        }
      })();
    }, 420);
    return () => {
      alive = false;
      clearTimeout(t);
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  const send = async () => {
    if (!text.trim() || state === "sending" || state === "sent") return;
    setState("sending");
    try {
      let screenshotStorageId: Id<"_storage"> | undefined;
      if (shot) {
        const uploadUrl = await generateUploadUrl();
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": shot.blob.type || "image/png" },
          body: shot.blob,
        });
        if (res.ok) {
          const { storageId } = (await res.json()) as {
            storageId: Id<"_storage">;
          };
          screenshotStorageId = storageId;
        }
      }
      let replayUrl: string | undefined;
      try {
        if (posthog.__loaded) {
          replayUrl = posthog.get_session_replay_url({ withTimestamp: true });
        }
      } catch {
        // Replay link is best-effort.
      }
      const context = dump();
      await submit({
        kind,
        text,
        category,
        ...(screenshotStorageId ? { screenshotStorageId } : {}),
        consoleLog: context.console
          .map((e) => `[${e.level}] ${e.message}`)
          .join("\n"),
        recentOps: context.ops,
        ...(pageId ? { pageId } : {}),
        projectId,
        ...(replayUrl ? { replayUrl } : {}),
        env: {
          ...(process.env.NEXT_PUBLIC_COMMIT_SHA
            ? { sha: process.env.NEXT_PUBLIC_COMMIT_SHA }
            : {}),
          ua: navigator.userAgent,
          viewport: `${window.innerWidth}×${window.innerHeight}`,
        },
      });
      track("feedback_submitted", { kind });
      setState("sent");
      setTimeout(onClose, 2400);
    } catch {
      setState("failed");
    }
  };

  if (state === "sent") {
    return (
      <div className="nt-feedback-sent">
        <p>Got it — Ali will see this.</p>
        <p className="nt-feedback-sent-note">
          {kind === "wish" ? "Noted as a request." : "You'll hear back."}
        </p>
      </div>
    );
  }

  return (
    <div role="dialog" aria-label="Send feedback">
      <div className="nt-feedback-tabs" role="tablist" aria-label="Feedback type">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={kind === id}
            className={`nt-feedback-tab${kind === id ? " is-on" : ""}`}
            onClick={() => setKind(id)}
          >
            <Icon width={14} height={14} />
            {label}
          </button>
        ))}
      </div>
      <div className="nt-feedback-form">
        <textarea
          ref={textRef}
          className="nt-feedback-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            kind === "issue"
              ? "What happened? Where were you?"
              : "What would make this better?"
          }
          rows={4}
        />
        <label className="nt-feedback-where">
          <span className="nt-feedback-where-label">About</span>
          <select
            className="nt-feedback-select"
            value={category}
            onChange={(e) => {
              pickedRef.current = true;
              setCategory(e.target.value as FeedbackCategory);
            }}
          >
            {FEEDBACK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <div className="nt-feedback-foot">
          {shot ? (
            <span className="nt-feedback-shot">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shot.url} alt="Screenshot to attach" />
              <button
                className="nt-feedback-shot-x"
                aria-label="Remove screenshot"
                onClick={() => setShot(null)}
              >
                <X width={12} height={12} />
              </button>
            </span>
          ) : (
            <span className="nt-feedback-noshot">No screenshot attached</span>
          )}
          <button
            className="nt-feedback-send"
            disabled={!text.trim() || state === "sending"}
            onClick={() => void send()}
          >
            {state === "sending" ? "Sending…" : "Send"}
          </button>
        </div>
        {state === "failed" && (
          <p className="nt-feedback-error">
            That didn&rsquo;t send — it&rsquo;s still here, try again.
          </p>
        )}
      </div>
    </div>
  );
}
