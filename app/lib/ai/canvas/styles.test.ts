import { describe, expect, it } from "vitest";
import { f1, parse } from "./fixtures";
import { stylesReport } from "./styles";

describe("stylesReport", () => {
  it("reports tokens, resolved var()s, paint, and a group's layout (S1)", () => {
    const report = stylesReport(f1());
    expect(report.tokens).toEqual([
      { name: "--brand", value: "#6366f1", resolved: "#6366f1", color: true },
    ]);
    const s1 = report.nodes.find((n) => n.id === "s1")!;
    expect(s1.resolved).toEqual({ background: "#6366f1" });
    const s2 = report.nodes.find((n) => n.id === "s2")!;
    expect(s2.resolved).toBeUndefined();
    const p1 = report.nodes.find((n) => n.id === "p1")!;
    expect(p1.paint).toEqual({ fill: null, stroke: "#2b2b28", strokeWidth: "1" });
    const g1 = report.nodes.find((n) => n.id === "g1")!;
    expect(g1.layout?.mode).toBe("flex");
  });

  it("resolves a var() from an ancestor's own custom property (S2)", () => {
    const scene = parse(
      '<nt-diagram w="100" h="100"><nt-group id="g1" x="0" y="0" w="100" h="100" style="--x: red">' +
        '<nt-rect id="s1" x="0" y="0" w="10" h="10" style="color: var(--x)"></nt-rect></nt-group></nt-diagram>',
    );
    const report = stylesReport(scene);
    const s1 = report.nodes.find((n) => n.id === "s1")!;
    expect(s1.resolved).toEqual({ color: "red" });
  });

  it("falls back inside var() when the name is not declared (S3)", () => {
    const scene = parse(
      '<nt-diagram w="10" h="10"><nt-rect id="s1" x="0" y="0" w="10" h="10" style="color: var(--missing, #000)"></nt-rect></nt-diagram>',
    );
    const report = stylesReport(scene);
    expect(report.nodes[0].resolved).toEqual({ color: "#000" });
  });

  it("resolved is omitted when nothing references a var", () => {
    const scene = parse(
      '<nt-diagram w="10" h="10"><nt-rect id="s1" x="0" y="0" w="10" h="10" style="background: #fff"></nt-rect></nt-diagram>',
    );
    const report = stylesReport(scene);
    expect(report.nodes[0].resolved).toBeUndefined();
  });

  it("omits past max", () => {
    const rects = Array.from(
      { length: 10 },
      (_, i) => `<nt-rect id="s${i}" x="0" y="0" w="10" h="10"></nt-rect>`,
    ).join("");
    const scene = parse(`<nt-diagram w="500" h="500">${rects}</nt-diagram>`);
    const report = stylesReport(scene, { max: 4 });
    expect(report.nodes).toHaveLength(4);
    expect(report.omitted).toBe(6);
  });

  it("get_html-style H1 dependency is untouched here: paint is only reported for painted kinds", () => {
    const report = stylesReport(f1());
    const s1 = report.nodes.find((n) => n.id === "s1")!;
    expect(s1.paint).toBeUndefined();
    const g1 = report.nodes.find((n) => n.id === "g1")!;
    expect(g1.paint).toBeUndefined();
  });
});
