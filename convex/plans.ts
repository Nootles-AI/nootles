/**
 * What each plan includes: the defaults every container's features resolve
 * from. An account is on free or pro; a workspace is on its own plan (team,
 * one day enterprise) while it pays, and on free while it does not. A row in
 * `workspaceEntitlements` overrides one feature for one workspace, and
 * `entitlements.ts` is where the two are put together.
 *
 * Client-safe for the reason `limits.ts` is: constants, types and pure helpers
 * only, so the browser can name a feature without evaluating server code.
 */

export type PlanName = "free" | "pro" | "team" | "enterprise";

export type Features = {
  /**
   * No free allowance: projects, chats and completions go uncounted, and
   * diagrams and context come with them. Off, the container spends
   * `FREE_LIMITS`.
   */
  unmetered: boolean;
  /** The workspace's audit log. */
  auditLog: boolean;
  /**
   * What one guest may spend of a workspace's AI in a UTC day, in dollars.
   * Guests hold no paid seat, so without it one seat could buy Pro-grade AI
   * for everyone a project is shared with. Only a workspace has guests; an
   * account carries the number so every column has every feature.
   */
  guestDailyAiUsd: number;
};

export type Feature = keyof Features;

const GUEST_DAILY_AI_USD = 1;

/**
 * Nothing is enterprise-only yet, so its column is team's; the seam is there
 * for the day it is not.
 */
export const PLANS: Record<PlanName, Features> = {
  free: { unmetered: false, auditLog: false, guestDailyAiUsd: GUEST_DAILY_AI_USD },
  pro: { unmetered: true, auditLog: false, guestDailyAiUsd: GUEST_DAILY_AI_USD },
  team: { unmetered: true, auditLog: true, guestDailyAiUsd: GUEST_DAILY_AI_USD },
  enterprise: { unmetered: true, auditLog: true, guestDailyAiUsd: GUEST_DAILY_AI_USD },
};

export function isPlanName(value: unknown): value is PlanName {
  return typeof value === "string" && Object.hasOwn(PLANS, value);
}

export function isFeature(value: string): value is Feature {
  return Object.hasOwn(PLANS.free, value);
}

/**
 * The override that stands in for a subscription: a workspace granted a plan
 * is on it, paid or not. What internal testers run on.
 */
export const PLAN_OVERRIDE = "plan";

/**
 * The UTC day an instant falls on, `YYYY-MM-DD` — the unit a guest's cap is
 * counted in. A string so a row reads as a date in the dashboard.
 */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
