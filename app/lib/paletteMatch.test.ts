import { describe, expect, test } from "vitest";
import { paletteMatch } from "./paletteMatch";

const INVITE = ["invite", "people", "member", "members", "add"];

describe("a palette row answers what was typed", () => {
  test("nothing typed shows every row", () => {
    expect(paletteMatch("", "Roadmap")).toBe(true);
    expect(paletteMatch("   ", "Roadmap")).toBe(true);
  });

  test("a row's name matches anywhere in it, whatever the case", () => {
    expect(paletteMatch("ROAD", "Roadmap")).toBe(true);
    expect(paletteMatch(" map ", "Roadmap")).toBe(true);
    expect(paletteMatch("plan", "Roadmap")).toBe(false);
  });

  test("a row with no other words is found by its name alone", () => {
    expect(paletteMatch("add", "Roadmap")).toBe(false);
    expect(paletteMatch("road map", "Roadmap")).toBe(false);
  });

  test("Invite people is found by each word it goes by", () => {
    for (const typed of ["invite", "people", "member", "Members", "add", "inv"]) {
      expect(paletteMatch(typed, "Invite people to Juniper", INVITE)).toBe(true);
    }
  });

  test("every word typed has to be one it goes by", () => {
    expect(paletteMatch("add member", "Invite people", INVITE)).toBe(true);
    expect(paletteMatch("add project", "Invite people", INVITE)).toBe(false);
    expect(paletteMatch("billing", "Invite people", INVITE)).toBe(false);
  });
});
