import { describe, expect, it } from "vitest";
import { normalizeEmail, plausibleEmail } from "./emails";

describe("invitation addresses", () => {
  it("keeps an address trimmed and lower-cased", () => {
    expect(normalizeEmail("  Ada@Acme.COM ")).toBe("ada@acme.com");
  });

  it("takes what could be an address, and nothing that could not", () => {
    expect(plausibleEmail(" ada@acme.com ")).toBe(true);
    expect(plausibleEmail("ada.l@mail.acme.co.uk")).toBe(true);
    for (const raw of ["", "ada", "ada@", "ada@acme", "@acme.com", "ada @acme.com", "a@b@c.com"]) {
      expect(plausibleEmail(raw)).toBe(false);
    }
  });
});
