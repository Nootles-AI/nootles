import { z } from "zod";
import { shapeKind } from "@/convex/ai/operations";

/**
 * The curated "action" the planner LLM chooses from — deliberately small and
 * hard to misuse (far more reliable than emitting raw Phase-2 ops, which
 * `compileAction` derives deterministically). Shared by the planner endpoint
 * (as the generateObject schema) and the client compiler.
 *
 * Deliberately FLAT — a single object with a `kind` enum and optional fields,
 * and a `"none"` kind instead of a nullable — so the JSON schema contains no
 * `oneOf`/`anyOf`. Some OpenRouter backends reject those in structured output.
 */

export const REFORMAT_TARGETS = [
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "quote",
  // Existing text that is actually code / math → a code or math block. Their
  // text goes into props (not inline content); the compiler handles that.
  "codeBlock",
  "mathBlock",
] as const;

export const ACTION_KINDS = [
  "none",
  "insertCode",
  "insertMathBlock",
  "insertInlineMath",
  "insertDiagram",
  "reformat",
] as const;

export const diagramNode = z.object({
  tempId: z.string(),
  shape: shapeKind,
  label: z.string(),
  x: z.number(),
  y: z.number(),
});

export const diagramEdge = z.object({
  source: z.string(),
  target: z.string(),
  label: z.string().optional(),
});

/** Tier 2 output for the diagram branch (the only branch needing a strong model). */
export const diagramOutput = z.object({
  nodes: z.array(diagramNode).min(1),
  edges: z.array(diagramEdge),
});
export type DiagramOutput = z.infer<typeof diagramOutput>;

export const action = z.object({
  kind: z.enum(ACTION_KINDS),
  // insertCode: model gives language + intent; the code body is filled by FIM.
  language: z.string().optional(),
  intent: z.string().optional(),
  code: z.string().optional(),
  // insertMathBlock
  rows: z.array(z.string()).optional(),
  // insertInlineMath
  latex: z.string().optional(),
  // insertDiagram
  nodes: z.array(diagramNode).optional(),
  edges: z.array(diagramEdge).optional(),
  // reformat: existing block ids (from the projection) → a new block type
  blockIds: z.array(z.string()).optional(),
  to: z.enum(REFORMAT_TARGETS).optional(),
  headingLevel: z.number().int().min(1).max(3).optional(),
});
export type Action = z.infer<typeof action>;

/** The planner's structured output; `action.kind === "none"` means no suggestion. */
export const plannerOutput = z.object({
  // Short caret-chip label, e.g. "Insert code block" / "Format as checklist".
  label: z.string(),
  action,
});
export type PlannerOutput = z.infer<typeof plannerOutput>;
