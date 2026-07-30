import type { DocNode, Run } from "./grammar";

/**
 * A block the model wrote as markdown is the block a human typing the same
 * characters would have got.
 *
 * The editor turns "1. " at the start of a block into a numbered item as you
 * type it — an input rule the AI never goes through, so it can author something
 * no one could type: a paragraph whose text merely begins with "1. ". Measured
 * against a real completion, that is exactly what it does. Asked to continue a
 * list the user opened by typing "1.", it writes
 *
 *   2. John</p><p id="b5">3. Robert
 *
 * and the document ends up holding hand-numbered paragraphs that look like a
 * list, renumber nothing when reordered, and are not one.
 *
 * Applied to what the model AUTHORED, never to the document being read: the
 * existing side has to stay the blocks it really is, or the diff sees a list on
 * both sides and never converts anything.
 */

/** `1. ` and `1) `, the two the editor accepts. */
const NUMBERED = /^(\d+)[.)][ \t]+/;
/** `- `, `* `, `+ `, and the bullet glyph itself, which models like to emit. */
const BULLET = /^[-*+•][ \t]+/;
/** `[] ` and `[x] `. */
const CHECKED = /^\[([ xX]?)\][ \t]+/;

/** The same runs with `count` characters taken off the front of the first one. */
function strip(content: Run[], count: number): Run[] {
  const [first, ...rest] = content;
  if (!first || first.type !== "text") return content;
  const text = first.text.slice(count);
  return text ? [{ ...first, text }, ...rest] : rest;
}

export function asListItems(nodes: DocNode[]): DocNode[] {
  // Where we are in the current numbered run, so that a run opening at some
  // other number than 1 keeps the number the model wrote.
  let ordinal = 0;

  return nodes.map((node) => {
    if (node.type !== "paragraph") {
      ordinal = 0;
      return node;
    }
    const first = node.content?.[0];
    if (!first || first.type !== "text") {
      ordinal = 0;
      return node;
    }

    const checked = CHECKED.exec(first.text);
    if (checked) {
      ordinal = 0;
      return {
        ...node,
        type: "checkListItem",
        checked: checked[1].toLowerCase() === "x",
        content: strip(node.content, checked[0].length),
      };
    }

    const bullet = BULLET.exec(first.text);
    if (bullet) {
      ordinal = 0;
      return {
        ...node,
        type: "bulletListItem",
        content: strip(node.content, bullet[0].length),
      };
    }

    const numbered = NUMBERED.exec(first.text);
    if (numbered) {
      ordinal += 1;
      const n = Number(numbered[1]);
      return {
        ...node,
        type: "numberedListItem",
        ...(ordinal === 1 && n !== 1 ? { start: n } : {}),
        content: strip(node.content, numbered[0].length),
      };
    }

    ordinal = 0;
    return node;
  });
}
