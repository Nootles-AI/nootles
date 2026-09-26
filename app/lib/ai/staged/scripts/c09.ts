import type { StagedScript } from "../types";
import { canvasBlockId, canvasHtml, openPage } from "./resolve";

/**
 * C-09 — add a retry branch. The exact-round-trip proof.
 *
 * Reads the diagram for real before touching it, in two steps: the first read
 * projects a canvas as a stub carrying its block id, the second asks for that
 * block in full. The edit is then built from what is actually on the page, so
 * it still lands if the presenter dragged a box first — and if there is no
 * diagram at all, the resolver returns null and the turn answers in prose
 * rather than emitting a call against shapes that do not exist.
 */
export const C09: StagedScript = {
  id: "C-09",
  title: "Add a retry branch",
  match:
    /\b(add|insert|put|stick|drop|throw)\b[^.?]{0,70}\b(retry|branch|node|box|step|state|loop|arrow|block)\b/i,
  says: [
    "add a retry branch after the CAN timeout",
    "add a retry loop",
    "can you insert a retry branch there",
    "put a retry node after the timeout",
    "add a box for the retry",
    "stick a branch in after the timeout",
    "add a step for retries",
    "drop in a retry loop",
    "Add a retry branch after the CAN timeout",
    "could you add a retry branch",
    "let's add a retry node",
    "insert a branch for the retry",
    "add another box for retries",
    "put in a retry step",
  ],
  bail:
    "There's no diagram on this page to add to — draw one first and I'll edit it in place.",
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
      say: "One node and two edges. Everything else keeps the id, the position and the styling it already had.",
      delayMs: 700,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const scene = canvasHtml(ctx);
            const at = canvasBlockId(ctx);
            const pageId = openPage(ctx);
            if (!scene || !at || !pageId) return null;
            // Spliced in before the closing tag: everything already in the
            // scene is sent back byte for byte, which is what makes the rest of
            // the board pixel-identical rather than merely similar.
            const added =
              `  <nt-polygon id="pp-retry" sides="4" x="510" y="330" w="150" h="84" style="fill:#f6e9d8;stroke:#a8702a;stroke-width:2;display:flex;align-items:center;justify-content:center;text-align:center">CAN timeout?<br/>retry ×3</nt-polygon>\n` +
              `  <nt-edge id="pp-e9" from="pp-drv" to="pp-retry">no ack &lt; 15 ms</nt-edge>\n` +
              `  <nt-edge id="pp-e10" from="pp-retry" to="pp-drv">re-arm</nt-edge>\n`;
            return {
              pageId,
              html: scene.replace(/\n?<\/nt-diagram\s*>\s*$/i, `\n${added}</nt-diagram>`),
              replacing: [at],
            };
          },
        },
      ],
    },
  ],
};
