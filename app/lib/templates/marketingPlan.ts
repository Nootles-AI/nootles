import { serializeAlbum } from "@/app/components/editor/album/serialize";
import type { AlbumItem } from "@/app/components/editor/album/types";
import { album, bullet, canvas, h2, p, table } from "./blocks";
import type { ProjectTemplate } from "./types";

/**
 * A marketing plan, as a scaffold: the plan on one page, a moodboard for how
 * it should look and feel, and an Execution folder of tables for who does what
 * and when.
 *
 * The moodboard's tiles are placeholders served from `public/`, each named for
 * the kind of reference that belongs there, so a new board shows its shape —
 * a hero across two columns, the rest around it — before anything is on it.
 */
const tile = (name: string, w: number, h: number, span?: number): AlbumItem => ({
  kind: "image",
  src: `/templates/moodboard/${name}.svg`,
  w,
  h,
  ...(span ? { span } : {}),
});

const MOODBOARD = serializeAlbum({
  items: [
    tile("hero", 1600, 1000, 2),
    tile("texture", 1000, 1250),
    tile("palette", 1000, 1000),
    tile("type", 1200, 800),
    tile("product", 1000, 1300),
    tile("people", 1200, 900),
    tile("place", 1000, 1200),
    tile("detail", 1200, 1200),
  ],
});

const CENTRED =
  "display: flex; align-items: center; justify-content: center; text-align: center";
const QUADRANT =
  `background: #f7f7f5; border: 1px solid #e4e4e0; border-radius: 10px; ${CENTRED}; ` +
  "color: #2b2b28; font-size: 13px";
const AXIS = `${CENTRED}; color: #6b6b66; font-size: 12px`;

/** Impact against effort, with the channels still to be placed on it. */
const PRIORITIES = `<nt-diagram h="328">
  <nt-rect id="quick-wins" x="156" y="24" w="200" h="120" style="${QUADRANT}">Quick wins</nt-rect>
  <nt-rect id="big-bets" x="364" y="24" w="200" h="120" style="${QUADRANT}">Big bets</nt-rect>
  <nt-rect id="fill-ins" x="156" y="152" w="200" h="120" style="${QUADRANT}">Fill-ins</nt-rect>
  <nt-rect id="money-pits" x="364" y="152" w="200" h="120" style="${QUADRANT}">Money pits</nt-rect>
  <nt-text id="effort" x="260" y="284" w="200" h="20" style="${AXIS}">Effort →</nt-text>
  <nt-text id="impact" x="78" y="138" w="120" h="20" rot="-90" style="${AXIS}">Impact →</nt-text>
</nt-diagram>`;

export const marketingPlan: ProjectTemplate = {
  id: "marketingPlan",
  name: "Marketing plan",
  description: "The plan, a moodboard, and tables for channels, calendar and results",
  rows: [
    {
      kind: "page",
      title: "Plan",
      blocks: [
        p("What this campaign is for, in a sentence someone outside the team would repeat."),
        h2("Goal"),
        p("One number and a date. Everything below is judged against it."),
        h2("Audience"),
        bullet("Who they are, and where they already spend their attention"),
        bullet("What they believe now, and what we want them to believe after"),
        h2("Message"),
        {
          type: "quote",
          content: "The one line every asset in this campaign has to be able to carry.",
        },
        h2("Budget"),
        table(
          ["Channel", "Budget", "Share"],
          ["Paid social", "", ""],
          ["Search", "", ""],
          ["Content", "", ""],
          ["Events", "", ""],
        ),
        p(
          "How it should look is on the Moodboard page; who does what, and when, is in the Execution folder.",
        ),
      ],
    },
    {
      kind: "page",
      title: "Moodboard",
      blocks: [
        p(
          "How the campaign should look and feel. Drop references onto the album — photos, screenshots, a film clip — and remove each placeholder once its slot is filled: hover a picture for its ×, and for the arrows that make it wider.",
        ),
        album(MOODBOARD),
        h2("In words"),
        bullet("Three adjectives it should feel like"),
        bullet("One thing it must never look like"),
      ],
    },
    {
      kind: "folder",
      title: "Execution",
      pages: [
        {
          title: "Channels",
          blocks: [
            p("Where the campaign runs. Place each channel on the grid before it earns a row."),
            canvas(PRIORITIES),
            table(
              ["Channel", "Objective", "Measure", "Owner"],
              ["Paid social", "Reach", "Cost per click", ""],
              ["Search", "Intent", "Conversion rate", ""],
              ["Newsletter", "Retention", "Open rate", ""],
              ["Launch event", "Press", "Mentions", ""],
            ),
          ],
        },
        {
          title: "Calendar",
          blocks: [
            p("What goes out, week by week. A row is a single asset with a single owner."),
            table(
              ["Week", "Channel", "Asset", "Owner", "Status"],
              ["1", "Newsletter", "Teaser", "", "Draft"],
              ["2", "Paid social", "Launch video", "", "Not started"],
              ["2", "Search", "Launch ads", "", "Not started"],
              ["3", "Launch event", "Keynote", "", "Not started"],
            ),
          ],
        },
        {
          title: "Results",
          blocks: [
            p("What happened, against what was planned. Fill it in weekly, not at the end."),
            table(
              ["Measure", "Target", "Actual", "Note"],
              ["", "", "", ""],
              ["", "", "", ""],
            ),
            h2("What we would do again"),
            bullet("One thing that worked, and why"),
          ],
        },
      ],
    },
  ],
};
