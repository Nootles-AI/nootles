/**
 * A caret's place in a label, as a number both sides can agree on.
 *
 * The editor's contentEditable and the rendered label are different DOM for
 * the same runs, so a selection cannot travel as a node reference. It travels
 * instead as an offset in the label's visible text — each character one unit,
 * a `<br>` one, a page chip one (it is atomic to the caret on both sides) —
 * counted by the same walk `labelOfElement` reads the words with. {@link
 * offsetIn} turns a live DOM position into that number on the broadcasting
 * side; {@link pointAt} turns it back into a DOM position against whatever
 * label DOM the receiving side has, clamping to the end when the streamed
 * text is still a debounce behind.
 */

const SKIPPED = new Set(["script", "style", "template"]);

const isRef = (el: Element): boolean =>
  el.tagName.toLowerCase() === "nt-ref" || el.hasAttribute("data-page");

export type LabelPoint = { node: Node; offset: number };

export function offsetIn(root: Element, node: Node, offset: number): number | null {
  if (!root.contains(node)) return null;
  let count = 0;
  let found: number | null = null;
  const visit = (n: Node): boolean => {
    if (n.nodeType === 3) {
      const len = (n.nodeValue ?? "").length;
      if (n === node) {
        found = count + Math.min(offset, len);
        return true;
      }
      count += len;
      return false;
    }
    if (n.nodeType !== 1) {
      if (n === node) {
        found = count;
        return true;
      }
      return false;
    }
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") {
      if (n === node) {
        found = count;
        return true;
      }
      count += 1;
      return false;
    }
    if (SKIPPED.has(tag) || isRef(el)) {
      const len = isRef(el) ? 1 : 0;
      if (n === node || el.contains(node)) {
        // Atomic: a position at its start is before it, anywhere else after.
        found = count + (n === node && offset === 0 ? 0 : len);
        return true;
      }
      count += len;
      return false;
    }
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (n === node && i === offset) {
        found = count;
        return true;
      }
      if (visit(kids[i])) return true;
    }
    if (n === node) {
      found = count;
      return true;
    }
    return false;
  };
  visit(root);
  return found;
}

export function pointAt(root: Element, target: number): LabelPoint {
  let remaining = Math.max(0, target);
  // Where the walk last stood — what a too-large offset clamps to.
  let last: LabelPoint = { node: root, offset: 0 };
  const visit = (n: Node): LabelPoint | null => {
    if (n.nodeType === 3) {
      const len = (n.nodeValue ?? "").length;
      if (remaining <= len) return { node: n, offset: remaining };
      remaining -= len;
      last = { node: n, offset: len };
      return null;
    }
    if (n.nodeType !== 1) return null;
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIPPED.has(tag)) return null;
    if (tag === "br" || isRef(el)) {
      const parent = el.parentNode;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.childNodes, el);
      if (remaining === 0) return { node: parent, offset: index };
      remaining -= 1;
      last = { node: parent, offset: index + 1 };
      return null;
    }
    for (let i = 0; i < el.childNodes.length; i++) {
      const hit = visit(el.childNodes[i]);
      if (hit) return hit;
    }
    return null;
  };
  if (remaining === 0 && root.childNodes.length === 0) return last;
  return visit(root) ?? last;
}
