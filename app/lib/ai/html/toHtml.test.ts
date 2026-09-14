import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { NodeId, Scene } from "@/app/components/editor/canvas/scene/types";
import { COMPILE_FIXTURES } from "./compileFixtures";
import { compileNml, compileScene, compileSceneReady, compileSelection } from "./toHtml";

const parse = (html: string): Scene => parseScene(html, (h) => parseHTML(h).document as unknown as Document);
const fixture = (name: keyof typeof COMPILE_FIXTURES): Scene => parse(COMPILE_FIXTURES[name]);

// ---------------------------------------------------------------------------
// Goldens (§4.4) — exact, byte-for-byte expected output
// ---------------------------------------------------------------------------

describe("compileScene: goldens (html)", () => {
  it("rect-var", () => {
    expect(compileScene(fixture("rect-var")).code).toBe(
      '<div data-nt-id="c1" style="position: relative; isolation: isolate; background: #fff; --brand: #6366f1; width: 320px; height: 200px">\n' +
        '  <div data-nt-id="s1" style="box-sizing: border-box; white-space: pre-wrap; overflow-wrap: break-word; background: var(--brand); border-radius: 12px; color: #fff; display: flex; align-items: center; justify-content: center; position: absolute; left: 40px; top: 24px; transform: rotate(15deg); width: 160px; height: 72px"><span>Ingest</span></div>\n' +
        "</div>",
    );
  });

  it("rect-var with resolveVars inlines the value and drops the declaration", () => {
    const code = compileScene(fixture("rect-var"), { resolveVars: true }).code;
    expect(code).toContain("background: #6366f1");
    expect(code).not.toContain("--brand");
    expect(code.split("\n")[0]).toBe(
      '<div data-nt-id="c1" style="position: relative; isolation: isolate; background: #fff; width: 320px; height: 200px">',
    );
  });

  it("ellipse-border", () => {
    expect(compileScene(fixture("ellipse-border")).code).toBe(
      '<div style="position: relative; isolation: isolate; width: 120px; height: 80px">\n' +
        '  <div data-nt-id="e1" style="box-sizing: border-box; white-space: pre-wrap; overflow-wrap: break-word; border-radius: 50%; background: #eee; border: 2px solid #333; position: absolute; left: 10px; top: 10px; width: 100px; height: 60px"></div>\n' +
        "</div>",
    );
  });

  it("arc-ring", () => {
    expect(compileScene(fixture("arc-ring")).code).toBe(
      '<div style="position: relative; isolation: isolate; width: 100px; height: 100px">\n' +
        '  <div data-nt-id="r1" style="box-sizing: border-box; white-space: pre-wrap; overflow-wrap: break-word; border-radius: 50%; isolation: isolate; position: absolute; left: 0px; top: 0px; width: 100px; height: 100px"><svg style="position: absolute; inset: 0; z-index: -1; overflow: visible; pointer-events: none" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M 50 0 A 50 50 0 1 1 0 50 L 25 50 A 25 25 0 1 0 50 25 Z" fill-rule="evenodd" fill="#f59e0b" vector-effect="non-scaling-stroke"/></svg></div>\n' +
        "</div>",
    );
  });

  it("diamond-gradient", () => {
    expect(compileScene(fixture("diamond-gradient")).code).toBe(
      '<div style="position: relative; isolation: isolate; width: 200px; height: 140px">\n' +
        '  <div data-nt-id="d1" style="box-sizing: border-box; white-space: pre-wrap; overflow-wrap: break-word; isolation: isolate; background: linear-gradient(90deg, #000, #fff); display: flex; align-items: center; justify-content: center; clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%); padding: 24px 35px; position: absolute; left: 20px; top: 20px; width: 140px; height: 96px"><svg style="position: absolute; inset: 0; z-index: -1; overflow: visible; pointer-events: none" viewBox="0 0 140 96" preserveAspectRatio="none" aria-hidden="true"><path d="M 70 0 L 140 48 L 70 96 L 0 48 Z" fill-rule="evenodd" stroke="#111" stroke-width="2px" fill="none" vector-effect="non-scaling-stroke"/></svg><span>Yes?</span></div>\n' +
        "</div>",
    );
  });

  it("path-bare", () => {
    expect(compileScene(fixture("path-bare")).code).toBe(
      '<div style="position: relative; isolation: isolate; width: 100px; height: 60px">\n' +
        '  <svg data-nt-id="p1" style="box-sizing: border-box; position: absolute; left: 10px; top: 10px; width: 80px; height: 40px; fill: none; stroke: #1a1a1a; stroke-width: 2; overflow: visible" viewBox="0 0 80 40" preserveAspectRatio="none"><path d="M 0 0 C 20 40 60 40 80 0" vector-effect="non-scaling-stroke"/></svg>\n' +
        "</div>",
    );
  });

  it("path-shadow (paint -> shadow-cast -> overflow ordering, §3.2 steps 11-13)", () => {
    expect(compileScene(fixture("path-shadow")).code).toBe(
      '<div style="position: relative; isolation: isolate; width: 100px; height: 60px">\n' +
        '  <svg data-nt-id="p2" style="box-sizing: border-box; position: absolute; left: 10px; top: 10px; width: 80px; height: 40px; fill: none; stroke: #1a1a1a; stroke-width: 2; box-shadow: none; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); overflow: visible" viewBox="0 0 80 40" preserveAspectRatio="none"><path d="M 0 0 C 20 40 60 40 80 0" vector-effect="non-scaling-stroke"/></svg>\n' +
        "</div>",
    );
  });

  it("group-flex-hug (hidden child keeps its slot, width/height moved to the end by `put`)", () => {
    expect(compileScene(fixture("group-flex-hug")).code).toBe(
      '<div style="position: relative; isolation: isolate; width: 300px; height: 200px">\n' +
        '  <div data-nt-id="g1" style="box-sizing: border-box; display: flex; gap: 8px; padding: 12px; background: #f4f4f5; position: absolute; left: 0px; top: 0px; width: fit-content; height: fit-content">\n' +
        '    <div data-nt-id="a" style="box-sizing: border-box; white-space: pre-wrap; overflow-wrap: break-word; background: #ddd; position: relative; width: 100px; height: 50px; flex: none"><span>A</span></div>\n' +
        '    <div data-nt-id="b" style="box-sizing: border-box; white-space: pre-wrap; overflow-wrap: break-word; background: #ccc; position: relative; width: 60px; height: 80px; flex: none; visibility: hidden"><span>B</span></div>\n' +
        "  </div>\n" +
        "</div>",
    );
  });

  it("edge-two-rects", () => {
    expect(compileScene(fixture("edge-two-rects")).code).toBe(
      '<div data-nt-id="c2" style="position: relative; isolation: isolate; width: 400px; height: 200px">\n' +
        '  <svg style="position: absolute; inset: 0; overflow: visible; pointer-events: none" aria-hidden="true">\n' +
        '    <defs>\n' +
        '      <marker id="nt-c2-arrow-0" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0 0.5 10 5 0 9.5Z" fill="#111"/></marker>\n' +
        '    </defs>\n' +
        '    <path data-nt-id="e1" d="M120 90 L280 90" style="fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; stroke: #111" marker-end="url(#nt-c2-arrow-0)"/>\n' +
        '  </svg>\n' +
        '  <div data-nt-edge-label="e1" style="position: absolute; left: 200px; top: 90px; transform: translate(-50%, -50%); padding: 1px 5px; border-radius: 4px; background: #fff; font-size: 12px; line-height: 1.35; white-space: pre-wrap; color: oklch(0.25 0.005 90); pointer-events: none">deploys</div>\n' +
        '  <div data-nt-id="a" style="box-sizing: border-box; white-space: pre-wrap; overflow-wrap: break-word; background: #eee; position: absolute; left: 20px; top: 60px; width: 100px; height: 60px"><span>A</span></div>\n' +
        '  <div data-nt-id="b" style="box-sizing: border-box; white-space: pre-wrap; overflow-wrap: break-word; background: #eee; position: absolute; left: 280px; top: 60px; width: 100px; height: 60px"><span>B</span></div>\n' +
        "</div>",
    );
  });

  it("text-rich-clamp", () => {
    expect(compileScene(fixture("text-rich-clamp")).code).toBe(
      '<div style="position: relative; isolation: isolate; width: 240px; height: 120px">\n' +
        '  <div data-nt-id="t1" style="box-sizing: border-box; white-space: pre-wrap; overflow-wrap: break-word; background: #fff; position: absolute; left: 0px; top: 0px; width: 240px; height: 120px"><span style="min-width: 0; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; -webkit-line-clamp: 2"><p style="margin: 0; margin-bottom: 8px"><b>Plan</b> <a href="https://x.test" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline; text-underline-offset: 0.15em">go</a></p><ul style="margin: 0; padding-left: 1.5em; text-align: left; list-style: disc"><li style="margin: 0">one</li><li style="margin: 0">two</li></ul></span></div>\n' +
        "</div>",
    );
  });
});

