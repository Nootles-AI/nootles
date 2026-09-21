/**
 * Two families of BlockNote rules that style nothing here and cost a great deal.
 *
 * A `:has()` that is not the subject of its selector cannot be invalidated
 * precisely: the browser keeps ONE invalidation set for all of them, and a DOM
 * change under any element such a rule has tested is answered by sweeping that
 * element's subtree with the whole set. Our own `body:has(…)` rules make `body`
 * one of those elements, so the sweep is the page — and what it restyles is
 * whatever these rules put in the set:
 *
 * - Attribution marks (`.bn-suggestion-node…:has(.bn-block-content) > *`), made
 *   only by BlockNote's `YAttributionMarks`, which this app never loads. A
 *   universal subject turns the set into "everything".
 * - The nested-block indent guide (`.bn-block:not(:has(.bn-toggle-wrapper)) …
 *   .bn-block-outer::before`), which `editor.css` hides on every surface. It
 *   puts every block wrapper in the set.
 *
 * Measured on a 540-block page: each node view that mounted (a code block, a
 * math row, a diagram) restyled all ~8,000 elements — 57 times, 650ms of an
 * 800ms page open — and every frame of a shape drag restyled ~700.
 *
 * No rule added on top takes a selector back out of that machinery; it has to
 * leave the sheet. Done on the CSSOM rather than by forking BlockNote's CSS, so
 * an upgrade keeps everything else they ship.
 */
const DEAD: ReadonlyArray<(selector: string) => boolean> = [
  (s) => s.includes(".bn-suggestion-node") && s.includes(":has("),
  (s) => s.includes(":not(:has(.bn-toggle-wrapper))"),
];

const pruned = new WeakSet<CSSStyleSheet>();

export function dropDeadSelectors() {
  for (const sheet of document.styleSheets) {
    if (pruned.has(sheet)) continue;
    try {
      prune(sheet);
      pruned.add(sheet);
    } catch {
      // A cross-origin sheet cannot be read, and cannot be BlockNote's either.
    }
  }
}

function prune(group: CSSStyleSheet | CSSGroupingRule) {
  const rules = group.cssRules;
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule instanceof CSSStyleRule) {
      if (DEAD.some((dead) => dead(rule.selectorText))) group.deleteRule(i);
    } else if (rule instanceof CSSGroupingRule) {
      prune(rule);
    }
  }
}
