import type { ParseHtml } from "@/app/components/editor/canvas/scene/parse";
import type { Scene } from "@/app/components/editor/canvas/scene/types";
import type { StageResult } from "../review/session";

/**
 * The seam between the 13 node-level diagram tools and the surface that
 * actually holds a diagram — a live BlockNote editor with a `ReviewSession`,
 * in the browser, today; an MCP host reading a server-held Y.Doc, later.
 *
 * Every planner (`writeNodes.ts`, `updateStyles.ts`, `verbs.ts`,
 * `geometry.ts`, `styles.ts`) takes and returns a plain {@link Scene} and
 * touches nothing else — no editor, no Convex, no DOM. `execute.ts`'s
 * `runCanvasTool` is the one place a planner's output crosses into a real
 * write, and it does that only through this interface, so a second transport
 * (MCP) implements `CanvasHost` once and reuses every planner unchanged.
 */

/** A diagram as a tool call found it. */
export type CanvasRead = {
  pageId: string;
  blockId: string;
  /**
   * The diagram as it stands: the live `SceneStore`'s scene when the block is
   * mounted (so an in-flight human edit is never overwritten by a write built
   * against a stale read), else the stored prop, parsed.
   */
  scene: Scene;
};

/**
 * Reused, not reinvented: `review/session.ts` already exports this exact
 * shape as the return type of `ReviewSession.stage()` — `{added, removed,
 * changed, hunks}`, computed there from the hunks a batch actually produced.
 * A write tool's receipt IS a stage result; giving it a second name here
 * would just be an alias with extra steps.
 */
export type WriteReceipt = StageResult;

/** A model-facing sentence, never thrown — every one of the 13 tools reads
 *  its own refusals the way `edit_page` already does. */
export type Refusal = { refused: string };

export const refused = (text: string): Refusal => ({ refused: text });

export const isRefusal = (v: unknown): v is Refusal =>
  !!v && typeof v === "object" && "refused" in v;

export interface CanvasHost {
  /**
   * Resolves a diagram by block id on `pageId` (the open page when omitted).
   *
   * `null` when no such canvas block exists anywhere the host can see —
   * every one of the 13 tools reads this the same way `edit_page` reads an
   * unknown block id (W24 in TOOLS.md).
   *
   * A {@link Refusal} when the id resolves but the tool cannot act on it as
   * read — today only the storyboard-shot case (`blockId` is
   * `"<storyboard-id>:<n>"` and `<storyboard-id>` names a block of type
   * `"storyboard"`): every one of the 13 tools gets the same specific
   * sentence instead of falling through to the generic "no such diagram"
   * message.
   */
  readScene(blockId: string, pageId?: string): Promise<CanvasRead | Refusal | null>;

  /**
   * Lands `next` as one reviewable change on the block, or refuses. Never
   * partial — either the whole diagram lands as one `updateBlockProps`, or
   * nothing on the page changes.
   */
  writeScene(read: CanvasRead, next: Scene): Promise<WriteReceipt | Refusal>;

  /** `<nt-icon>` names must resolve before a fragment parses. */
  prepareParse(): Promise<void>;

  /** Injected for DOM-less hosts (vitest, a future MCP host with no browser). */
  parseHtml?: ParseHtml;
}
