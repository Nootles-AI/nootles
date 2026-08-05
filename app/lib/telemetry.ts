import posthog from "posthog-js";

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
  block_created: { type: string };
  mention_inserted: { surface: "editor" | "canvas" };
  canvas_shape_added: { kind: string };
  canvas_edge_connected: Record<string, never>;
  math_evaluated: Record<string, never>;
  code_language_set: { lang: string };
  suggestion_shown: { kind: string; latencyMs: number };
  suggestion_accepted: { kind: string; latencyMs: number; decisionMs: number };
  suggestion_dismissed: { kind: string; reason: string };
  chat_prompt_sent: { attachments: number };
  chat_turn_completed: { pages: number; status: string };
  chat_turn_rewound: Record<string, never>;
  feedback_submitted: { kind: "issue" | "wish" };
  share_toggled: { on: boolean };
  survey_answered: { survey: string; answered: boolean };
};

/** No-op without a PostHog key; never throws. Safe to call from anywhere. */
export function track<K extends keyof EventMap>(name: K, props: EventMap[K]): void {
  try {
    if (posthog.__loaded) posthog.capture(name, props);
  } catch {
    // Telemetry never breaks the app.
  }
}
