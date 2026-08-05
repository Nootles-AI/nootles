"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import posthog from "posthog-js";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { dump } from "@/app/lib/debugRing";
import { track } from "@/app/lib/telemetry";
import { Segmented } from "../Segmented";
import { X } from "../Icons";

const KINDS = [
  {
    id: "issue" as const,
    label: "Something's off",
    hint: "A bug, a glitch, something confusing",
  },
  {
    id: "wish" as const,
    label: "I wish…",
    hint: "A feature or change you'd want",
  },
];

/**
 * The report panel. One text field; everything else — screenshot, console
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
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [state, setState] = useState<"editing" | "sending" | "sent" | "failed">(
    "editing",
  );
  const generateUploadUrl = useMutation(api.feedback.generateUploadUrl);
  const submit = useMutation(api.feedback.submit);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // The screenshot is taken as the panel opens — the state being reported is
  // the one on screen right now. The panel excludes itself via the filter.
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    void (async () => {
      try {
        const { toBlob } = await import("html-to-image");
        const blob = await toBlob(document.body, {
          pixelRatio: 1,
          filter: (node) =>
            !(node instanceof HTMLElement && node.dataset.ntFeedback !== undefined),
        });
        if (blob && alive) {
          url = URL.createObjectURL(blob);
          setShot({ blob, url });
        }
      } catch {
        // No screenshot is fine; the report still carries its other context.
      }
    })();
    textRef.current?.focus();
    return () => {
      alive = false;
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

  return (
    <div
      className="nt-feedback-panel"
      data-nt-feedback
      role="dialog"
      aria-label="Send feedback"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {state === "sent" ? (
        <div className="nt-feedback-sent">
          <p>Got it — Ali will see this.</p>
          <p className="nt-feedback-sent-note">
            {kind === "wish" ? "Noted as a wish." : "You'll hear back."}
          </p>
        </div>
      ) : (
        <>
          <Segmented
            label="Feedback type"
            segments={KINDS}
            value={kind}
            onChange={setKind}
            tipUp
          />
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
        </>
      )}
    </div>
  );
}
