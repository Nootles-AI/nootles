import { SCRIPTS } from "@/app/lib/ai/staged/scripts";
import type { StageContext } from "@/app/lib/ai/staged/types";

/**
 * Every `<nt-diagram>` the staged calls write, pulled out for the browser
 * runner. Node-platform bundle: pure script data and resolvers, no DOM.
 */

const ctx: StageContext = {
  projectId: "p1",
  pageId: "pg_open",
  said: "",
  results: [],
  pages: [{ pageId: "pg_open", title: "ICD" }],
};

export function diagrams(): { id: string; title: string; html: string }[] {
  const out: { id: string; title: string; html: string }[] = [];
  for (const script of SCRIPTS) {
    for (const step of script.steps) {
      for (const call of step.call ?? []) {
        if (call.tool !== "edit_page") continue;
        const input =
          typeof call.input === "function"
            ? (call.input as (c: StageContext) => { html?: string } | null)(ctx)
            : (call.input as { html?: string });
        if (!input?.html) continue;
        for (const found of input.html.matchAll(/<nt-diagram[\s\S]*?<\/nt-diagram\s*>/gi)) {
          out.push({ id: script.id, title: script.title, html: found[0] });
        }
      }
    }
  }
  return out;
}
