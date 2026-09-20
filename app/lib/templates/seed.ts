"use client";

import { seedUpdate } from "@/app/lib/onboarding/seed";
import type { ProjectTemplate, TemplatePage } from "./types";

/**
 * A template as `projects.create` takes it: the same rows, with each page's
 * blocks turned into the Yjs update its document is born from.
 *
 * Its own module, reached by dynamic import: `seedUpdate` stands up a headless
 * editor, which brings BlockNote and every custom block with it. The projects
 * screen only pays for that at the moment a template is actually used.
 */
const born = (page: TemplatePage) => ({ title: page.title, update: seedUpdate(page.blocks) });

export const seedOf = (template: ProjectTemplate) =>
  template.rows.map((row) =>
    row.kind === "page"
      ? { kind: "page" as const, ...born(row) }
      : { kind: "folder" as const, title: row.title, pages: row.pages.map(born) },
  );
