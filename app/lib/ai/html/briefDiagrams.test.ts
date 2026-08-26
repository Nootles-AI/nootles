import { beforeAll, describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { SceneNode } from "@/app/components/editor/canvas/scene/types";
import type { AnyBlock } from "../projection";
import { parseDocHtml } from "./parse";
import { toDocHtml } from "./serialize";

// The brief reads scenes back through their own parser, which reaches for the
// platform DOMParser; linkedom stands in for it here.
beforeAll(() => {
  (globalThis as { DOMParser?: unknown }).DOMParser = class {
    parseFromString(html: string) {
      return parseHTML(html).document;
    }
  };
});

const parse = (html: string) => parseHTML(html).document;

function rect(id: string, label: string): SceneNode {
  return {
    id,
    kind: "rect",
    x: 0,
    y: 0,
    w: 100,
    h: 40,
    rot: 0,
    style: {},
    label,
    locked: false,
    hidden: false,
    attrs: {},
  };
}

function scene(nodes: SceneNode[]): string {
  return serializeScene({ w: 600, h: 400, style: {}, nodes, edges: [], attrs: {} });
}

function block(id: string, data: string): AnyBlock {
  return {
    id,
    type: "canvas",
    props: { data },
    content: undefined,
    children: [],
  } as unknown as AnyBlock;
}

describe("diagrams as briefs", () => {
  const states = block(
    "C1",
    scene([rect("s1", "Idle"), rect("s2", "Adding"), rect("s3", "Saved")]),
  );

  it("serializes a diagram as the build macro quoting its labels", () => {
    const html = toDocHtml([states], { diagramsAsBriefs: true });
    expect(html).toBe(
      '<nt-build-diagram id="C1">a diagram of Idle, Adding, Saved</nt-build-diagram>',
    );
  });

  it("trails off past the label cap", () => {
    const many = block(
      "C2",
      scene(Array.from({ length: 10 }, (_, i) => rect(`s${i}`, `Step ${i + 1}`))),
    );
    const html = toDocHtml([many], { diagramsAsBriefs: true });
    expect(html).toContain("Step 8, …");
    expect(html).not.toContain("Step 9");
  });

  it("falls back to a shape count when nothing is labelled", () => {
    const mute = block("C3", scene([rect("s1", ""), rect("s2", "")]));
    expect(toDocHtml([mute], { diagramsAsBriefs: true })).toBe(
      '<nt-build-diagram id="C3">a diagram (2 shapes)</nt-build-diagram>',
    );
  });

  it("leaves the shapes inline when the option is off", () => {
    expect(toDocHtml([states])).toContain("<nt-rect");
  });

  it("drops the macro on parse, so both sides of the diff agree", () => {
    // The compile half parses the same projection the model was shown; the
    // brief must vanish identically from both, or an untouched diagram would
    // read as one the completion deleted.
    const html = toDocHtml([states], { diagramsAsBriefs: true });
    expect(parseDocHtml(html, parse)).toEqual([]);
    expect(parseDocHtml(`${html}<p>after</p>`, parse)).toEqual(
      parseDocHtml("<p>after</p>", parse),
    );
  });
});
