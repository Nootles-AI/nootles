import { parseFragment } from "@/app/components/editor/canvas/scene/parse";
import type { NodeId, Scene } from "@/app/components/editor/canvas/scene/types";
import { geometryReport } from "./geometry";
import { isRefusal, type CanvasHost, type CanvasRead, type WriteReceipt } from "./host";
import { stylesReport } from "./styles";
import { planUpdateStyles, type StylePatchInput } from "./updateStyles";
import { planVerb, type Verb } from "./verbs";
import { planWriteNodes, summarize, type Anchor } from "./writeNodes";
import { compileToHtml } from "../html/toHtml";
import { AI } from "../aiConfig";
import { TOOLS, type CanvasToolName } from "../chat/tools";

export type { CanvasToolName };

/**
 * The one executor behind all 13 node-level diagram tools (TOOLS.md §4.3).
 *
 * Parses `input` against the tool's own zod schema, resolves the diagram
 * through {@link CanvasHost}, calls the matching pure planner, and — for a
 * mutating tool — lands the plan through `host.writeScene` and formats the
 * result in `edit_page`'s voice. Read tools return plain objects; write
 * tools and verbs return strings.
 *
 * This is the ONE place the "nothing to do" / "no such diagram" / "storyboard
 * shot" sentences are written, so every one of the 13 tools says the same
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
      return geometryReport(read.scene, {
        ids: parsed.ids as string[] | undefined,
        depth: parsed.depth as number | undefined,
        max: AI.chat.canvas.maxGeometryNodes,
      });
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
          JSON.stringify({ nodes: tail.nodes }),
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

    default: {
      const verb = verbFrom(name, parsed);
      const plan = planVerb(read.scene, verb);
      if (isRefusal(plan)) return plan.refused;
      return landWrite(host, read, plan.next, () => {
        const lines = [plan.summary, ...(plan.notes ?? [])];
        const extra = Object.keys(plan.result).length ? JSON.stringify(plan.result) : "";
        return [lines.join("\n"), extra].filter(Boolean).join("\n");
      });
    }
  }
}

/** Shared by `write_nodes`, `update_styles` and every verb: the identity
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

function verbFrom(name: CanvasToolName, parsed: Record<string, unknown>): Verb {
  switch (name) {
    case "set_text":
      return {
        verb: "set_text",
        id: parsed.id as string,
        text: parsed.text as string,
        markup: parsed.markup as boolean | undefined,
      };
    case "rename":
      return { verb: "rename", id: parsed.id as string, name: parsed.name as string | null };
    case "duplicate":
      return {
        verb: "duplicate",
        ids: parsed.ids as string[],
        offset: parsed.offset as number | undefined,
      };
    case "move":
      return {
        verb: "move",
        ids: parsed.ids as string[],
        dx: parsed.dx as number | undefined,
        dy: parsed.dy as number | undefined,
        x: parsed.x as number | undefined,
        y: parsed.y as number | undefined,
      };
    case "delete":
      return { verb: "delete", ids: parsed.ids as string[] };
    case "reorder":
      return {
        verb: "reorder",
        ids: parsed.ids as string[],
        to: parsed.to as Extract<Verb, { verb: "reorder" }>["to"],
      };
    case "group":
      return {
        verb: "group",
        ids: parsed.ids as string[],
        name: parsed.name as string | undefined,
        op: parsed.op as Extract<Verb, { verb: "group" }>["op"],
      };
    case "ungroup":
      return { verb: "ungroup", ids: parsed.ids as string[] };
    default:
      throw new Error(`${name} is not a verb`);
  }
}
