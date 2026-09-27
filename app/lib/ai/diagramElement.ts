/**
 * The `<nt-diagram>` element out of a builder's reply, or "". Models fence, and
 * sometimes preface — the element is the reply.
 *
 * A reply the token cap cut off has no closing tag, and demanding one threw
 * whole drawings away: a rich brief ("cinematic 3D, forced perspective") runs
 * long, the cap lands mid-shape, and the ninety complete shapes before the cut
 * were discarded with the half one — measured as a third of a board's draws
 * coming back empty and being expensively redrawn. Salvage instead: keep
 * everything up to the last complete element, close the diagram ourselves, and
 * let the parser's ordinary tolerance handle the seam.
 *
 * Pure, so the chat's `draw` tool and the completion lane's streamed preview
 * read a reply the same way — a stream still arriving is a reply cut off early.
 */
export function diagramElement(text: string): string {
  const whole = /<nt-diagram[\s\S]*<\/nt-diagram>/i.exec(text)?.[0];
  if (whole) return whole;
  const open = text.search(/<nt-diagram[\s>]/i);
  if (open === -1) return "";
  let body = text.slice(open);
  const opened = body.indexOf(">");
  if (opened === -1) return "";
  // Cut after the last complete closing tag, so what we close holds only
  // whole shapes — the tail is usually an element severed mid-attribute, or
  // mid-label, which the parser would keep with half its words.
  const lastClose = body.lastIndexOf("</nt-");
  const end = lastClose === -1 ? -1 : body.indexOf(">", lastClose);
  body = body.slice(0, end === -1 ? opened + 1 : end + 1);
  return `${body}\n</nt-diagram>`;
}
