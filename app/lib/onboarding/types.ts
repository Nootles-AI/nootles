import type { PartialBlock } from "@blocknote/core";
import type { EditorSchema } from "@/app/components/editor/schema";

/**
 * What first run is made of.
 *
 * A template is data, not code: the document it seeds, and the script the guide
 * plays over it. Keeping the two in one file is deliberate — the scripted
 * completion has to finish the exact sentence the seed left hanging, and that
 * agreement is impossible to hold if they live apart.
 */

export type SeedBlock = PartialBlock<
  EditorSchema["blockSchema"],
  EditorSchema["inlineContentSchema"],
  EditorSchema["styleSchema"]
>;

export type TemplateId =
  | "prd"
  | "techDesign"
  | "screenplay"
  | "woodworking"
  | "classNotes"
  | "research";

export type TemplatePage = { title: string; blocks: SeedBlock[] };

/**
 * The three gated beats plus the free tail's opening suggestion.
 *
 * `blockId` on the first two names a block seeded into the document, so the
 * guide can find where to put the caret without guessing at positions. Those
 * ids are written into the seed and are the join between the two halves.
 */
export type TourScript = {
  /** Beat 1 — the sentence the seed leaves unfinished, and how it ends. */
  write: { blockId: string; ghost: string };
  /**
   * Beat 2 — the line that invites a diagram, the brief stage one "writes",
   * and the canvas HTML stage two "returns".
   */
  draw: { blockId: string; brief: string; html: string };
  /**
   * A conversation already in the project when the user arrives.
   *
   * There so that "start a new chat" has something to be new NEXT TO. A panel
   * with one empty thread in it teaches nothing about threads; a panel with a
   * finished conversation in it says, without a sentence being spent on it,
   * that these are kept, that they belong to the project, and that you are
   * about to start another one.
   */
  priorChat: { title: string; asked: string; answered: string };
  /** Beat 3 — what we put in the composer for the user to send. */
  ask: string;
  /** The free tail's first suggestion: which block this document wants next. */
  suggest: { type: string; label: string; hint: string };
};

/**
 * A block that exists only to be drawn in the welcome preview.
 *
 * Loosely typed on purpose: it is never inserted into a document, so it does
 * not have to satisfy BlockNote's schema — it has to satisfy the page
 * renderer, which reads plain shapes. Holding it to the editor's types would
 * mean hand-building table content in its internal form for a picture.
 */
export type ShowcaseBlock = {
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
};

export type Template = {
  id: TemplateId;
  /** Survey card. */
  label: string;
  blurb: string;
  /** What the project and its first page are called. */
  projectTitle: string;
  description: string;
  pages: TemplatePage[];
  script: TourScript;
  /**
   * The one more thing this kind of document reaches for, shown in the welcome
   * preview under a heading of its own.
   *
   * The preview's job is to answer "what IS a Nootles page" before anyone has
   * seen one, and prose alone does not answer it. Every template's picture
   * therefore carries its diagram and one of code, maths or a table.
   */
  showcase: { heading: string; caption: string; block: ShowcaseBlock };
};
