import type { Template, TemplateId } from "../types";
import { prd } from "./prd";
import { techDesign } from "./techDesign";
import { research } from "./research";
import { classNotes } from "./classNotes";
import { screenplay } from "./screenplay";
import { woodworking } from "./woodworking";

/**
 * Order is the order the survey shows them in. Work first, then study, then the
 * two that are neither — a person who plans furniture rather than launches
 * should reach the end of the row and find themselves there, instead of reading
 * six variations on a job they do not have.
 */
export const TEMPLATES: readonly Template[] = [
  prd,
  techDesign,
  research,
  classNotes,
  screenplay,
  woodworking,
];

export function templateById(id: string): Template | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

export type { Template, TemplateId };
