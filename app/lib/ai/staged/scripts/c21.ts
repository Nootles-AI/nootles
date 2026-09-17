import type { StagedScript } from "../types";
import { openPage } from "./resolve";

/** C-21 — FMEA. An afternoon of a team's life, with the RPN already multiplied. */
export const C21: StagedScript = {
  id: "C-21",
  title: "FMEA on the drive system",
  match:
    /\b(fmea|dfmea|pfmea|hazop|failure modes?|hazard analysis|risk register|risk table)\b|\bwhat could go wrong\b/i,
  says: [
    "run an FMEA on the drive system",
    "do an FMEA",
    "can you run the FMEA",
    "give me a failure mode analysis",
    "what could go wrong with the drive system",
    "build a risk register",
    "let's do a HAZOP",
    "fmea for the drivetrain",
    "Run an FMEA on the drive system",
    "let's run an fmea",
    "can you do a failure mode analysis",
    "I'd like an FMEA of the drivetrain",
    "put together a risk register",
    "run the hazard analysis",
  ],
  steps: [
    {
      say: "Twelve modes, sorted by risk priority. Two of them cross disciplines, which is usually where the real ones hide.",
      delayMs: 1000,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = openPage(ctx);
            if (!pageId) return null;
            const row = (
              item: string,
              mode: string,
              effect: string,
              s: number,
              o: number,
              d: number,
              fix: string,
              owner: string,
            ) =>
              `<tr><td>${item}</td><td>${mode}</td><td>${effect}</td><td>${s}</td><td>${o}</td><td>${d}</td><td><strong>${s * o * d}</strong></td><td>${fix}</td><td>${owner}</td></tr>`;
            return {
              pageId,
              html: `<h2>FMEA — drive system</h2>
<table>
<tr><th>Item</th><th>Failure mode</th><th>Effect</th><th>S</th><th>O</th><th>D</th><th>RPN</th><th>Mitigation</th><th>Owner</th></tr>
${row("Hub motor", "Phase-to-phase short", "Uncommanded braking torque; rover stops in a traffic lane", 9, 2, 4, "Phase-current trip at 1.3× rated — FW-204", "Dana")}
${row("Gate driver", "Shoot-through on desat", "Bus collapse, all four motors dead", 9, 2, 3, "Verify 2 µs dead-time on bench before EVT", "Dana")}
${row("Pack", "Cell venting at >60 °C", "Thermal event while parked outside", 10, 1, 4, "TV-023 oven soak; cut-out at 60 °C — REQ-012", "Marcus")}
${row("Teleop link", "Heartbeat lost mid-crossing", "Rover coasts into a crossing", 8, 4, 2, "REQ-015 — but see the 350 ms conformance gap", "Dana / Noor")}
${row("Encoder", "Intermittent A/B on vibration", "Torque ripple, nav thinks it has stalled", 6, 5, 3, "Shielded harness; plausibility check against back-EMF", "Priya / Dana")}
${row("Mast bracket", "Fatigue at the weld toe", "LiDAR pitch drifts, nav degrades silently", 7, 3, 4, "Modal analysis; 42 Hz mode is inside the motor band", "Priya")}
${row("E-stop contactor", "Welded contacts", "E-stop does nothing when pressed", 10, 1, 8, "Weekly continuity check into the pre-op checklist", "Noor")}
${row("BMS", "SoC drift over a shift", "Rover strands mid-route", 5, 5, 3, "Coulomb counting re-zeroed at every dock charge", "Marcus")}
${row("Wheel bearing", "Ingress at the seal", "Drag rises, range falls, no alarm", 4, 5, 5, "IP67 on the hub — REQ-008; current-draw trend alarm", "Priya")}
${row("DC-DC", "12 V rail brownout on peak draw", "Compute reboots under acceleration", 8, 2, 4, "Bulk capacitance sized for 48 A step; measure at EVT", "Marcus")}
${row("CAN bus", "Missing termination after rework", "Intermittent frame loss, blamed on firmware for a week", 6, 4, 6, "Both 120 Ω in the ICD diagram; continuity in the build checklist", "Marcus / Dana")}
${row("Firmware", "Watchdog task starved at prio 6", "Safe-stop late under load", 9, 2, 6, "Raise watchdog above motor_ctl, or move to RX interrupt", "Dana")}
</table>
<p>Top three by RPN are the welded contactor (80), the starved watchdog (108) and the missing termination (144). The last two are the same shape of problem: something that only shows up under load, and that nothing currently detects.</p>
<h3>Actions</h3>
<ul>
<li>Dana — move the heartbeat check into the CAN RX interrupt, this week</li>
<li>Marcus — continuity check for both terminations into the build checklist</li>
<li>Noor — E-stop contact check into the pre-op sheet before the first EVT run</li>
</ul>`,
            };
          },
        },
      ],
    },
  ],
};
