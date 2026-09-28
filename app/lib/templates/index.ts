import { toAny } from "@/app/lib/onboarding/preview";
import type { AnyBlock } from "@/app/lib/ai/projection";
import { courseNotes } from "./courseNotes";
import { itinerary } from "./itinerary";
import { marketingPlan } from "./marketingPlan";
import { meetingNotes } from "./meetingNotes";
import { offsite } from "./offsite";
import { postmortem } from "./postmortem";
import { prd } from "./prd";
import { roadmap } from "./roadmap";
import { techDesign } from "./techDesign";
import type { ProjectTemplate, TemplatePage } from "./types";
import { userResearch } from "./userResearch";
import { videoShoot } from "./videoShoot";

export type { ProjectTemplate, TemplatePage, TemplateRow } from "./types";

/**
 * Building a product first, then running a team, then the work around a
 * launch, then plans that are not software at all.
 */
export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  prd,
  techDesign,
  roadmap,
  userResearch,
  postmortem,
  meetingNotes,
  marketingPlan,
  videoShoot,
  offsite,
  itinerary,
  courseNotes,
];

export const findTemplate = (id: string) => PROJECT_TEMPLATES.find((t) => t.id === id);

/** Every page a template makes, in sidebar order. */
export const pagesOf = (template: ProjectTemplate): TemplatePage[] =>
  template.rows.flatMap((row) => (row.kind === "page" ? [row] : row.pages));

/**
 * A page as the thumbnail renderer reads it, under its own title — which in a
 * real page is the heading above the document rather than a block in it.
 */
export function pagePicture(page: TemplatePage): AnyBlock[] {
  return [
    {
      id: "title",
      type: "heading",
      props: { level: 1 },
      content: [{ type: "text", text: page.title, styles: {} }],
    },
    ...page.blocks.map(toAny),
  ];
}
