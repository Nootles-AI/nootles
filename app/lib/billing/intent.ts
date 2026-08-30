"use client";

import type { ChatDraft } from "@/app/lib/ai/chat/useProjectChat";

/**
 * What the person was about to do when money stopped them, kept across the
 * Stripe round trip so that paying returns them to it rather than to a
 * congratulations screen they then have to navigate out of.
 *
 * Two phases, and the distinction is the whole correctness of this file:
 *
 *   remembered — written when the wall is raised. It is only a note of where we
 *                were standing. On its own it must never cause anything to
 *                happen, because most walls end in "Not now".
 *   armed      — promoted only once access has actually been granted. Only an
 *                armed intent is replayed.
 *
 * Collapsing those two into one flag is the bug this shape exists to prevent: a
 * dismissed wall would leave a live instruction behind, and the next visit to
 * the projects screen would open a dialog nobody asked for.
 *
 * `sessionStorage` rather than `localStorage`: this belongs to one tab's trip
 * out to Stripe and back, and it should not survive into a second window where
 * the person is doing something else entirely.
 */

export type BillingIntent =
  | { kind: "newProject" }
  /** The message that was never sent. Every field of a draft is plain JSON. */
  | {
      kind: "chatSend";
      projectId: string;
      pageId: string | null;
      draft: ChatDraft;
    }
  /** Nothing to replay — the lane resumes itself. Carried for the return path. */
  | { kind: "completion" };

export type IntentKind = BillingIntent["kind"];

type Stored = {
  intent: BillingIntent;
  /** Same-origin path to come back to. */
  from: string;
  at: number;
  armed: boolean;
};

const KEY = "nt:billing-intent";

/**
 * Long enough for a card that needs a bank's approval screen, short enough that
 * an intent abandoned before lunch is not replayed after it.
 */
const TTL_MS = 30 * 60 * 1000;

/**
 * A path we wrote, checked again on the way out.
 *
 * The return target never reaches Stripe — its `successUrl` stays server-owned
 * for exactly that reason — but this value does decide a client-side
 * navigation, and a stored string is not a trusted one. `//host` is the case
 * that matters: the browser reads it as protocol-relative and leaves the site.
 */
function safePath(from: unknown): string | null {
  if (typeof from !== "string") return null;
  if (!from.startsWith("/") || from.startsWith("//")) return null;
  return from;
}

function read(): Stored | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    const from = safePath(parsed.from);
    if (!from || !parsed.intent || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > TTL_MS) return null;
    return {
      intent: parsed.intent,
      from,
      at: parsed.at,
      armed: parsed.armed === true,
    };
  } catch {
    return null;
  }
}

function write(value: Stored): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // A full or blocked store costs the resume, not the payment.
  }
}

/** Note what was being done, without authorising anything to happen. */
export function rememberIntent(intent: BillingIntent, from: string): void {
  if (typeof window === "undefined") return;
  const path = safePath(from);
  if (!path) return;
  write({ intent, from: path, at: Date.now(), armed: false });
}

/** Where we were, whether or not it has been paid for. Does not consume. */
export function peekIntent(): Stored | null {
  return read();
}

/**
 * Access was granted; the note becomes an instruction. Returns it so the caller
 * knows where to go next.
 */
export function armIntent(): Stored | null {
  const stored = read();
  if (!stored) return null;
  const armed = { ...stored, armed: true, at: Date.now() };
  write(armed);
  return armed;
}

/**
 * The armed intent, consumed — but only by the screen it belongs to.
 *
 * Scoped by kind because several screens ask. An unscoped take would let
 * whichever mounted first swallow an instruction meant for another and drop it,
 * which is exactly the message the person expected to find sent.
 *
 * Reading removes it, so a replay cannot happen twice. That matters most for
 * `chatSend`, where twice is two model calls and two charges.
 */
export function takeArmedIntent<K extends IntentKind>(
  kind: K,
): Extract<BillingIntent, { kind: K }> | null {
  const stored = read();
  if (!stored?.armed || stored.intent.kind !== kind) return null;
  forgetIntent();
  return stored.intent as Extract<BillingIntent, { kind: K }>;
}

export function forgetIntent(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to do, and nothing that depends on it.
  }
}
