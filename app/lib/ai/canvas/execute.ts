import type { z } from "zod";
import { parseFragment } from "@/app/components/editor/canvas/scene/parse";
import type { NodeId, Scene } from "@/app/components/editor/canvas/scene/types";
import { geometryReport, geometryText, shapeRows } from "./geometry";
import { isRefusal, type CanvasHost, type CanvasRead, type WriteReceipt } from "./host";
import { stylesReport } from "./styles";
import { planUpdateStyles, type StylePatchInput } from "./updateStyles";
import { planEdits, type Verb } from "./verbs";
import { planWriteNodes, summarize, type Anchor } from "./writeNodes";
import { compileToHtml } from "../html/toHtml";
import { AI } from "../aiConfig";
import { TOOLS, type CanvasToolName } from "../chat/tools";

export type { CanvasToolName };

/**
 * The one executor behind all six node-level diagram tools (TOOLS.md §4.3).
 *
 * Parses `input` against the tool's own zod schema, resolves the diagram
 * through {@link CanvasHost}, calls the matching pure planner, and — for a
 * mutating tool — lands the plan through `host.writeScene` and formats the
 * result in `edit_page`'s voice. `get_styles` and `get_html` return
 * plain objects; `get_geometry` and the write tools return strings.
 *
 * This is the ONE place the "nothing to do" / "no such diagram" / "storyboard
 * shot" sentences are written, so every one of the six tools says the same
 * thing the same way instead of each carrying its own copy.
 */
export async function runCanvasTool(
  name: CanvasToolName,
  input: unknown,
  host: CanvasHost,
): Promise<unknown> {
  const spec = TOOLS[name];
  const parsed = spec.inputSchema.parse(input) as {
    pageId?: string;
    blockId: string;
    [key: string]: unknown;
  };

  const read = await host.readScene(parsed.blockId, parsed.pageId);
  if (read === null) {
    return `This page has no diagram with id "${parsed.blockId}". Pass pageId, or read the page again for the at="…" on its stub.`;
  }
  if (isRefusal(read)) return read.refused;

  switch (name) {
    case "get_geometry":
      return geometryText(
        geometryReport(read.scene, {
          ids: parsed.ids as string[] | undefined,
          depth: parsed.depth as number | undefined,
          max: AI.chat.canvas.maxGeometryNodes,
        }),
      );
    case "get_styles":
      return stylesReport(read.scene, {
        ids: parsed.ids as string[] | undefined,
        max: AI.chat.canvas.maxStyleNodes,
      });
    case "get_html": {
      const { code, warnings } = await compileToHtml(read.scene, {
        jsx: parsed.jsx as boolean | undefined,
        ids: parsed.ids as NodeId[] | undefined,
      });
      if (code.length <= AI.chat.canvas.maxHtmlChars) return { code, warnings };
      const cut = code.lastIndexOf("\n", AI.chat.canvas.maxHtmlChars);
      const truncated = code.slice(0, cut > 0 ? cut : AI.chat.canvas.maxHtmlChars);
      return {
        code: truncated,
        warnings: [
          ...warnings,
          `truncated: ${code.length - truncated.length} more characters; ask for fewer ids`,
        ],
      };
    }

    case "write_nodes": {
      const html = parsed.html as string;
      if (/<nt-diagram\b[^>]*\bref=/.test(html)) {
        return "That change was not applied, and nothing on the diagram changed. Drawings are placed with edit_page, not write_nodes.";
      }
      await host.prepareParse();
      const fragment = parseFragment(html, host.parseHtml);
      const plan = planWriteNodes(read.scene, fragment, {
        removing: parsed.removing as string[] | undefined,
        at: parsed.at as Anchor | undefined,
      });
      if (isRefusal(plan)) return plan.refused;
      return landWrite(host, read, plan.next, () => {
        const tail = geometryReport(plan.next, {
          ids: [...plan.inserted, ...plan.updated],
          max: AI.chat.canvas.reportNodes,
        });
        return [
          `Done: ${summarize(plan)}. The user reviews this and may discard it.`,
          ...plan.notes,
          "",
          SHAPE_TAIL,
          ...shapeRows(tail.nodes),
        ].join("\n");
      });
    }

    case "update_styles": {
      const plan = planUpdateStyles(read.scene, parsed.patches as StylePatchInput[]);
      if (isRefusal(plan)) return plan.refused;
      return landWrite(
        host,
        read,
        plan.next,
        () =>
          `Done: ${plan.touched.length} shape${plan.touched.length === 1 ? "" : "s"} restyled (${plan.touched.join(", ")}). The user reviews this and may discard it.`,
      );
    }

    case "canvas_edit": {
      const { ops } = parsed as z.infer<(typeof TOOLS)["canvas_edit"]["inputSchema"]>;
      const plan = planEdits(read.scene, ops satisfies Verb[]);
      if (isRefusal(plan)) return plan.refused;
      return landWrite(host, read, plan.next, () =>
        [plan.summary, ...(plan.notes ?? []), "The user reviews this and may discard it."].join("\n"),
      );
    }
  }
}

/** The columns of a write's tail, as `get_geometry` names them. */
const SHAPE_TAIL = 'Where they landed — id kind "name" parent depth x y w h rot, in canvas pixels:';

/** Shared by `write_nodes`, `update_styles` and `canvas_edit`: the identity
 *  no-op check, the real write, and the zero-receipt safety net that catches
 *  a plan whose `next` differs by object identity but serializes
 *  byte-identically to what is already there (§4.3 of TOOLS.md). */
async function landWrite(
  host: CanvasHost,
  read: CanvasRead,
  next: Scene,
  onDone: () => string,
): Promise<string> {
  if (next === read.scene) {
    return "Nothing to do — the diagram already reads that way.";
  }
  const receipt = await host.writeScene(read, next);
  if (isRefusal(receipt)) return receipt.refused;
  if (isZeroReceipt(receipt)) {
    return "Nothing to do — the diagram already reads that way.";
  }
  return onDone();
}

function isZeroReceipt(receipt: WriteReceipt): boolean {
  return receipt.added === 0 && receipt.removed === 0 && receipt.changed === 0 && receipt.hunks === 0;
}
