import type { PostHog } from "posthog-js";

/**
 * The one product-analytics choke point. A closed event taxonomy, mirroring
 * the op-vocabulary principle: nothing captures an ad-hoc string, so the
 * dashboard never fills with spellings of the same event.
 *
 * Convex stays the source of truth for AI-quality data (suggestionLog,
 * aiCalls); these events exist for funnels, retention and replay markers, so
 * their payloads stay lean.
 */

type EventMap = {
  onboarding_completed: { role?: string; useCase?: string; mode?: string };
  project_created: Record<string, never>;
  page_created: { mode?: string };
  page_moved: Record<string, never>;
  folder_created: Record<string, never>;
  folder_moved: Record<string, never>;
  /** The sidebar clipboard being spent — the feature's whole funnel. */
  sidebar_pasted: {
    kind: "page" | "folder";
    op: "copy" | "cut";
    /** Whether the paste crossed into another project than the copy's. */
    across: boolean;
  };
  block_created: { type: string };
  mention_inserted: { surface: "editor" | "canvas" };
  canvas_shape_added: { kind: string };
  canvas_edge_connected: Record<string, never>;
  code_language_set: { lang: string };
  suggestion_shown: { kind: string; latencyMs: number };
  suggestion_accepted: { kind: string; latencyMs: number; decisionMs: number };
  suggestion_dismissed: { kind: string; reason: string };
  chat_prompt_sent: { attachments: number };
  /** Asked mid-answer, and how many were already waiting when it was. */
  chat_prompt_queued: { waiting: number };
  /** Stop, and what it cost: the queued questions it dropped along with the turn. */
  chat_turn_stopped: { dropped: number };
  chat_turn_completed: { pages: number; status: string };
  chat_turn_rewound: Record<string, never>;
  feedback_submitted: { kind: "issue" | "wish" };
  /** Whether being told a report was fixed is worth reading, or just closed. */
  fix_toast_opened: { count: number };
  fix_toast_dismissed: { count: number };
  share_link_toggled: { role: "viewer" | "commenter" | "editor"; on: boolean };
  share_link_copied: { role: "viewer" | "commenter" | "editor" };
  share_claimed: { role: "viewer" | "commenter" | "editor" };
  access_requested: { from: "share_link" | "workspace" };
  access_request_decided: { grant: boolean };
  survey_answered: { survey: string; answered: boolean };
};

type Call = (posthog: PostHog) => void;

let posthog: PostHog | undefined;

/**
 * What was asked of PostHog before it loaded, replayed in order once it has.
 * Absent when it never will load — no key, or the boot failed — so nothing
 * waits on it. Bounded, in case the load never finishes.
 */
let pending: Call[] | undefined = process.env.NEXT_PUBLIC_POSTHOG_KEY ? [] : undefined;
const MAX_PENDING = 500;

let booting: Promise<void> | undefined;

function run(call: Call): void {
  try {
    call(posthog!);
  } catch {
    // Telemetry never breaks the app.
  }
}

/**
 * Loads PostHog off the first-load bundle, hands it to `init`, then replays
 * whatever arrived in the meantime. Idempotent.
 */
export function bootAnalytics(init: Call): Promise<void> {
  booting ??= import("posthog-js")
    .then(({ default: loaded }) => {
      init(loaded);
      posthog = loaded;
      const queued = pending;
      pending = undefined;
      queued?.forEach(run);
    })
    .catch(() => {
      pending = undefined;
    });
  return booting;
}

/** Runs `call` against PostHog now if it has loaded, else once it does. */
export function withAnalytics(call: Call): void {
  if (posthog) run(call);
  else if (pending && pending.length < MAX_PENDING) pending.push(call);
}

/** PostHog if it has loaded, for reads that can't wait. */
export function loadedAnalytics(): PostHog | undefined {
  return posthog;
}

/** No-op without a PostHog key; never throws. Safe to call from anywhere. */
export function track<K extends keyof EventMap>(name: K, props: EventMap[K]): void {
  withAnalytics((posthog) => posthog.capture(name, props));
}
