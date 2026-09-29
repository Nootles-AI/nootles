import { describe, expect, test } from "vitest";
import {
  ATTRIBUTION_WINDOW_MS,
  DEFAULT_DESTINATION,
  NEW_ACCOUNT_TOLERANCE_MS,
  REF_COOKIE,
  canonicalClick,
  clickSecret,
  dayKey,
  formatRef,
  isAllowedDestination,
  isVisitorId,
  normalizeAffiliateSlug,
  parseRef,
  signClick,
  verifyClick,
} from "./affiliateRules";

/**
 * The rules the `/r/<slug>` route and `affiliates.ts` share. Everything a
 * visitor can write — the slug in the address, the cookie — goes through
 * here, so these are the refusals an attacker meets first.
 */

const VISITOR = "0b5e7a1c-3f2d-4c8e-9a6b-1d2e3f4a5b6c";
const SECRET = "a-shared-click-secret";

describe("constants", () => {
  test("are the ones the design settled", () => {
    expect(ATTRIBUTION_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(NEW_ACCOUNT_TOLERANCE_MS).toBe(10 * 60 * 1000);
    expect(REF_COOKIE).toBe("nt_ref");
    expect(DEFAULT_DESTINATION).toBe("https://nootles.com/");
    expect(isAllowedDestination(DEFAULT_DESTINATION)).toBe(true);
  });
});

describe("normalizeAffiliateSlug", () => {
  test.each([
    ["jane", "jane"],
    ["Jane-Doe", "jane-doe"],
    ["  Jane Doe  ", "jane-doe"],
    ["jane__doe!!", "jane-doe"],
    ["--jane--", "jane"],
    ["a1", "a1"],
    ["x".repeat(40), "x".repeat(40)],
  ])("%j becomes %j", (raw, slug) => {
    expect(normalizeAffiliateSlug(raw)).toBe(slug);
  });

  test.each([
    [""],
    ["a"],
    ["---"],
    ["x".repeat(41)],
    ["admin"],
    ["Nootles"],
    ["api"],
    ["r"],
    ["www"],
    ["ops"],
  ])("refuses %j", (raw) => {
    expect(normalizeAffiliateSlug(raw)).toBeNull();
  });

  test("is idempotent", () => {
    for (const raw of ["Jane Doe", "a--b", "Ünïcode Name"]) {
      const once = normalizeAffiliateSlug(raw);
      if (once) expect(normalizeAffiliateSlug(once)).toBe(once);
    }
  });
});

describe("isAllowedDestination", () => {
  test.each([
    "https://nootles.com/",
    "https://nootles.com",
    "https://www.nootles.com/for/teams",
    "https://app.nootles.com/sign-in?from=r",
    "https://nootles.com/#pricing",
    // The default port, which the parser drops: the same destination.
    "https://nootles.com:443/",
  ])("admits %s", (url) => {
    expect(isAllowedDestination(url)).toBe(true);
  });

  test.each([
    "http://nootles.com/",
    "HTTPS://nootles.com/",
    "//nootles.com/",
    "/sign-in",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://evil.com/",
    "https://nootles.com.evil.com/",
    "https://evilnootles.com/",
    "https://sub.nootles.com/",
    "https://nootles.com./",
    "https://nootles.com:8443/",
    "https://user@nootles.com/",
    "https://user:pass@nootles.com/",
    "https://evil.com@nootles.com/",
    "https://nootles.com\\@evil.com/",
    "https://nootles.com /",
    "https://nootles.com/\n",
    "https:\\\\evil.com",
    "https://xn--nootles-.com/",
    "",
    "not a url",
  ])("refuses %j", (url) => {
    expect(isAllowedDestination(url)).toBe(false);
  });
});

describe("refs", () => {
  test("round-trip", () => {
    const ref = { slug: "jane-doe", visitorId: VISITOR, clickedAt: 1_790_000_000_000 };
    const raw = formatRef(ref);
    expect(raw).toBe(`jane-doe.${VISITOR}.1790000000000`);
    expect(parseRef(raw)).toEqual(ref);
  });

  test.each([
    ["empty", ""],
    ["two parts", `jane.${VISITOR}`],
    ["four parts", `jane.${VISITOR}.1.2`],
    ["uppercase slug", `Jane.${VISITOR}.1`],
    ["reserved slug", `admin.${VISITOR}.1`],
    ["short slug", `j.${VISITOR}.1`],
    ["not a uuid", "jane.visitor.1"],
    ["uppercase uuid", `jane.${VISITOR.toUpperCase()}.1`],
    ["negative time", `jane.${VISITOR}.-1`],
    ["fractional time", `jane.${VISITOR}.1.5`],
    ["non-numeric time", `jane.${VISITOR}.soon`],
    ["exponent time", `jane.${VISITOR}.1e12`],
    ["empty time", `jane.${VISITOR}.`],
    ["huge time", `jane.${VISITOR}.${"9".repeat(16)}`],
    ["too long", `${"x".repeat(40)}.${VISITOR}.${"1".repeat(60)}`],
    ["encoded", encodeURIComponent(`jane.${VISITOR}.1`).replace(/\./g, "%2E")],
    ["script", `<script>.${VISITOR}.1`],
  ])("refuses %s", (_, raw) => {
    expect(parseRef(raw)).toBeNull();
  });
});

describe("visitor ids", () => {
  test("are UUIDs as crypto.randomUUID writes them", () => {
    expect(isVisitorId(crypto.randomUUID())).toBe(true);
    expect(isVisitorId(VISITOR)).toBe(true);
    expect(isVisitorId("")).toBe(false);
    expect(isVisitorId(`${VISITOR}x`)).toBe(false);
    expect(isVisitorId(VISITOR.replace(/-/g, ""))).toBe(false);
  });
});

describe("dayKey", () => {
  test("is the UTC day", () => {
    expect(dayKey(Date.UTC(2026, 8, 28, 0, 0, 0))).toBe("2026-09-28");
    expect(dayKey(Date.UTC(2026, 8, 28, 23, 59, 59, 999))).toBe("2026-09-28");
    expect(dayKey(Date.UTC(2026, 8, 29))).toBe("2026-09-29");
  });
});

describe("clickSecret", () => {
  test("trims, and treats empty as none", () => {
    expect(clickSecret(undefined)).toBeNull();
    expect(clickSecret("")).toBeNull();
    expect(clickSecret("  \n")).toBeNull();
    expect(clickSecret(" s3cret\n")).toBe("s3cret");
  });
});

describe("click signatures", () => {
  const click = { slug: "jane", visitorId: VISITOR, signedAt: 1_790_000_000_000 };

  test("canonical form is fixed", () => {
    expect(canonicalClick(click)).toBe(`["jane","${VISITOR}",1790000000000]`);
  });

  test("a signature verifies for its own click and secret", async () => {
    const signature = await signClick(SECRET, click);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyClick(SECRET, click, signature)).toBe(true);
  });

  test("anything changed does not verify", async () => {
    const signature = await signClick(SECRET, click);
    expect(await verifyClick("another-secret", click, signature)).toBe(false);
    expect(await verifyClick(SECRET, { ...click, slug: "john" }, signature)).toBe(false);
    expect(
      await verifyClick(SECRET, { ...click, visitorId: crypto.randomUUID() }, signature),
    ).toBe(false);
    expect(await verifyClick(SECRET, { ...click, signedAt: click.signedAt + 1 }, signature)).toBe(
      false,
    );
    const flipped = (signature[0] === "0" ? "1" : "0") + signature.slice(1);
    expect(await verifyClick(SECRET, click, flipped)).toBe(false);
  });

  test("a malformed signature is false, not an error", async () => {
    const signature = await signClick(SECRET, click);
    for (const bad of ["", "zz", signature.toUpperCase(), signature.slice(2), `${signature}00`]) {
      expect(await verifyClick(SECRET, click, bad)).toBe(false);
    }
  });
});
