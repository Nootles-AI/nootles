"use client";

import { Segmented, type Segment } from "./Segmented";
import type { PageMode } from "./editor/ai/useTabCompletion";

/** Both tooltips describe what the model does, not what you happen to be doing. */
const MODES: Segment<PageMode>[] = [
  { id: "create", label: "Create", hint: "Writes what is not there yet." },
  { id: "complete", label: "Complete", hint: "Only finishes what you started." },
];

/** How far the model is allowed to go on this page. */
export function ModeToggle({
  mode,
  onChange,
}: {
  mode: PageMode;
  onChange: (mode: PageMode) => void;
}) {
  return (
    <Segmented
      label="Suggestion mode"
      segments={MODES}
      value={mode}
      onChange={onChange}
    />
  );
}
