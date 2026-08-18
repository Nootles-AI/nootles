import {
  NOTE_TAG,
  SHOT_TAG,
  STORYBOARD_TAG,
  type Storyboard,
} from "./types";

/**
 * {@link Storyboard} → storyboard HTML, in exactly one form.
 *
 * `parseStoryboard(serializeStoryboard(sb))` deep-equals `sb`, and
 * `serializeStoryboard(parseStoryboard(html)) === html` for canonical html —
 * the same pair of contracts the canvas holds itself to, and for the same
 * reason: this is the string the AI layer diffs, and a format that rewrote
 * itself on the way through would make every edit look like a change.
 *
 * A shot's canvas is emitted exactly as `serializeScene` wrote it, only
 * indented to sit inside the shot. Indentation is whitespace between tags, so
 * the parser cannot see it and the canonical scene string survives the trip.
 */

const INDENT = "  ";

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

function escText(text: string): string {
  return text.replace(/[&<>]/g, (c) => ESCAPE[c]);
}

/** Shift a multi-line block to a depth. Blank lines stay blank, not padded. */
function indent(text: string, depth: number): string {
  const pad = INDENT.repeat(depth);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

export function serializeStoryboard(board: Storyboard): string {
  const id = board.id ? ` id="${escText(board.id)}"` : "";
  const w = board.w !== undefined ? ` w="${Math.round(board.w)}"` : "";
  const cols = board.cols !== undefined ? ` cols="${Math.round(board.cols)}"` : "";
  const open = `<${STORYBOARD_TAG}${id} ratio="${board.ratio}"${w}${cols}>`;
  if (!board.shots.length) return `${open}</${STORYBOARD_TAG}>`;

  const shots = board.shots.map((shot) => {
    const parts: string[] = [];
    if (shot.scene) parts.push(indent(shot.scene, 2));
    // Written even when empty: a shot with no note still has somewhere to
    // write, and an element that came and went as text was typed would make
    // every first keystroke look like a structural change to the diff.
    parts.push(
      `${INDENT.repeat(2)}<${NOTE_TAG}>${escText(shot.note)}</${NOTE_TAG}>`,
    );
    return `${INDENT}<${SHOT_TAG}>\n${parts.join("\n")}\n${INDENT}</${SHOT_TAG}>`;
  });

  return `${open}\n${shots.join("\n")}\n</${STORYBOARD_TAG}>`;
}
