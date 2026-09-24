/**
 * Whether a palette row answers what was typed: its name holds the query, as
 * every row always has — or, for a row that lists other words it goes by,
 * each word typed is found among its name and those. "add people" finds
 * "Invite people"; a row with no other words matches on its name alone.
 */
export function paletteMatch(query: string, name: string, words: readonly string[] = []): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const title = name.toLowerCase();
  if (title.includes(q)) return true;
  if (!words.length) return false;
  const known = [title, ...words.map((w) => w.toLowerCase())].join(" ");
  return q.split(/\s+/).every((part) => known.includes(part));
}
