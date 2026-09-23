import { describe, expect, test } from "vitest";
import { dayOf, LIFETIMES, lifetimeLabel, runsOutAt } from "./expiry";

const NOW = Date.UTC(2026, 8, 23, 12);

describe("a link’s lifetime, as the share popover offers and says it", () => {
  test("every lifetime offered is one the server accepts", () => {
    for (const days of LIFETIMES) {
      if (days === null) continue;
      expect(Number.isInteger(days) && days >= 1 && days <= 365).toBe(true);
    }
    expect(LIFETIMES[0]).toBeNull();
  });

  test("names a lifetime in days, and never as never", () => {
    expect(lifetimeLabel(null)).toBe("Never");
    expect(lifetimeLabel(1)).toBe("1 day");
    expect(lifetimeLabel(30)).toBe("30 days");
  });

  test("a link made now runs out that many days on", () => {
    expect(runsOutAt(7, NOW) - NOW).toBe(7 * 86_400_000);
  });

  test("a day says its year only when it isn’t this one", () => {
    expect(dayOf(runsOutAt(7, NOW), NOW)).not.toMatch(/2026/);
    expect(dayOf(runsOutAt(120, NOW), NOW)).toMatch(/2027/);
  });
});
