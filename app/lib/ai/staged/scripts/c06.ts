import type { StagedScript } from "../types";
import { openPage } from "./resolve";

/**
 * C-06 — split the brief into one page per discipline.
 *
 * The only call in the set that changes the shape of the project, which is why
 * it belongs late in a run: everything after it sees five more pages. The new
 * ids come back as tool results in this same turn and the second step reads
 * them out of the transcript.
 */
export const C06: StagedScript = {
  id: "C-06",
  title: "Split into one page per discipline",
  match:
    /\b(split|break|separate|divide|carve)\b[^.?]{0,70}\b(pages?|disciplines?|teams?|sections?)\b|\bone page (per|for each)\b|\bpages? per (discipline|team|section)\b|\bpages? for each (discipline|team)\b/i,
  says: [
    "split this into one page per discipline",
    "split this into pages",
    "break this up into pages",
    "can you split the brief into separate pages",
    "one page per discipline please",
    "divide this into sections",
    "make a page for each team",
    "break this out into one page per discipline",
    "Split this into one page per discipline",
    "can you split this into pages",
    "let's break this into separate pages",
    "one page per team please",
    "split the brief up into pages",
    "break this out into a page for each discipline",
  ],
  steps: [
    {
      say: "One page per discipline. Watch the sidebar.",
      delayMs: 700,
      call: [
        { tool: "create_page", input: { title: "Mechanical" } },
        { tool: "create_page", input: { title: "Power & Electrical" } },
        { tool: "create_page", input: { title: "Firmware" } },
        { tool: "create_page", input: { title: "Software & Fleet" } },
      ],
    },
    {
      say:
        "Four made — you already have a Test & Validation page, so I left that one alone. " +
        "Links go back in the brief where each section used to be, so it still reads as one thing.",
      delayMs: 600,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = openPage(ctx);
            if (!pageId) return null;
            // The ids the five create_page calls just returned, paired by the
            // title each one came back with rather than by position — read out
            // of this turn rather than assumed.
            const made = new Map(
              ctx.results
                .filter((r) => r.toolName === "create_page")
                .map((r) => r.output as { pageId?: string; title?: string })
                .filter((it) => it?.pageId && it?.title)
                .map((it) => [it.title as string, it.pageId as string]),
            );
            const names = [
              "Mechanical",
              "Power & Electrical",
              "Firmware",
              "Software & Fleet",
            ];
            // "Power & Electrical" is a page title, but it is also markup the
            // moment it goes in a link. Escaped here rather than trusted.
            const esc = (text: string) =>
              text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const links = names
              .filter((name) => made.has(name))
              .map(
                (name) =>
                  `<li><nt-ref page="${made.get(name)}">${esc(name)}</nt-ref> — owner and open questions now live there</li>`,
              )
              .join("\n");
            // Nothing to link is nothing worth saying; the pages themselves are
            // already made and visible in the sidebar.
            if (!links) return null;
            return {
              pageId,
              html: `<h2>Discipline pages</h2>
<p>The brief keeps the programme-level decisions. Everything below the waterline moved out:</p>
<ul>
${links}
</ul>`,
            };
          },
        },
      ],
    },
  ],
};
