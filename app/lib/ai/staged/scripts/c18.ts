import type { StagedScript } from "../types";
import { openPage } from "./resolve";

/** C-18 — does this motor meet REQ-014? Maths on the page, not in the transcript. */
export const C18: StagedScript = {
  id: "C-18",
  title: "Does this motor meet REQ-014?",
  match:
    /\bREQ[\s-]?0?14\b|\b(motor|torque|gradeability|drivetrain)\b[^?]{0,70}\b(meet|meets|satisfy|satisfies|makes?|enough|handle|handles|cut it|up to it|strong enough)\b|\b(meet|meets|satisfy|satisfies|makes?)\b[^?]{0,50}\b(the )?(torque|stopping|gradeability|payload)\b/i,
  says: [
    "does this motor meet REQ-014?",
    "is the motor strong enough",
    "can the motor handle a 22% grade",
    "does the motor meet the torque requirement",
    "is this motor enough for 40 kg",
    "will the drivetrain cut it at 50 kg",
    "check REQ-014",
    "does the motor satisfy the stopping requirement",
    "Does this motor meet REQ-014?",
    "is the motor up to it",
    "can this motor handle the payload",
    "does the motor make the torque requirement",
    "is the drivetrain enough for a 22% grade",
    "will the motor satisfy req 014",
  ],
  steps: [
    {
      say: "Running it against the datasheet numbers rather than the ones in the BOM — those two disagree.",
      delayMs: 900,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = openPage(ctx);
            if (!pageId) return null;
            return {
              pageId,
              html: `<h2>REQ-014 — gradeability check</h2>
<p>Passes at the 40 kg design payload with 1.6× margin. Fails at 50 kg on the steepest campus grade.</p>
<nt-math-block>
<nt-math-line>T_{wheel} = T_{stall} \\cdot i \\cdot \\eta = 2.4\\,\\mathrm{N\\,m} \\times 18 \\times 0.88 = 38.0\\,\\mathrm{N\\,m}</nt-math-line>
<nt-math-line>F_{trac} = \\frac{4\\,T_{wheel}}{r} = \\frac{4 \\times 38.0}{0.1575} = 965\\,\\mathrm{N}</nt-math-line>
<nt-math-line>F_{grade} = m g \\sin(\\arctan s) + m g \\mu \\cos(\\arctan s)</nt-math-line>
</nt-math-block>
<table>
<tr><th>Payload</th><th>Total mass</th><th>6% grade</th><th>15% grade</th><th>22% grade</th></tr>
<tr><td>35 kg</td><td>76 kg</td><td>2.9×</td><td>2.0×</td><td>1.8×</td></tr>
<tr><td><strong>40 kg</strong></td><td><strong>81 kg</strong></td><td><strong>2.7×</strong></td><td><strong>1.9×</strong></td><td><strong>1.6×</strong></td></tr>
<tr><td>50 kg</td><td>91 kg</td><td>2.4×</td><td>1.3×</td><td><strong>0.9× — fails</strong></td></tr>
</table>
<p>Two things worth saying out loud. The datasheet's phase resistance is 0.12 Ω, not the 0.09 Ω the BOM assumed, which is where the 1.6 came from rather than 1.9. And 50 kg is not a hypothetical — it is what the loading dock brief asks for in <code>REQ-002</code>.</p>`,
            };
          },
        },
      ],
    },
  ],
};
