import type { StagedScript } from "../types";
import { openPage } from "./resolve";

/**
 * C-13 — the roadmap. Staged because C-14 reads what it draws.
 *
 * The float numbers on these bars are the ones C-14 quotes back, so the two
 * stay consistent whatever order the room asks them in.
 */
export const C13: StagedScript = {
  id: "C-13",
  title: "Roadmap to the demo",
  match: /\b(roadmap|road map|timeline|gantt|swimlanes?)\b|\b(the|our|a|this|project)\s+schedule\b/i,
  says: [
    "roadmap to the 8 Dec demo",
    "give me a roadmap",
    "draw the timeline",
    "can you do a gantt for this",
    "show me the schedule",
    "roadmap for the term",
    "map out the timeline to demo day",
    "swimlanes for each discipline",
    "Roadmap to the 8 Dec demo",
    "can I get a roadmap",
    "let's see a timeline",
    "build the project schedule",
    "draw me a gantt chart",
    "give me the roadmap to demo day",
  ],
  steps: [
    {
      say: "Five lanes, twelve weeks, and the long-lead part drawn as what it actually is — a bar that crosses two of them.",
      delayMs: 900,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = openPage(ctx);
            if (!pageId) return null;
            const lane = (y: number, name: string) =>
              `  <nt-text id="rm-l${y}" x="20" y="${y + 16}" w="140" h="24" style="font-size:13px;font-weight:600;color:#33415c">${name}</nt-text>`;
            return {
              pageId,
              html: `<p>Twelve weeks to the 8 December demo:</p>
<nt-diagram w="1240" h="460">
  <nt-text id="rm-title" x="20" y="16" w="500" h="28" style="font-size:18px;font-weight:600;color:#33415c">KR-1 — road to 8 Dec</nt-text>
${lane(70, "Mechanical")}
${lane(134, "Power")}
${lane(198, "Firmware")}
${lane(262, "Software")}
${lane(326, "Test")}
  <nt-rect id="rm-b1" x="180" y="66" w="250" h="40" style="background:#e8eef7;border:1px solid #3f5d84;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">Chassis v2 · 8 d float</nt-rect>
  <nt-rect id="rm-b2" x="450" y="66" w="300" h="40" style="background:#e8eef7;border:1px solid #3f5d84;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">Mast + bracket · 6 d float</nt-rect>
  <nt-rect id="rm-b3" x="180" y="130" w="620" h="40" style="background:#f7dede;border:2px solid #c0392b;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">DRV8353 — 12 wk lead · 0 d float</nt-rect>
  <nt-rect id="rm-b4" x="820" y="130" w="200" h="40" style="background:#e8eef7;border:1px solid #3f5d84;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">Pack build · 4 d</nt-rect>
  <nt-rect id="rm-b5" x="300" y="194" w="380" h="40" style="background:#f7dede;border:2px solid #c0392b;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">Motor control bring-up · 0 d float</nt-rect>
  <nt-rect id="rm-b6" x="700" y="194" w="220" h="40" style="background:#e8eef7;border:1px solid #3f5d84;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">Teleop failover · 9 d</nt-rect>
  <nt-rect id="rm-b7" x="240" y="258" w="420" h="40" style="background:#e8eef7;border:1px solid #3f5d84;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">Fleet routing · 11 d float</nt-rect>
  <nt-rect id="rm-b8" x="860" y="322" w="240" h="40" style="background:#f7dede;border:2px solid #c0392b;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">EVT campaign · 0 d float</nt-rect>
  <nt-polygon id="rm-m1" sides="4" x="430" y="392" w="26" h="26" style="fill:#3f5d84"></nt-polygon>
  <nt-text id="rm-m1t" x="392" y="422" w="110" h="20" style="font-size:11px;color:#33415c;text-align:center">PDR · 6 Oct</nt-text>
  <nt-polygon id="rm-m2" sides="4" x="790" y="392" w="26" h="26" style="fill:#3f5d84"></nt-polygon>
  <nt-text id="rm-m2t" x="752" y="422" w="110" h="20" style="font-size:11px;color:#33415c;text-align:center">CDR · 20 Oct</nt-text>
  <nt-polygon id="rm-m3" sides="4" x="1100" y="392" w="26" h="26" style="fill:#c0392b"></nt-polygon>
  <nt-text id="rm-m3t" x="1058" y="422" w="120" h="20" style="font-size:11px;color:#c0392b;text-align:center">Demo · 8 Dec</nt-text>
</nt-diagram>`,
            };
          },
        },
      ],
    },
  ],
};