describe("compileScene: goldens (jsx)", () => {
  it("rect-var", () => {
    expect(compileScene(fixture("rect-var"), { flavour: "jsx" }).code).toBe(
      '<div data-nt-id="c1" style={{ position: "relative", isolation: "isolate", background: "#fff", "--brand": "#6366f1", width: "320px", height: "200px" }}>\n' +
        '  <div data-nt-id="s1" style={{ boxSizing: "border-box", whiteSpace: "pre-wrap", overflowWrap: "break-word", background: "var(--brand)", borderRadius: "12px", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", position: "absolute", left: "40px", top: "24px", transform: "rotate(15deg)", width: "160px", height: "72px" }}><span>{"Ingest"}</span></div>\n' +
        "</div>",
    );
  });
});

// ---------------------------------------------------------------------------
// Behaviour (§4.1, §5.1) — everything not spelled out as an exact golden
// ---------------------------------------------------------------------------

describe("options", () => {
  it("ids: false strips data attributes but keeps marker ids", () => {
    const code = compileScene(fixture("edge-two-rects"), { ids: false }).code;
    expect(code).not.toMatch(/data-nt-/);
    expect(code).toMatch(/id="nt-c2-arrow-0"/);
  });

  it("clip adds overflow: hidden to the root, last", () => {
    const code = compileScene(fixture("ellipse-border"), { clip: true }).code;
    expect(code.split("\n")[0]).toBe(
      '<div style="position: relative; isolation: isolate; width: 120px; height: 80px; overflow: hidden">',
    );
  });
});

