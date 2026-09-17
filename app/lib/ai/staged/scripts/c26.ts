import type { StagedScript } from "../types";
import { openPage } from "./resolve";

/**
 * C-26 — two chassis layouts. The closer.
 *
 * Two variants land side by side in review state and the presenter keeps one.
 * Ending on a human decision is the point: the demo closes on "the AI
 * proposes, you decide" rather than on a magic trick.
 */
export const C26: StagedScript = {
  id: "C-26",
  title: "Two chassis layouts",
  match:
    /\b(two|2|three|3|a couple|a few|some)\b[^.?]{0,50}\b(versions?|options?|takes?|variants?|concepts?|layouts?|directions?|alternatives?)\b|\b(give|show) me (some |a few )?(options|alternatives|variants)\b/i,
  says: [
    "give me two chassis layouts",
    "two versions please",
    "can I see a couple of options",
    "show me two concepts",
    "give me a few variants",
    "three layouts",
    "show me some alternatives",
    "two takes on the chassis",
    "Give me two chassis layouts",
    "can I see two versions",
    "let's see a couple of layouts",
    "show me two options",
    "give me 2 concepts",
    "a few directions please",
  ],
  steps: [
    {
      say: "Two, side by side. They differ in one decision — where the pack sits — and everything else follows from it.",
      delayMs: 900,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = openPage(ctx);
            if (!pageId) return null;
            return {
              pageId,
              html: `<h2>Chassis layout — two options</h2>
<nt-diagram w="1220" h="420">
  <nt-text id="ch-a-t" x="40" y="20" w="480" h="26" style="font-size:16px;font-weight:600;color:#33415c">A — mid-mount pack</nt-text>
  <nt-rect id="ch-a-body" x="40" y="60" w="520" h="220" style="background:#f7f8fb;border:2px solid #3f5d84;border-radius:10px"></nt-rect>
  <nt-rect id="ch-a-pack" x="200" y="130" w="200" h="90" style="background:#dce9dc;border:2px solid #4a7a4a;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:13px">Pack</nt-rect>
  <nt-rect id="ch-a-bay" x="410" y="90" w="130" h="70" style="background:#eef2f8;border:1px solid #9aa5b8;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">Cargo</nt-rect>
  <nt-ellipse id="ch-a-w1" x="80" y="258" w="64" h="64" style="background:#33415c"></nt-ellipse>
  <nt-ellipse id="ch-a-w2" x="456" y="258" w="64" h="64" style="background:#33415c"></nt-ellipse>
  <nt-text id="ch-b-t" x="660" y="20" w="480" h="26" style="font-size:16px;font-weight:600;color:#33415c">B — rear-mount pack</nt-text>
  <nt-rect id="ch-b-body" x="660" y="60" w="520" h="220" style="background:#f7f8fb;border:2px solid #3f5d84;border-radius:10px"></nt-rect>
  <nt-rect id="ch-b-pack" x="990" y="130" w="160" h="120" style="background:#dce9dc;border:2px solid #4a7a4a;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:13px">Pack</nt-rect>
  <nt-rect id="ch-b-bay" x="700" y="90" w="260" h="130" style="background:#eef2f8;border:1px solid #9aa5b8;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">Cargo</nt-rect>
  <nt-ellipse id="ch-b-w1" x="700" y="258" w="64" h="64" style="background:#33415c"></nt-ellipse>
  <nt-ellipse id="ch-b-w2" x="1076" y="258" w="64" h="64" style="background:#33415c"></nt-ellipse>
</nt-diagram>
<table>
<tr><th></th><th>A — mid-mount</th><th>B — rear-mount</th></tr>
<tr><td>CG height</td><td>288 mm — lower, better on the 22% grade</td><td>341 mm</td></tr>
<tr><td>Service access</td><td>Pack comes out downward, rover on stands</td><td>Pack slides out the back in 90 s</td></tr>
<tr><td>Harness</td><td>1.4 m to the rear motors</td><td>0.6 m — less drop, less weight</td></tr>
<tr><td>Cargo volume</td><td>38 L</td><td>61 L</td></tr>
</table>
<p>A is the better vehicle and B is the better product. Pick one and I'll discard the other.</p>`,
            };
          },
        },
      ],
    },
  ],
};
