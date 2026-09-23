import { expect, test } from "vitest";
import { guestDaySpent, utcDay } from "./plans";

/**
 * A guest's day, as both the API routes and the chat panel read it before
 * asking: spent once today's spend reaches the cap, and only today's.
 */

const NOW = Date.UTC(2026, 8, 23, 12);
const today = utcDay(NOW);

test("a day spent to its cap, or past it, is spent", () => {
  expect(guestDaySpent({ day: today, capUsd: 1, spentUsd: 1 }, NOW)).toBe(true);
  expect(guestDaySpent({ day: today, capUsd: 1, spentUsd: 1.5 }, NOW)).toBe(true);
});

test("a day with some left is not", () => {
  expect(guestDaySpent({ day: today, capUsd: 1, spentUsd: 0.99 }, NOW)).toBe(false);
});

test("yesterday's spend closes nothing today", () => {
  expect(guestDaySpent({ day: "2026-09-22", capUsd: 1, spentUsd: 5 }, NOW)).toBe(false);
  // The same row, read just after midnight UTC.
  expect(guestDaySpent({ day: today, capUsd: 1, spentUsd: 5 }, Date.UTC(2026, 8, 24))).toBe(false);
});

test("no guest allowance is no guest", () => {
  expect(guestDaySpent(null, NOW)).toBe(false);
  expect(guestDaySpent(undefined, NOW)).toBe(false);
});
