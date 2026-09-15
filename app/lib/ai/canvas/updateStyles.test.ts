import { describe, expect, it } from "vitest";
import { findNode } from "@/app/components/editor/canvas/scene/types";
import { isRefusal } from "./host";
import { f1 } from "./fixtures";
import { planUpdateStyles } from "./updateStyles";

describe("planUpdateStyles", () => {
  it("restyles several shapes with one op (U1)", () => {
    const scene = f1();
    const result = planUpdateStyles(scene, [
      { ids: ["s1", "s2"], style: { background: "#1e293b", color: "#fff" } },
    ]);
    if (isRefusal(result)) throw new Error(result.refused);
    expect(result.ops).toEqual([
      { type: "setStyle", ids: ["s1", "s2"], decls: { background: "#1e293b", color: "#fff" } },
    ]);
    expect(result.touched).toEqual(["s1", "s2"]);
    expect(findNode(result.next, "s1")!.style.background).toBe("#1e293b");
  });

  it("restyles an edge (U2)", () => {
    const scene = f1();
    const result = planUpdateStyles(scene, [{ ids: ["e1"], style: { stroke: "#f00" } }]);
    if (isRefusal(result)) throw new Error(result.refused);
    expect(result.ops).toEqual([{ type: "setEdgeStyle", ids: ["e1"], decls: { stroke: "#f00" } }]);
    expect(result.next.edges.find((e) => e.id === "e1")!.style.stroke).toBe("#f00");
  });

  it("restyles the diagram surface itself (U3)", () => {
    const scene = f1();
    const result = planUpdateStyles(scene, [{ ids: ["diagram"], style: { "--brand": "#0f766e" } }]);
    if (isRefusal(result)) throw new Error(result.refused);
    expect(result.next.style["--brand"]).toBe("#0f766e");
    // s1's own declaration is untouched — it still reads var(--brand); only
    // the token's value changed, and s1 repaints without an op on s1.
    expect(findNode(result.next, "s1")!.style.background).toBe("var(--brand)");
  });

  it("null removes a declaration (U4)", () => {
    const scene = f1();
    const result = planUpdateStyles(scene, [{ ids: ["s1"], style: { "border-radius": null } }]);
    if (isRefusal(result)) throw new Error(result.refused);
    expect(findNode(result.next, "s1")!.style["border-radius"]).toBeUndefined();
  });

  it("geometry properties are refused (U5)", () => {
    const scene = f1();
    const result = planUpdateStyles(scene, [{ ids: ["s1"], style: { left: "10px" } }]);
    expect(isRefusal(result)).toBe(true);
    if (isRefusal(result)) expect(result.refused).toContain("geometry");
  });

  it("a value matching the resolved var is still an authored change (U6)", () => {
    const scene = f1();
    const result = planUpdateStyles(scene, [{ ids: ["s1"], style: { background: "#6366f1" } }]);
    if (isRefusal(result)) throw new Error(result.refused);
    expect(result.touched).toEqual(["s1"]);
    expect(findNode(result.next, "s1")!.style.background).toBe("#6366f1");
  });

  it("later patches win", () => {
    const scene = f1();
    const result = planUpdateStyles(scene, [
      { ids: ["s1"], style: { background: "#111" } },
      { ids: ["s1"], style: { background: "#222" } },
    ]);
    if (isRefusal(result)) throw new Error(result.refused);
    expect(findNode(result.next, "s1")!.style.background).toBe("#222");
  });

  it("an unknown id is refused", () => {
    const scene = f1();
    const result = planUpdateStyles(scene, [{ ids: ["zz"], style: { background: "#111" } }]);
    expect(isRefusal(result)).toBe(true);
  });
});
