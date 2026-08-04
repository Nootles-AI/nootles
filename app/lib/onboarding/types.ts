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
  /** Beat 3 — what we put in the composer for the user to send. */
  ask: string;
  /** The free tail's first suggestion: which block this document wants next. */
  suggest: { type: string; label: string; hint: string };
};

export type Template = {
  id: TemplateId;
  /** Survey card. */
  label: string;
  blurb: string;
  /** What the project and its first page are called. */
  projectTitle: string;
  description: string;
  /** Roles offered once this template is picked; the survey also accepts free text. */
  roles: string[];
  pages: TemplatePage[];
  script: TourScript;
};
