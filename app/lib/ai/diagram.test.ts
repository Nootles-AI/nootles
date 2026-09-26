import { describe, expect, it } from "vitest";
import { userMessage } from "./diagram";

describe("the diagram prompt", () => {
  it("carries the product's look, between the page and the brief", () => {
    const text = userMessage("a mockup of the settings screen", "Settings let you…", "Spec", "--background: #fff");
    expect(text).toContain("--background: #fff");
    expect(text.indexOf("Settings let you")).toBeLessThan(text.indexOf("--background"));
    expect(text.endsWith("Draw: a mockup of the settings screen")).toBe(true);
  });

  it("says nothing about a look when the project has none", () => {
    expect(userMessage("a flowchart", "", "", "")).toBe("Draw: a flowchart");
  });
});
