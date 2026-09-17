import type { StageContext } from "../types";

/**
 * The handful of things a script needs to look up.
 *
 * Every one of them returns null rather than guessing when the project is not
 * what the script expected. Null collapses the step to prose, which is how a
 * skipped beat or a renamed page degrades into an ordinary answer.
 */

/** The page the presenter is looking at. */
export function openPage(ctx: StageContext): string | null {
  return ctx.pageId ?? ctx.pages[0]?.pageId ?? null;
}

/** A page by what it is called, loosely — titles get renamed. */
export function pageLike(ctx: StageContext, what: RegExp): string | null {
  return ctx.pages.find((page) => what.test(page.title))?.pageId ?? null;
}

/** The most recent output of a given tool in this turn. */
export function lastOutput(ctx: StageContext, toolName: string): unknown {
  for (let i = ctx.results.length - 1; i >= 0; i--) {
    if (ctx.results[i].toolName === toolName) return ctx.results[i].output;
  }
  return undefined;
}

/** A tool result as text, whatever shape it came back in. */
export function asText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const it = output as { html?: unknown; text?: unknown; content?: unknown };
    for (const field of [it.html, it.text, it.content]) {
      if (typeof field === "string") return field;
    }
    try {
      return JSON.stringify(output);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * The id of the first canvas block in a page read.
 *
 * A default read projects a diagram as a stub that carries its block id —
 * `<nt-diagram id="b7" at="b7" holds="9 shapes" …>` — which is exactly enough
 * to ask for it in full on the next step. Read rather than remembered, so the
 * chained calls work on whatever diagram is actually there.
 */
export function canvasBlockId(ctx: StageContext): string | null {
  const html = asText(lastOutput(ctx, "read_open_page") ?? lastOutput(ctx, "read_page"));
  const found = /<nt-diagram\b[^>]*\bid="([^"]+)"/i.exec(html);
  return found ? found[1] : null;
}

/** The canvas markup itself, once a step has asked for it in full. */
export function canvasHtml(ctx: StageContext): string | null {
  const html = asText(lastOutput(ctx, "read_open_page") ?? lastOutput(ctx, "read_page"));
  const found = /<nt-diagram\b[^>]*>[\s\S]*?<\/nt-diagram\s*>/i.exec(html);
  // A stub closes immediately; a real read has shapes between the tags.
  return found && /<nt-(rect|ellipse|polygon|path|group|text|edge)\b/i.test(found[0])
    ? found[0]
    : null;
}

/** Shape ids on the canvas whose label matches, in document order. */
export function shapesLabelled(scene: string, label: RegExp): string[] {
  const out: string[] = [];
  const tag = /<nt-(?:rect|ellipse|polygon|path|group)\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/nt-(?:rect|ellipse|polygon|path|group)\s*>/gi;
  let found: RegExpExecArray | null;
  while ((found = tag.exec(scene))) {
    if (label.test(found[2].replace(/<[^>]+>/g, " "))) out.push(found[1]);
  }
  return out;
}

/** The project's linked repository, or null when none is linked. */
export function repo(ctx: StageContext): string | null {
  return ctx.repos[0] ?? null;
}
