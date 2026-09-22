/**
 * Files that change together, from the file lists of recent commits — the
 * spike's stronger clustering signal, since it sees the links imports miss
 * (a component and its styles, a mutation and the schema it needed).
 *
 * A commit's pairs share one unit of evidence, so a ten-file commit says less
 * about any two of its files than a two-file one. Sweeping commits — a rename,
 * a formatter run — say nothing and are dropped whole. A pair counts once it
 * has a whole commit's worth of evidence.
 */

const SWEEPING = 40;
const MIN_WEIGHT = 1;

export function coChange(
  commits: string[][],
  known?: Set<string>,
): { a: string; b: string; weight: number }[] {
  const weights = new Map<string, number>();
  for (const commit of commits) {
    const distinct = [...new Set(commit)];
    if (distinct.length > SWEEPING) continue;
    const paths = distinct.filter((p) => !known || known.has(p)).sort();
    if (paths.length < 2) continue;
    const share = 1 / (paths.length - 1);
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const key = `${paths[i]}\n${paths[j]}`;
        weights.set(key, (weights.get(key) ?? 0) + share);
      }
    }
  }
  return [...weights]
    // Shares of 1/3 sum to 0.999…, which is a whole commit's worth.
    .filter(([, weight]) => weight >= MIN_WEIGHT - 1e-9)
    .map(([key, weight]) => {
      const [a, b] = key.split("\n");
      return { a, b, weight };
    })
    .sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
}
