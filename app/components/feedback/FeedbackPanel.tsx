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
  // "" is the unselected placeholder; sending requires a real value.
  const [category, setCategory] = useState<FeedbackCategory | "">("");
  const [classifying, setClassifying] = useState(false);
  const [picked, setPicked] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [ghost, setGhost] = useState<string | null>(null);
  // Once the reporter picks, the classifier stops second-guessing them.
  const pickedRef = useRef(false);
  const classifySeq = useRef(0);
  const ghostSeq = useRef(0);
  const mirrorRef = useRef<HTMLDivElement>(null);
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
        setClassifying(true);
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
        } finally {
          if (mySeq === classifySeq.current) setClassifying(false);
        }
      })();
    }, 800);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => setNudge(false), 2500);
    return () => clearTimeout(t);
  }, [nudge]);

  // Ghost completion for the draft itself, from the same context the report
  // carries. Tab accepts; typing or Escape discards; empty answers are fine.
  useEffect(() => {
    if (text.trim().length < 8) return;
    const mySeq = ++ghostSeq.current;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const consoleTail = dump()
            .console.slice(-10)
            .map((e) => `[${e.level}] ${e.message}`)
            .join("\n");
          const res = await fetch("/api/feedback-complete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, kind, ops: opKinds(), consoleTail }),
          });
          if (!res.ok) return;
          const { completion } = (await res.json()) as { completion: string };
          if (mySeq === ghostSeq.current && completion) setGhost(completion);
        } catch {
          // No ghost is the ordinary case, not a failure.
        }
      })();
    }, 700);
    return () => clearTimeout(t);
  }, [text, kind]);

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
        } catch (error) {
          // No screenshot is fine — but the ticket should say why: this lands
          // in the console ring, which submits with the report.
          console.warn("[Nootles] screenshot capture failed", error);
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
    if (!category) {
      setNudge(true);
      return;
    }
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
        category: category as FeedbackCategory,
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
        <div className="nt-feedback-input">
          <div ref={mirrorRef} className="nt-feedback-mirror" aria-hidden>
            <span>{text}</span>
            {ghost && <span className="nt-feedback-ghost">{ghost}</span>}
          </div>
          <textarea
            ref={textRef}
            className="nt-feedback-text"
            value={text}
            onChange={(e) => {
              setGhost(null);
              setText(e.target.value);
            }}
            onScroll={(e) => {
              if (mirrorRef.current) {
                mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
              }
            }}
            onKeyDown={(e) => {
              if (!ghost) return;
              if (e.key === "Tab") {
                e.preventDefault();
                setText(text + ghost);
                setGhost(null);
              } else if (e.key === "Escape") {
                // Dismisses the ghost only — the panel's own document-level
                // Escape listener runs after React's dispatch on the same
                // node, so it has to be silenced here or the box closes too.
                e.nativeEvent.stopImmediatePropagation();
                setGhost(null);
              }
            }}
            placeholder={
              kind === "issue"
                ? "What happened? Where were you?"
                : "What would make this better?"
            }
            rows={4}
          />
        </div>
        <label className="nt-feedback-where">
          <span className="nt-feedback-where-label">About</span>
          <span className="nt-feedback-selectwrap">
            <select
              className="nt-feedback-select"
              value={category}
              onPointerDown={() => {
                // Opening the menu is already an override: the dots yield.
                pickedRef.current = true;
                setPicked(true);
              }}
              onChange={(e) => {
                pickedRef.current = true;
                setPicked(true);
                setCategory(e.target.value as FeedbackCategory | "");
              }}
            >
              <option value="" disabled>
                Select category…
              </option>
              {FEEDBACK_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
            {classifying && !picked && (
              <span className="nt-feedback-dots" aria-label="Suggesting a category">
                <span />
                <span />
                <span />
              </span>
            )}
          </span>
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
            aria-disabled={!category || !text.trim()}
            data-gated={!category || undefined}
            onClick={() => void send()}
          >
            {state === "sending" ? "Sending…" : "Send"}
          </button>
        </div>
        {nudge && <p className="nt-feedback-error">Pick a category first.</p>}
        {state === "failed" && (
          <p className="nt-feedback-error">
            That didn&rsquo;t send — it&rsquo;s still here, try again.
          </p>
        )}
      </div>
    </div>
  );
}
