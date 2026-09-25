/**
 * "Turn into" — the grip menu's conversions, as plain block updates.
 *
 * Each is the `updateBlock` the slash menu and the toolbar's block-type select
 * already make, so a conversion is the same one step on the one document
 * whichever of the three asked for it.
 */

export type TurnIntoTarget = {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
};

/** Notion's order, less what this editor has no block for. */
export const TURN_INTO: readonly TurnIntoTarget[] = [
  { key: "text", label: "Text", type: "paragraph" },
  { key: "h1", label: "Heading 1", type: "heading", props: { level: 1 } },
  { key: "h2", label: "Heading 2", type: "heading", props: { level: 2 } },
  { key: "h3", label: "Heading 3", type: "heading", props: { level: 3 } },
  { key: "bullet", label: "Bullet list", type: "bulletListItem" },
  { key: "numbered", label: "Numbered list", type: "numberedListItem" },
  { key: "todo", label: "To-do list", type: "checkListItem" },
  { key: "toggle", label: "Toggle list", type: "toggleListItem" },
  { key: "quote", label: "Quote", type: "quote" },
  { key: "code", label: "Code", type: "codeBlock" },
];

/** The blocks that hold writing, and so can become one another. A diagram
    or an album has nothing a heading could keep. */
const TURNABLE = new Set(TURN_INTO.map((target) => target.type));

type Inline = { type: string; text?: string; content?: Inline[] | string };

/** A block as the menu sees it — BlockNote's, read structurally. */
export type TurnableBlock = {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
};

export function canTurnInto(block: TurnableBlock): boolean {
  return TURNABLE.has(block.type);
}

export function isCurrentType(block: TurnableBlock, target: TurnIntoTarget): boolean {
  if (block.type !== target.type) return false;
  return !target.props || Object.entries(target.props).every(([k, v]) => block.props[k] === v);
}

/** The words, without their styling: what a code block can keep of them. A
    mention or an equation has no plain spelling here, and is left out. */
export function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Inline[])
    .map((part) =>
      part.type === "text" ? (part.text ?? "") : part.type === "link" ? plainText(part.content) : "",
    )
    .join("");
}

/**
 * The update that turns `block` into `target`. Between blocks of writing the
 * words stay where they are and only the type and its props change. Code holds
 * its text in a prop rather than as content, so the words are carried across
 * that line by hand, in both directions.
 */
export function turnIntoUpdate(
  block: TurnableBlock,
  target: TurnIntoTarget,
): { type: string; props: Record<string, unknown>; content?: string } {
  const props = { ...target.props };
  if (target.type === "codeBlock") {
    return block.type === "codeBlock"
      ? { type: target.type, props: {} }
      : { type: target.type, props: { ...props, code: plainText(block.content) } };
  }
  if (block.type === "codeBlock") {
    return { type: target.type, props, content: String(block.props.code ?? "") };
  }
  return { type: target.type, props };
}
