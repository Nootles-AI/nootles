import { bullet, check, h2, p, table, toggle } from "./blocks";
import type { ProjectTemplate } from "./types";

/**
 * A team's recurring meetings, kept as running documents: the next agenda
 * open at the top, every past meeting folded into a toggle below it, and the
 * decisions pulled out into one log so they can be found without rereading
 * the notes they came from.
 */

const meeting = (date: string) =>
  toggle(
    date,
    p("Present:"),
    bullet("What was discussed, one line per topic"),
    p("Decided:"),
    check("Action — owner, by when"),
  );

export const meetingNotes: ProjectTemplate = {
  id: "meetingNotes",
  name: "Meeting notes",
  description: "A running weekly sync, one-to-ones, and a log of what was decided",
  rows: [
    {
      kind: "page",
      title: "Weekly sync",
      blocks: [
        p(
          "One page for the whole series. Add topics to the agenda as they come up; after the meeting, fold the notes into a toggle under Past meetings, newest first.",
        ),
        h2("Next agenda"),
        check("Topic — who raised it, and what they need from the room"),
        h2("Open actions"),
        check("Action — owner, by when"),
        h2("Past meetings"),
        meeting("Week 2"),
        meeting("Week 1"),
      ],
    },
    {
      kind: "page",
      title: "One-to-ones",
      blocks: [
        p(
          "Their agenda first, then yours. Anything either person wants to raise goes under Next time as soon as it comes up.",
        ),
        h2("Next time"),
        check("Anything either of you wants to raise"),
        h2("Past"),
        toggle(
          "First one-to-one",
          bullet("How are things, really?"),
          bullet("What is in your way?"),
          bullet("What do you want to be doing more of?"),
          check("Action — owner"),
        ),
      ],
    },
    {
      kind: "page",
      title: "Decisions",
      blocks: [
        p(
          "Every decision the team makes, in one place. When someone asks why, this is where the answer is.",
        ),
        table(
          ["Date", "Decision", "Why", "Decided by"],
          ["", "", "", ""],
          ["", "", "", ""],
        ),
      ],
    },
  ],
};
