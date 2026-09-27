/** What the "/" and "@" menus rank an item by. */
export type RankedItem = { title: string; aliases?: string[]; group?: string };

/**
 * How well an item answers what was typed; lower is better, 6 is no answer.
 *
 * An item NAMED what was typed comes first — "/media" lands on Media, not on
 * the first thing with a "media" alias — and an item that answers to it by
 * alias comes next, ahead of one whose title merely starts or contains it:
 * "/canvas" means the Diagram, which answers to "canvas", before "Wide canvas".
 * Past the whole words, a title outranks an alias at each step.
 */
function score(item: RankedItem, q: string): number {
  const title = item.title.toLowerCase();
  const aliases = (item.aliases ?? []).map((a) => a.toLowerCase());
  if (title === q) return 0;
  if (aliases.includes(q)) return 1;
  if (title.startsWith(q)) return 2;
  if (aliases.some((a) => a.startsWith(q))) return 3;
  if (title.includes(q)) return 4;
  if (aliases.some((a) => a.includes(q))) return 5;
  return 6;
}

/**
 * The items that answer `query`, best first. Ranking moves whole groups (by
 * their best item), never items across groups, so each group stays one
 * contiguous — one-keyed — section of the menu.
 */
export function filterItems<T extends RankedItem>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const kept = items
    .map((item, index) => ({ item, index, score: score(item, q) }))
    .filter((e) => e.score < 6);
  const groupBest = new Map<string | undefined, number>();
  const groupOrder = new Map<string | undefined, number>();
  for (const e of kept) {
    const g = e.item.group;
    groupBest.set(g, Math.min(groupBest.get(g) ?? 6, e.score));
    if (!groupOrder.has(g)) groupOrder.set(g, groupOrder.size);
  }
  return kept
    .sort(
      (a, b) =>
        groupBest.get(a.item.group)! - groupBest.get(b.item.group)! ||
        groupOrder.get(a.item.group)! - groupOrder.get(b.item.group)! ||
        a.score - b.score ||
        a.index - b.index,
    )
    .map((e) => e.item);
}