describe("determinism and parse-agnosticism", () => {
  // `scene/serialize.ts`'s `nodeHtml` omits a child's `x`/`y` whenever its
  // PARENT is auto-layout, without checking whether that particular child is
  // itself pinned (`position: absolute`) — a pre-existing round-trip gap in
  // that file (outside this slice's remit) that only a pinned-inside-flex
  // fixture exercises. `compileScene` itself is unaffected (asserted below,
  // and by the browser harness's box-agreement case, neither of which
  // round-trips through `serializeScene`); only the `compileNml(serializeScene
  // (...))` comparison has to skip that one fixture.
  const SERIALIZE_ROUND_TRIP_GAP = new Set(["flex-pinned-child"]);

  it("a pinned idPrefix makes compileScene and compileNml agree, and repeat", () => {
    for (const name of Object.keys(COMPILE_FIXTURES) as (keyof typeof COMPILE_FIXTURES)[]) {
      const scene = fixture(name);
      const a = compileScene(scene, { idPrefix: "nt-x" }).code;
      const b = compileScene(scene, { idPrefix: "nt-x" }).code;
      expect(b).toBe(a);
      if (SERIALIZE_ROUND_TRIP_GAP.has(name)) continue;
      const c = compileNml(serializeScene(scene), {
        idPrefix: "nt-x",
        parseHtml: (h) => parseHTML(h).document as unknown as Document,
      }).code;
      expect(c).toBe(a);
    }
  });

  it("no explicit idPrefix and no scene.id: markers differ, but only in the suffix", () => {
    const scene = { ...fixture("edge-two-rects"), id: undefined };
    const a = compileScene(scene).code;
    const b = compileScene(scene).code;
    expect(a).not.toBe(b);
    const strip = (s: string) => s.replace(/nt-\w+-arrow-/g, "nt-X-arrow-");
    expect(strip(a)).toBe(strip(b));
  });

  it("marker ids never collide across two independently compiled fragments (B31)", () => {
    const scene = fixture("edge-two-rects");
    const ids = scene.nodes.map((n) => n.id);
    const a = compileSelection(scene, ids)!;
    const b = compileSelection(scene, ids)!;
    const combined = parseHTML(`<div>${a.code}${b.code}</div>`).document;
    const allIds = [...combined.querySelectorAll("[id]")].map((el) => el.getAttribute("id"));
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

describe("hidden nodes (§3.10)", () => {
  const scene = (): Scene => ({
    w: 100,
    h: 100,
    style: {},
    attrs: {},
    edges: [{ id: "e1", from: "a", to: "b", label: "", style: {}, attrs: {} }],
    nodes: [
      { kind: "rect", id: "a", x: 0, y: 0, w: 20, h: 20, rot: 0, style: {}, label: "", locked: false, hidden: true, attrs: {} },
      { kind: "rect", id: "b", x: 40, y: 40, w: 20, h: 20, rot: 0, style: {}, label: "", locked: false, hidden: false, attrs: {} },
    ],
  });

  it("a hidden top-level node is omitted, and an edge to it is skipped and noted", () => {
    const { code, notes } = compileScene(scene());
    expect(code).not.toContain('data-nt-id="a"');
    expect(code).not.toContain("<svg"); // no edge drew at all
    expect(notes.some((n) => n.id === "e1" && n.note.startsWith("edge skipped"))).toBe(true);
  });
});

describe("edges", () => {
  it("a dangling edge (missing end) is skipped and noted", () => {
    const { code, notes } = compileScene(fixture("edge-dangling"));
    expect(code).not.toContain("<svg");
    expect(notes).toEqual([{ id: "e1", note: "edge skipped: from/to not in scene" }]);
  });

  it("edges sharing a stroke share one marker", () => {
    const { code } = compileScene(fixture("edges-shared-marker"));
    expect(code.match(/<marker/g)?.length).toBe(1);
    expect(code.match(/marker-end="url\(#[^)]+\)"/g)?.length).toBe(2);
  });
});

describe("boolean groups", () => {
  it("draws the operands' outlines before the clipper loads, and notes it", () => {
    const { notes } = compileScene(fixture("boolean-subtract"));
    expect(notes.some((n) => n.note.includes("operands' outlines"))).toBe(true);
  });

  it("compileSceneReady awaits the clipper and drops the note", async () => {
    const { notes, code } = await compileSceneReady(fixture("boolean-subtract"));
    expect(notes.some((n) => n.note.includes("operands' outlines"))).toBe(false);
    expect(code).toContain("<svg");
  });
});

describe("labels", () => {
  it("a page reference renders as an underlined chip and is noted", () => {
    const { code, notes } = compileScene(fixture("label-ref"));
    expect(code).toContain('<span data-nt-ref="p1" style="text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; white-space: nowrap">Roadmap</span>');
    expect(notes.some((n) => n.id === "t1" && n.note.includes("page chip"))).toBe(true);
  });

  it("a literal newline survives; & < > are escaped; jsx uses a string expression", () => {
    const scene: Scene = {
      w: 100,
      h: 100,
      style: {},
      attrs: {},
      edges: [],
      nodes: [
        {
          kind: "text",
          id: "t1",
          x: 0,
          y: 0,
          w: 100,
          h: 40,
          rot: 0,
          style: {},
          label: "a & b\nc < d",
          locked: false,
          hidden: false,
          attrs: {},
        },
      ],
    };
    const html = compileScene(scene).code;
    expect(html).toContain("<span>a &amp; b\nc &lt; d</span>");
    const jsx = compileScene(scene, { flavour: "jsx" }).code;
    expect(jsx).toContain('<span>{"a & b\\nc < d"}</span>');
  });
});

describe("selection (§2.5, B26/B27)", () => {
  it("flattens a rotated group's child to scene space and translates to 0,0", () => {
    const scene = fixture("selection-rotated-group");
    const out = compileSelection(scene, ["a"] as NodeId[])!;
    expect(out.code).not.toMatch(/data-nt-id="g1"/);
    // The root carries only the diagram's own custom properties (§2.2) — none here.
    expect(out.code.split("\n")[0]).not.toContain("--");
  });

  it("drops a selected child when its ancestor is also selected", () => {
    const scene = fixture("selection-rotated-group");
    const out = compileSelection(scene, ["g1", "a"] as NodeId[])!;
    expect(out.code.match(/data-nt-id="a"/g)?.length).toBe(1);
  });

  it("returns null for a selection with nothing live in the scene", () => {
    expect(compileSelection(fixture("rect-var"), ["ghost"] as NodeId[])).toBeNull();
  });
});

describe("root sizing (§3.12)", () => {
  it("a 0x0 scene sizes to its content's bounds, and notes it", () => {
    const { code, notes } = compileScene(fixture("scene-w0"));
    expect(notes.some((n) => n.note.includes("no declared size"))).toBe(true);
    expect(code).toContain('width: 180px; height: 90px');
  });
});

describe("output shape", () => {
  it("contains no nt- tag, no class attribute, no <style> block, and no accent colour", () => {
    for (const name of Object.keys(COMPILE_FIXTURES) as (keyof typeof COMPILE_FIXTURES)[]) {
      const code = compileScene(fixture(name)).code;
      expect(code).not.toMatch(/<nt-/i);
      expect(code).not.toMatch(/class(Name)?=/);
      expect(code).not.toMatch(/<style/i);
      expect(code).not.toMatch(/--nt-select/);
    }
  });
});

describe("camera independence", () => {
  it("never imports engine/useViewport", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./toHtml.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/from ["'][^"']*useViewport["']/);
  });
});
