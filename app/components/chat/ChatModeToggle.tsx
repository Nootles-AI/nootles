"use client";

import { Segmented, type Segment } from "../Segmented";
import type { ChatMode } from "@/app/lib/ai/chat/types";

/** What the agent is allowed to do, said as a capability rather than a setting. */
const MODES: Segment<ChatMode>[] = [
  { id: "agent", label: "Agent", hint: "Reads the project and manages its pages." },
  { id: "ask", label: "Ask", hint: "Reads and searches. Never changes a page." },
];

/**
 * Ask is not a softer prompt: the tools that could change something are left
 * out of the request entirely, so the promise the label makes is one the model
 * has no way to break.
 */
export function ChatModeToggle({
  mode,
  onChange,
}: {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
}) {
  return (
    <Segmented
      label="Agent mode"
      segments={MODES}
      value={mode}
      onChange={onChange}
      tipUp
    />
  );
}
