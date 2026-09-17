import type { StagedScript } from "../types";
import { canvasBlockId, canvasHtml, openPage, shapesLabelled } from "./resolve";

/**
 * C-10 — colour the safety-critical path red.
 *
 * Style only. Nothing moves, nothing is added, the layers panel is unchanged
 * and the whole thing is one undo — which is the proof that C-09 was not a
 * re-render and that these are shapes the team keeps editing by hand.
 */
export const C10: StagedScript = {
  id: "C-10",
  title: "Colour the safety-critical path",
  match:
    /\b(highlight|colou?r|color|mark)\b[^.?]{0,70}\bsafety[\s-]?critical\b|\b(colou?r|color|highlight|mark|turn|make)\b[^.?]{0,60}\b(safety|critical|paths?|box|boxes|shapes?|nodes?|edges?|branch|arrows?|that|those|them|it)\b[^.?]{0,45}\b(red|amber|orange)\b/i,
  says: [
    "colour the safety-critical path red",
    "color the safety critical path red",
    "highlight the safety-critical path",
    "make the safety path red",
    "turn those boxes red",
    "mark the critical safety path in red",
    "can you highlight the safety-critical bits",
    "colour that red",
    "Colour the safety-critical path red",
    "can you colour the safety critical path red",
    "make those nodes red",
    "highlight the safety critical route",
    "turn that path red",
    "mark those edges in red",
  ],
  bail: "There's no diagram on this page to restyle.",
  steps: [
    {
      delayMs: 450,
      call: [{ tool: "read_open_page", input: {} }],
    },
    {
      delayMs: 350,
      call: [
        {
          tool: "read_open_page",
          input: (ctx) => {
            const at = canvasBlockId(ctx);
            return at ? { expand: [at] } : null;
          },
        },
      ],
    },
    {
      say: "Restyled, and nothing moved — same ids, same geometry, one step on the undo stack.",
      delayMs: 700,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const scene = canvasHtml(ctx);
            const at = canvasBlockId(ctx);
            const pageId = openPage(ctx);
            if (!scene || !at || !pageId) return null;

            // The safety path is whatever on this board is labelled like one,
            // read off the scene rather than assumed: a board the presenter has
            // edited still gets the right boxes.
            const hot = new Set([
              ...shapesLabelled(scene, /e-?stop|contactor|bms|retry|timeout/i),
            ]);
            let out = scene;
            for (const id of hot) {
              out = out.replace(
                new RegExp(`(<nt-[a-z]+\\b[^>]*\\bid="${id}"[^>]*\\bstyle=")([^"]*)(")`, "i"),
                (_all, head: string, style: string, tail: string) =>
                  head +
                  // A box shape is painted in CSS, not in SVG paint: `fill` and
                  // `stroke` belong to paths and connectors, and writing them
                  // here restyles nothing at all. A polygon keeps its SVG paint,
                  // so both spellings are handled.
                  style
                    .replace(/(?<!-)\bbackground:[^;]*/i, "background:#fdeaea")
                    .replace(/(?<!-)\bborder:\s*[\d.]+px\s+\w+\s+[^;]*/i, "border:3px solid #c0392b")
                    .replace(/(?<!-)\bfill:[^;]*/i, "fill:#fdeaea")
                    .replace(/(?<!-)\bstroke:[^;]*/i, "stroke:#c0392b") +
                  tail,
              );
            }
            // Edges into or out of a hot shape go red too, or the path reads as
            // a set of boxes rather than a path.
            out = out.replace(
              /<nt-edge\b([^>]*)\bfrom="([^"]+)"([^>]*)\bto="([^"]+)"([^>]*)>/gi,
              (all, a: string, from: string, b: string, to: string, c: string) =>
                hot.has(from) || hot.has(to)
                  ? `<nt-edge${a}from="${from}"${b}to="${to}"${c} style="stroke:#c0392b;stroke-width:3;color:#c0392b">`
                  : all,
            );
            return { pageId, html: out, replacing: [at] };
          },
        },
      ],
    },
  ],
};
