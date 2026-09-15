import { describe, expect, it } from "vitest";
import { applyOps } from "@/app/components/editor/canvas/scene/ops";
import { f1, parse } from "./fixtures";
import { geometryReport } from "./geometry";

describe("geometryReport", () => {
  it("reports absolute boxes, an auto-layout child's flow position, and edge points (G1)", () => {
    const report = geometryReport(f1());
    const c1 = report.nodes.find((n) => n.id === "c1")!;
    // g1 is a flex row, gap 16, padding 12: c1 sits at the padding origin.
    expect(c1.x).toBe(52);
    expect(c1.y).toBe(172);
    const c2 = report.nodes.find((n) => n.id === "c2")!;
    expect(c2.x).toBe(52 + 100 + 16);
    const g1 = report.nodes.find((n) => n.id === "g1")!;
    expect(g1.layout).toBe("flex");
    const e1 = report.edges.find((e) => e.id === "e1")!;
    expect(e1.points).not.toBeNull();
    expect(e1.mid).toBeDefined();
    expect(report.nodes.find((n) => n.id === "s1")!.bounds).toBeUndefined();
  });

  it("filters to ids and their descendants, dropping edges outside the set (G2)", () => {
    const report = geometryReport(f1(), { ids: ["g1"] });
    expect(report.nodes.map((n) => n.id).sort()).toEqual(["c1", "c2", "g1"]);
    expect(report.edges).toEqual([]);
  });

  it("reports bounds for a rotated node (G3)", () => {
    const scene = parse(
      '<nt-diagram w="200" h="200"><nt-rect id="s1" x="40" y="40" w="60" h="40" rot="30"></nt-rect></nt-diagram>',
    );
    const report = geometryReport(scene);
    const s1 = report.nodes[0];
    expect(s1.rot).toBe(30);
    expect(s1.bounds).toBeDefined();
  });

  it("caps at max and reports omitted (G4)", () => {
    const rects = Array.from(
      { length: 20 },
      (_, i) => `<nt-rect id="s${i}" x="0" y="0" w="10" h="10"></nt-rect>`,
    ).join("");
    const scene = parse(`<nt-diagram w="500" h="500">${rects}</nt-diagram>`);
    const report = geometryReport(scene, { max: 8 });
    expect(report.nodes).toHaveLength(8);
    expect(report.omitted).toBe(12);
  });

  it("numbers are rounded to 2dp", () => {
    const scene = parse(
      '<nt-diagram w="10" h="10"><nt-rect id="s1" x="1.23456" y="2" w="10" h="10"></nt-rect></nt-diagram>',
    );
    const report = geometryReport(scene);
    expect(report.nodes[0].x).toBe(1.23);
  });

  it("laidOutScene is used — an auto-layout child is placed by flow", () => {
    const scene = f1();
    const report = geometryReport(scene);
    const c1 = report.nodes.find((n) => n.id === "c1")!;
    // c1's own authored x/y are 0/0; the report gives its real, laid-out spot.
    expect(c1.x).not.toBe(0);
  });

  it("hidden nodes are listed with hidden:true", () => {
    const scene = applyOps(f1(), [{ type: "setHidden", ids: ["s1"], hidden: true }]);
    const report = geometryReport(scene);
    expect(report.nodes.find((n) => n.id === "s1")!.hidden).toBe(true);
  });

  it("an unroutable edge reports points:null", () => {
    const scene = parse(
      '<nt-diagram w="100" h="100"><nt-rect id="s1" x="0" y="0" w="10" h="10"></nt-rect>' +
        '<nt-edge id="e1" from="s1" to="zz"></nt-edge></nt-diagram>',
    );
    const report = geometryReport(scene);
    expect(report.edges[0].points).toBeNull();
  });
});
