import type { SeedBlock } from "@/app/lib/onboarding/types";

/**
 * The KR-1 demo project — the document every staged call reads from.
 *
 * Team Kestrel, a multidisciplinary capstone team building a solar-assisted
 * campus delivery rover. Six disciplines in one project, which is the point:
 * the calls that land hardest are the ones that read two pages nobody reads
 * together.
 *
 * Every number here is load-bearing somewhere. The 300 ms in REQ-015 is what
 * C-16 checks the firmware against; the 45 °C in the thermal budget is what
 * T-07's completion picks up; the four uncovered requirements are the ones C-05
 * finds. Change a number here and a staged answer stops being true.
 *
 * The five discipline sections live INSIDE the brief on purpose — C-06 is what
 * splits them into pages. Test & Validation is a page from the start, because
 * C-05 runs long before C-06 does.
 */

const p = (text: string): SeedBlock => ({ type: "paragraph", content: text });
const h = (level: 1 | 2 | 3, text: string): SeedBlock => ({
  type: "heading",
  props: { level },
  content: text,
});
const li = (text: string): SeedBlock => ({ type: "bulletListItem", content: text });
const todo = (text: string): SeedBlock => ({ type: "checkListItem", content: text });
const cell = (text: string) => ({ type: "tableCell" as const, content: [text] });
const table = (headerAndRows: string[][]): SeedBlock => ({
  type: "table",
  content: {
    type: "tableContent",
    headerRows: 1,
    rows: headerAndRows.map((cells) => ({ cells: cells.map(cell) })),
  },
});

/** REQ-008, 012, 018 and 020 are deliberately absent from the test plan. */
const REQUIREMENTS: string[][] = [
  ["ID", "Requirement", "Verification", "Owner"],
  ["REQ-001", "The rover shall carry a payload of 40 kg on the campus loop.", "TV-001, loaded run", "Noor"],
  ["REQ-002", "The rover shall accept a peak payload of 50 kg at the loading dock.", "TV-002, static load", "Priya"],
  ["REQ-008", "The chassis shall meet IP54 against rain and sprinklers.", "—", "—"],
  ["REQ-012", "The pack shall cut out above 60 °C cell temperature.", "—", "Marcus"],
  [
    "REQ-014",
    "The rover shall climb a 22% grade fully laden without thermal derate.",
    "TV-014, ramp rig",
    "Priya",
  ],
  [
    "REQ-015",
    "The rover shall reach a controlled stop within 300 ms of losing the teleop heartbeat.",
    "TV-015, HIL bench",
    "Dana",
  ],
  ["REQ-018", "Radiated emissions shall meet CISPR 32 Class B.", "—", "—"],
  ["REQ-020", "The rover shall run two hours continuous at 30 °C ambient.", "—", "Ije"],
  ["REQ-021", "The operator shall be able to stop the rover from the teleop console.", "TV-021, console", "Ije"],
];

const TESTS: string[][] = [
  ["Test", "Covers", "Rig", "Status"],
  ["TV-001", "REQ-001", "Campus loop, loaded", "Passed 2026-08-30"],
  ["TV-002", "REQ-002", "Static load frame", "Passed 2026-09-02"],
  ["TV-014", "REQ-014", "Ramp rig, 6 / 15 / 22%", "Blocked — no gate drivers"],
  ["TV-015", "REQ-015", "HIL bench", "Not started"],
  ["TV-021", "REQ-021", "Teleop console", "Passed 2026-09-09"],
];

export type DemoPage = { title: string; blocks: SeedBlock[] };

export const KESTREL_PROJECT = {
  title: "KR-1 — Team Kestrel",
  description: "Solar-assisted autonomous campus delivery rover. Capstone, 2026.",
  /** What the agent is told this project is, as the context sheet's Q&A. */
  context: [
    {
      question: "What is this project?",
      answer:
        "KR-1, a solar-assisted autonomous campus delivery rover built by Team Kestrel — a " +
        "six-discipline capstone team. Demo day is 8 December 2026.",
    },
    {
      question: "Who is on the team?",
      answer:
        "Priya (mechanical / structures), Marcus (power & electrical), Dana (firmware), " +
        "Ije (software & fleet), Sam (industrial design), Noor (systems & test).",
    },
    {
      question: "What matters most right now?",
      answer:
        "Closing the gate-driver lead time, getting motor control onto the bench, and " +
        "arriving at CDR on 20 October with every requirement traced to a test.",
    },
  ],
};

