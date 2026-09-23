import { describe, expect, test } from "vitest";
import { GUEST_DAY_SPENT, retryNotice } from "./retryNotice";

/**
 * The chat transport hands a failed turn's body to this as the error message.
 * What it must do: turn the gate's `429` into a sentence the person who hit it
 * can act on, the `503` into a briefer wait, a guest's spent day into when it
 * opens again, and leave everything else — a real stream error, a meter's
 * `402` — alone to be shown as it came.
 */

describe("a rate refusal", () => {
  test("reads as a sentence with the seconds to wait", () => {
    const body = JSON.stringify({ code: "rate_limit", bucket: "agentGeneration", retryAfterMs: 3000 });
    expect(retryNotice(body)).toBe(
      "You're sending messages too quickly. Try again in 3 seconds.",
    );
  });

  test("rounds up to whole seconds and is never zero", () => {
    expect(retryNotice(JSON.stringify({ code: "rate_limit", retryAfterMs: 1200 }))).toContain(
      "2 seconds",
    );
    expect(retryNotice(JSON.stringify({ code: "rate_limit", retryAfterMs: 200 }))).toContain(
      "1 second",
    );
    // A missing or nonsensical delay still says something actionable.
    expect(retryNotice(JSON.stringify({ code: "rate_limit" }))).toContain("1 second");
  });

  test("says 'second' singular but 'seconds' plural", () => {
    expect(retryNotice(JSON.stringify({ code: "rate_limit", retryAfterMs: 1000 }))).toContain(
      "1 second.",
    );
    expect(retryNotice(JSON.stringify({ code: "rate_limit", retryAfterMs: 2000 }))).toContain(
      "2 seconds.",
    );
  });
});

describe("a limiter outage", () => {
  test("reads as a brief wait with no promised time", () => {
    expect(retryNotice(JSON.stringify({ code: "limiter_unavailable" }))).toBe(
      "The assistant is briefly unavailable. Try again in a moment.",
    );
  });
});

describe("a guest's spent day", () => {
  test("says when it opens again, rather than showing the body", () => {
    expect(retryNotice(JSON.stringify({ code: "quota", meter: "guestAi", limit: 1 }))).toBe(
      GUEST_DAY_SPENT,
    );
  });
});

describe("everything else is left as it was", () => {
  test("a meter's quota wall is not ours to rewrite", () => {
    expect(retryNotice(JSON.stringify({ code: "quota", meter: "chats" }))).toBeNull();
  });

  test("a plain error message passes through", () => {
    expect(retryNotice("The response body is empty.")).toBeNull();
    expect(retryNotice("Failed to fetch the chat response.")).toBeNull();
  });

  test("non-JSON and non-object payloads return null", () => {
    expect(retryNotice("")).toBeNull();
    expect(retryNotice("null")).toBeNull();
    expect(retryNotice("42")).toBeNull();
    expect(retryNotice('"rate_limit"')).toBeNull();
    expect(retryNotice("{not json")).toBeNull();
  });
});
