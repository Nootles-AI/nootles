import type { StagedScript } from "../types";
import { openPage, pageLike, repo } from "./resolve";

/**
 * C-16 — does the firmware actually do what REQ-015 says?
 *
 * The flagship, and the one with the least fiction in it: the requirements
 * page is read off the live editor, the repository search and the file read
 * hit the team's real GitHub. Only the conclusion is written ahead, and the
 * conclusion is the one part a model would get wrong in front of a room.
 */
export const C16: StagedScript = {
  id: "C-16",
  title: "Does the firmware do what REQ-015 says?",
  match:
    /\bREQ[\s-]?0?15\b|\b(firmware|the code|our code|the implementation)\b[^?]{0,70}\b(match|matches|do what|does what|conform|conforms|actually do(?:es)?|agree|agrees|consistent|implements?|line up|lines up)\b|\b(match|matches|conform|conforms|agree|agrees|consistent|line up|lines up)\b[^?]{0,70}\b(the )?(spec|specs|requirements?)\b/i,
  says: [
    "does the firmware actually do what REQ-015 says?",
    "does the firmware match REQ-015?",
    "is the code consistent with REQ-015",
    "check REQ-015 against the firmware",
    "does our code actually do what the spec says",
    "does the implementation line up with the requirements?",
    "REQ-015 — does the firmware do that?",
    "can you check the firmware matches the spec",
    "Does the firmware actually do what REQ-015 says?",
    "can you check req 015 against the code",
    "is the firmware doing what req-015 asks",
    "does the code conform to the spec",
    "I want to know if the firmware matches REQ-015",
    "check the implementation against REQ-015 please",
  ],
  bail:
    "I can't find the requirements or the firmware source in this project — open the " +
    "KR-1 project and ask me again.",
  steps: [
    {
      say: "Let me read REQ-015 first, then go and look at what the firmware actually does.",
      delayMs: 700,
      call: [
        {
          tool: "read_page",
          input: (ctx) => {
            const pageId = pageLike(ctx, /requirement|traceab/i) ?? openPage(ctx);
            return pageId ? { pageId } : null;
          },
        },
      ],
    },
    {
      say: "REQ-015 asks for a controlled stop within 300 ms of losing the teleop heartbeat. Now the firmware.",
      delayMs: 500,
      call: [
        // Both optional, and that is the point: with a repository linked this
        // reads the team's real GitHub, and without one it reads the source
        // kept in the project. Either way the watchdog is read rather than
        // remembered — what must never happen is the demo's best call bailing
        // to prose because nobody linked a repo.
        {
          tool: "search_repo_code",
          optional: true,
          input: (ctx) => (repo(ctx) ? { query: "HEARTBEAT_TIMEOUT_MS" } : null),
        },
        {
          tool: "read_repo_file",
          optional: true,
          input: (ctx) => {
            const name = repo(ctx);
            return name ? { repo: name, path: "src/teleop/watchdog.c" } : null;
          },
        },
        // Not optional: this is what guarantees the step has something to do.
        // A step whose every call stood down would end the turn silently,
        // before the conclusion below ever gets written.
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
      say: "Found it, and the requirement fails — but not for the reason you'd expect. Writing it up on the page.",
      delayMs: 900,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = pageLike(ctx, /requirement|traceab/i) ?? openPage(ctx);
            if (!pageId) return null;
            return {
              pageId,
              html: `<h2>REQ-015 conformance check</h2>
<p>The constant is right and the requirement still fails. <code>HEARTBEAT_TIMEOUT_MS</code> is 300, exactly as REQ-015 asks — but the check is polled by a 50 ms task, so the worst case is 350 ms.</p>
<table>
<tr><th>What</th><th>Spec says</th><th>Code does</th><th>Verdict</th></tr>
<tr><td>Timeout value</td><td>300 ms</td><td><code>HEARTBEAT_TIMEOUT_MS 300</code> — <code>src/teleop/watchdog.c:7</code></td><td>Pass</td></tr>
<tr><td>Detection</td><td>on loss of heartbeat</td><td><code>&gt;=</code> at <code>watchdog.c:17</code>, evaluated by <code>watchdog_task</code> every 50 ms (<code>:8</code>, <code>:28</code>)</td><td>Pass</td></tr>
<tr><td><strong>Worst case to stop</strong></td><td><strong>300 ms</strong></td><td><strong>350 ms</strong> (300 + one poll period)</td><td><strong>FAIL</strong></td></tr>
</table>
<blockquote><p>Two ways out: move the check into the CAN RX interrupt so it fires on arrival rather than on the tick, or drop <code>HEARTBEAT_TIMEOUT_MS</code> to 250 and keep the poll. The first is correct, the second ships this week.</p></blockquote>
<p>Nobody would have caught this by reading either document on its own — the requirement is right, the constant is right, and the gap is the task period in between.</p>`,
            };
          },
        },
      ],
    },
  ],
};
