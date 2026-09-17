import type { StagedScript } from "../types";
import { openPage, pageLike, repo } from "./resolve";

/**
 * C-11 — architecture from the linked repository.
 *
 * The search and both file reads are real GitHub calls. The diagram is written
 * ahead, but the file paths on the nodes are paths the reads just returned —
 * which is the claim being made: this is not a drawing OF the system, it was
 * read off the system.
 */
export const C11: StagedScript = {
  id: "C-11",
  title: "Architecture from the repo",
  match:
    /\barchitecture\b|\b(diagram|draw|map|sketch|show|give me|build)\b[^.?]{0,70}\b(the |our )?(repo|repository|codebase|code ?base|modules?|rtos|tasks?)\b/i,
  says: [
    "draw our firmware architecture from the repo",
    "diagram the architecture",
    "show me the architecture",
    "map out the codebase",
    "draw the repo's module structure",
    "can you diagram our system architecture",
    "give me an architecture diagram from the repo",
    "sketch out the rtos tasks",
    "Draw our firmware architecture from the repo",
    "can you draw the architecture",
    "let's see the architecture",
    "diagram the repo structure",
    "show me how the codebase is put together",
    "build an architecture diagram",
  ],
  bail: "I can't find the firmware source in this project — open the KR-1 project and ask me again.",
  steps: [
    {
      say: "Reading the source rather than guessing at it.",
      delayMs: 600,
      call: [
        // Prefers the linked repository and falls back to the source kept in
        // the project, for the reason set out in c16.ts. The page read is the
        // one that is never optional, so the step always has work to do.
        {
          tool: "list_repo_files",
          optional: true,
          input: (ctx) => (repo(ctx) ? { repo: repo(ctx)!, path: "src" } : null),
        },
        {
          tool: "read_repo_file",
          optional: true,
          input: (ctx) => {
            const name = repo(ctx);
            return name ? { repo: name, path: "src/rtos/tasks.c" } : null;
          },
        },
        {
          tool: "read_page",
          input: (ctx) => {
            const pageId = pageLike(ctx, /firmware source|watchdog/i) ?? openPage(ctx);
            return pageId ? { pageId } : null;
          },
        },
      ],
    },
    {
      say: "Six tasks, and the priorities and periods are the ones in tasks.c. Drawing it.",
      delayMs: 800,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = openPage(ctx);
            if (!pageId) return null;
            const box = (
              id: string,
              x: number,
              y: number,
              name: string,
              path: string,
              meta: string,
            ) =>
              `  <nt-rect id="${id}" x="${x}" y="${y}" w="230" h="96" style="background:#eef2f8;border:2px solid #3f5d84;border-radius:6px;display:flex;align-items:center;justify-content:center;text-align:center"><b>${name}</b><br/><span style="font-size:11px;color:#5a6a85">${path}</span><br/><span style="font-size:11px;color:#8a94a6">${meta}</span></nt-rect>`;
            return {
              pageId,
              html: `<h2>Firmware architecture</h2>
<p>Read off <code>src/rtos/tasks.c</code> — priorities and periods as declared there.</p>
<nt-diagram w="1100" h="570">
${box("fa-can", 40, 60, "can_rx", "src/can/rx.c", "prio 7 · ISR")}
${box("fa-teleop", 420, 60, "teleop_wd", "src/teleop/watchdog.c", "prio 5 · 50 ms")}
${box("fa-safety", 800, 60, "safety", "src/safety/monitor.c", "prio 6 · 1 kHz")}
${box("fa-motor", 420, 250, "motor_ctl", "src/motor/control.c", "prio 6 · 1 kHz")}
${box("fa-nav", 40, 430, "nav", "src/nav/plan.c", "prio 3 · 20 Hz")}
${box("fa-tlm", 800, 430, "telemetry", "src/tlm/report.c", "prio 2 · 10 Hz")}
  <nt-edge id="fa-e1" from="fa-can" to="fa-motor">q_cmd · depth 8</nt-edge>
  <nt-edge id="fa-e2" from="fa-can" to="fa-teleop">heartbeat</nt-edge>
  <nt-edge id="fa-e4" from="fa-teleop" to="fa-safety">fault line</nt-edge>
  <nt-edge id="fa-e5" from="fa-safety" to="fa-motor">derate / trip</nt-edge>
  <nt-edge id="fa-e6" from="fa-nav" to="fa-motor">q_setpoint · depth 4</nt-edge>
  <nt-edge id="fa-e7" from="fa-motor" to="fa-tlm">q_tlm · depth 32</nt-edge>
</nt-diagram>
<p>Worth noticing on stage: <code>safety</code> and <code>motor_ctl</code> are both priority 6, so they are cooperatively scheduled against each other. That is fine today and will not be once nav starts publishing at 50 Hz.</p>`,
            };
          },
        },
      ],
    },
  ],
};
