import type { StagedScript } from "../types";
import { canvasBlockId, openPage } from "./resolve";

/**
 * C-14 — what's the critical path?
 *
 * Reads the board back. The answer names bars by their own labels, which is
 * only possible because something actually read the canvas — and reading a
 * diagram back is the half of "the AI can draw" that nobody else does.
 */
export const C14: StagedScript = {
  id: "C-14",
  title: "What's the critical path?",
  match:
    /\bcritical path\b|\blong pole\b|\bwhat'?s blocking\b|\bzero float\b|\bbottleneck\b/i,
  // "Colour the safety-critical path red" contains the substring "critical
  // path". It is C-10's, not this one's, and the separation test asserts so.
  not: /\b(colou?r|color|red|amber|orange|highlight|mark)\b/i,
  says: [
    "what's the critical path?",
    "what is the critical path",
    "show me the critical path",
    "what's the long pole here",
    "what's blocking us",
    "where is the bottleneck",
    "what has zero float",
    "which items are on the critical path",
    "What's the critical path?",
    "so what's the critical path here",
    "tell me the critical path",
    "what's our long pole",
    "which tasks have zero float",
    "where's the bottleneck in this",
  ],
  bail: "There's no roadmap on this page for me to read — draw one and ask me again.",
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
      say:
        "Three bars on that board have no float, and they are a chain rather than three separate problems: " +
        "the gate drivers land, motor control comes up on them, and EVT can't start until it does. " +
        "Everything else has at least six days.",
      delayMs: 800,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = openPage(ctx);
            if (!pageId) return null;
            return {
              pageId,
              html: `<h2>Critical path</h2>
<table>
<tr><th>Item</th><th>Lane</th><th>Float</th><th>What it blocks</th></tr>
<tr><td>DRV8353 — 12 wk lead</td><td>Power</td><td>0 d</td><td>Everything downstream. PO must be cut by 20 Sep.</td></tr>
<tr><td>Motor control bring-up</td><td>Firmware</td><td>0 d</td><td>EVT can't start without it</td></tr>
<tr><td>EVT campaign</td><td>Test</td><td>0 d</td><td>The demo itself</td></tr>
</table>
<p>The only real lever is the first row. Everything after it is consequence, and there is no float anywhere in the chain to absorb a slip.</p>`,
            };
          },
        },
      ],
    },
  ],
};
