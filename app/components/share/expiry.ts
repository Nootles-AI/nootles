const DAY_MS = 86_400_000;

/**
 * The lifetimes a link is offered, in days, and null for one that lasts until
 * it is turned off. The server takes any whole number from 1 to 365; these are
 * the ones worth a choice.
 */
export const LIFETIMES: readonly (number | null)[] = [null, 7, 30, 90];

/** A lifetime as a choice names it: "Never", "1 day", "30 days". */
export function lifetimeLabel(days: number | null): string {
  if (days === null) return "Never";
  return days === 1 ? "1 day" : `${days} days`;
}

/** When a link made now with this lifetime runs out. */
export function runsOutAt(days: number, now: number): number {
  return now + days * DAY_MS;
}

/** A day as the share popover says it: "12 Oct", with the year only when it isn’t this one. */
export function dayOf(at: number, now: number): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(at);
}
