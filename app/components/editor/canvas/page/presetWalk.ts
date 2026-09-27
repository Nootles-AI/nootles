/**
 * Where a key on the preset bar goes, from the option at `at` of `count`: onto
 * another option, or off the bar — back to the diagram's plate (←) or on
 * through it, as → on the plate would go had there been no bar. ↑/↓ go round.
 */
export type PresetStep = { focus: number } | { leave: -1 | 1 } | null;

export function presetStep(key: string, at: number, count: number): PresetStep {
  switch (key) {
    case "ArrowRight":
      return at < count - 1 ? { focus: Math.max(at + 1, 0) } : { leave: 1 };
    case "ArrowLeft":
      return at > 0 ? { focus: at - 1 } : { leave: -1 };
    case "ArrowDown":
      return { focus: (at + 1 + count) % count };
    case "ArrowUp":
      return { focus: (at - 1 + count) % count };
    case "Home":
      return { focus: 0 };
    case "End":
      return { focus: count - 1 };
    default:
      return null;
  }
}