export const KESTREL_PAGES: DemoPage[] = [
  {
    title: "Program Brief",
    blocks: [
      p(
        "KR-1 carries a 40 kg payload around the campus loop without a driver, and hands it " +
          "over at the door. Demo day is 8 December.",
      ),
      p(
        "This page is the whole programme in one place, which is why it has stopped being " +
          "readable. Five disciplines, five sections, one document nobody opens.",
      ),

      h(2, "Mechanical"),
      p(
        "Chassis v2 is a welded 6061 frame on four 315 mm hub-motor wheels. Worst-case stack " +
          "on the bearing bore is ±0.11 mm against a 0.15 mm budget — 27% margin, and we hold " +
          "the arithmetic number rather than RSS because the press fit is not independent of " +
          "the bore.",
      ),
      p(
        "Open: the mast bracket's first mode came out at 42 Hz, which sits inside the motor's " +
          "38–46 Hz band at top speed. Priya is re-running it with the revised bracket.",
      ),

      h(2, "Power & Electrical"),
      p(
        "8s4p 18650 pack, 991 Wh installed against 386 Wh needed for the 6 km route — 2.6× on " +
          "paper, 1.8× at 80% depth of discharge. 48 V bus, because it halves conductor " +
          "current for the same wheel power and keeps us on 14 AWG and under the 60 V SELV " +
          "line, where the safety case gets expensive.",
      ),
      h(3, "Thermal budget"),
      p(
        "Motor thermal resistance is 1.8 K/W with a 240 J/K mass, so the time constant is " +
          "432 s and steady-state rise at 12 A is 31 K. Above 45 °C pack temperature the " +
          "firmware derates the current limit to 70%. Above 60 °C the pack cuts out entirely " +
          "(REQ-012).",
      ),
      p(
        "The long pole is the DRV8353RS gate driver at a 12-week lead. That PO has to be cut " +
          "by 20 September or the whole schedule moves.",
      ),

      h(2, "Firmware"),
      p(
        "FreeRTOS on four STM32G4 motor controllers and one compute node, CAN 2.0B at " +
          "500 kbit/s between them. Six tasks; motor control runs at 1 kHz, the teleop " +
          "watchdog polls at 50 ms, telemetry reports at 10 Hz.",
      ),
      p(
        "The heartbeat timeout is 300 ms, matching REQ-015. Nobody has checked what the poll " +
          "period does to that number.",
      ),

      h(2, "Software & Fleet"),
      p(
        "Route planning and dispatch run in the cloud; the rover holds a 200 m horizon " +
          "locally so a dropped link is a slow stop rather than a stranded rover. The teleop " +
          "console is the operator's whole view: video, link health, map, and one very large " +
          "red button.",
      ),

      h(2, "Systems & Test"),
      p(
        "Twenty-one requirements, of which seventeen are traced to a test. Gate reviews are " +
          "PDR on 6 October and CDR on 20 October; EVT starts 3 November and the demo is " +
          "8 December, which leaves nine working days of float.",
      ),
    ],
  },

  {
    title: "Requirements & Traceability",
    blocks: [
      p(
        "Twenty-one requirements. Shall-form, each with its verification method and owner. " +
          "A dash in either column is a gap, not a formatting choice.",
      ),
      table(REQUIREMENTS),
      p(
        "REQ-015 is the one the safety case leans on: the rover must be stopped, not merely " +
          "commanded to stop, within 300 ms of the operator's link going quiet.",
      ),
    ],
  },

  {
    title: "Test & Validation",
    blocks: [
      p("The test plan as it stands. Five procedures written, two of them not yet run."),
      table(TESTS),
      p(
        "TV-014 is blocked on the gate drivers, which is the same lead time that blocks " +
          "everything else. TV-015 needs the HIL bench, which exists but has never been " +
          "wired to a real motor controller.",
      ),
    ],
  },

  {
    title: "ICD",
    blocks: [
      p(
        "Interface control between the compute node and the four motor controllers. This " +
          "page is a placeholder — the message table and the bus topology have been on " +
          "Dana's list since August.",
      ),
      p(
        "What we know: CAN 2.0B, 500 kbit/s, both ends terminated at 120 Ω, and every cyclic " +
          "message needs a defined action for when it does not arrive.",
      ),
    ],
  },

  {
    /**
     * The code C-16 checks REQ-015 against, and T-20 cites.
     *
     * Ideally this lives in a linked GitHub repository and the agent reads it
     * with the repo tools — that is the stronger claim and the scripts still
     * prefer it. But a project with no repo linked must not leave the demo's
     * best call bailing to prose, so the source is also here, in the project,
     * where a page read can reach it.
     *
     * The line numbers are load-bearing: C-16 cites watchdog.c:7 and :17, and
     * they have to be those lines in the block below.
     */
    title: "Firmware source",
    blocks: [
      p(
        "Excerpts kept on the page so the whole team can read them without a checkout. " +
          "The teleop watchdog is the one the safety case leans on.",
      ),
      h(2, "src/teleop/watchdog.c"),
      {
        type: "codeBlock",
        props: {
          language: "c",
          code: `/* KR-1 teleop watchdog — Team Kestrel */
#include "watchdog.h"
#include "can.h"
#include "safety.h"

/* REQ-015: controlled stop within 300 ms of losing the operator heartbeat. */
#define HEARTBEAT_TIMEOUT_MS 300
#define WATCHDOG_PERIOD_MS    50

static volatile uint32_t last_beat_ms;

void watchdog_on_heartbeat(uint32_t now_ms) {
    last_beat_ms = now_ms;
}

static bool link_lost(uint32_t now_ms) {
    return (now_ms - last_beat_ms) >= HEARTBEAT_TIMEOUT_MS;
}

void watchdog_task(void *arg) {
    (void)arg;
    TickType_t next = xTaskGetTickCount();
    for (;;) {
        uint32_t now = millis();
        if (link_lost(now)) {
            safety_request_stop(STOP_REASON_LINK_LOST);
        }
        vTaskDelayUntil(&next, pdMS_TO_TICKS(WATCHDOG_PERIOD_MS));
    }
}`,
        },
      },
      h(2, "src/rtos/tasks.c — priorities and periods"),
      table([
        ["Task", "File", "Priority", "Period"],
        ["can_rx", "src/can/rx.c", "7", "ISR"],
        ["motor_ctl", "src/motor/control.c", "6", "1 kHz"],
        ["safety", "src/safety/monitor.c", "6", "1 kHz"],
        ["teleop_wd", "src/teleop/watchdog.c", "5", "50 ms"],
        ["nav", "src/nav/plan.c", "3", "20 Hz"],
        ["telemetry", "src/tlm/report.c", "2", "10 Hz"],
      ]),
    ],
  },

  {
    title: "Meeting notes — 2026-09-14",
    blocks: [
      p("Present: Priya, Marcus, Dana, Ije, Noor. Sam away."),
      li("Marcus: gate driver quote came back at 12 weeks, not 8. PO has to go out this week."),
      li("Priya: mast bracket mode is at 42 Hz, inside the motor band. Re-running with the revision."),
      li("Dana: motor control is turning a wheel on the bench. Teleop failover not started."),
      li("Ije: route planner handles the loop; the console is wireframes on paper."),
      li("Noor: four requirements still have no test, and one of those has no owner either."),
      h(2, "Actions"),
      todo("Marcus to cut the DRV8353 PO before 20 Sep"),
      todo("Priya to re-run the modal analysis and post the first three modes before Thursday"),
      todo("Noor to find owners for REQ-008 and REQ-018"),
      todo("Dana to work out whether the watchdog actually meets REQ-015"),
    ],
  },

  {
    title: "BLDC-4210 datasheet notes",
    blocks: [
      p(
        "Read off the vendor datasheet, revision C. Three of these disagree with what the " +
          "BOM assumed, which is worth knowing before the next margin argument.",
      ),
      table([
        ["Parameter", "Datasheet", "BOM assumed", ""],
        ["Kv", "42 rpm/V", "42 rpm/V", "agrees"],
        ["Phase resistance", "0.12 Ω", "0.09 Ω", "disagrees"],
        ["Continuous current", "9 A", "9 A", "agrees"],
        ["Peak current", "24 A for 30 s", "30 A", "disagrees"],
        ["Stall torque", "2.4 N·m", "2.4 N·m", "agrees"],
        ["Thermal resistance", "1.8 K/W", "1.4 K/W", "disagrees"],
        ["Mass", "1.9 kg", "1.9 kg", "agrees"],
      ]),
      p("Gearbox is 18:1 at 88% efficiency. Wheel radius 157.5 mm."),
    ],
  },
];
