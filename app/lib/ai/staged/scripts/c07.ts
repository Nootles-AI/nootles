import type { StagedScript } from "../types";
import { POWER_PATH } from "../scenes";
import { openPage } from "./resolve";

/**
 * C-07 — diagram the power path.
 *
 * Staged in its own right rather than seeded, because two later calls read
 * what it draws: the shape ids C-09 and C-10 act on are the ones in this
 * payload, so the chain is deterministic without giving up the moment where
 * the canvas builds itself.
 */
export const C07: StagedScript = {
  id: "C-07",
  title: "Diagram the power path",
  match:
    /\bpower path\b|\b(diagram|draw|drawing|map|sketch|chart|show|give me|build)\b[^.?]{0,70}\b(power|electrical|battery|pack|bus|harness|wiring|charge path)\b/i,
  not: /\b(icd|interface control|can[\s-]bus|can[\s-]matrix|message map)\b/i,
  says: [
    "diagram the power path",
    "draw the power path",
    "can you diagram our electrical system",
    "map out the power path from the pack to the wheels",
    "show me the power path",
    "sketch the battery to motor wiring",
    "give me a diagram of the power bus",
    "draw the electrical block diagram",
    "Diagram the power path",
    "can you draw the power path for me",
    "let's diagram the power path",
    "I'd like a diagram of the electrical system",
    "build me a power path diagram",
    "chart the battery to wheel path",
  ],
  steps: [
    {
      say: "Drawing it left to right, with the voltage and peak current on every link.",
      delayMs: 800,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = openPage(ctx);
            if (!pageId) return null;
            return {
              pageId,
              html: `<p>The power path from the pack to the wheels:</p>\n${POWER_PATH}`,
            };
          },
        },
      ],
    },
  ],
};
