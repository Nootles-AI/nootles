/** How an agent's edit reads to a person: in the page's bar and in Settings. */

export type EditCounts = { added: number; changed: number; removed: number; moved: number };

/** "1 added, 2 changed" — what an edit did, in counts. */
export function editSummary(counts: EditCounts): string {
  const parts = (["added", "changed", "removed", "moved"] as const).filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`);
  return parts.length ? parts.join(", ") : "no visible change";
}
