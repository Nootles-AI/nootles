/** "2d ago" / "Jul 12" — coarse enough that it never needs to re-render. */
export function when(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export const pages = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;
