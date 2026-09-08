import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { findNode, isGroup } from "@/app/components/editor/canvas/scene/types";
import { convertSelection } from "./convert";
import type { FigNode, Transform } from "./model";
import { gradientLayer } from "./paint";

const parse = (html: string) => parseScene(html, (h) => parseHTML(h).document as unknown as Document);

const at = (x: number, y: number): Transform => [
  [1, 0, x],
  [0, 1, y],
];

const solid = (r: number, g: number, b: number, opacity = 1) => ({ type: "SOLID", color: { r, g, b }, opacity });

const noImages = async () => null;

function textNode(overrides: Partial<FigNode> = {}): FigNode {
  return {
    id: "9:1",
    name: "Title",
    type: "TEXT",
    x: 0,
    y: 0,
    width: 200,
    height: 40,
    relativeTransform: at(20, 20),
    characters: "Plan the launch",
    fontSize: 24,
    fontName: { family: "Inter", style: "Semi Bold" },
    fills: [solid(0.1, 0.1, 0.1)],
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
    textAutoResize: "WIDTH_AND_HEIGHT",
    lineHeight: { value: 120, unit: "PERCENT" },
    ...overrides,
  };
}

describe("convertSelection", () => {
  it("writes markup the canvas parses and round-trips byte for byte", async () => {
    const card: FigNode = {
      id: "1:2",
      name: "Card",
      type: "FRAME",
      x: 100,
      y: 80,
      width: 240,
      height: 120,
      absoluteTransform: at(100, 80),
      layoutMode: "VERTICAL",
      itemSpacing: 8,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16,
      primaryAxisAlignItems: "MIN",
      counterAxisAlignItems: "CENTER",
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "HUG",
      clipsContent: true,
      cornerRadius: 12,
      fills: [solid(1, 1, 1)],
      strokes: [solid(0.9, 0.9, 0.9)],
      strokeWeight: 1,
      strokeAlign: "INSIDE",
      effects: [{ type: "DROP_SHADOW", radius: 8, spread: 0, offset: { x: 0, y: 2 }, color: { r: 0, g: 0, b: 0, a: 0.12 } }],
      children: [
        textNode(),
        {
          id: "1:3",
          name: "Rectangle 4",
          type: "RECTANGLE",
          x: 0,
          y: 0,
          width: 208,
          height: 40,
          relativeTransform: at(16, 64),
          layoutSizingHorizontal: "FILL",
          fills: [
            {
              type: "GRADIENT_LINEAR",
              gradientStops: [
                { position: 0, color: { r: 1, g: 0.4, b: 0.2, a: 1 } },
                { position: 1, color: { r: 0.2, g: 0.4, b: 1, a: 1 } },
              ],
              // Figma's default: a quarter turn, top to bottom.
              gradientTransform: [
                [0, 1, 0],
                [-1, 0, 1],
              ],
            },
          ],
        },
      ],
    };

    const { scene, report, count } = await convertSelection([card], noImages);
    const html = serializeScene(scene);

    expect(count).toBe(3);
    expect(report).toEqual([]);
    expect(serializeScene(parse(html))).toBe(html);

    const group = findNode(scene, "f1-2")!;
    expect(isGroup(group)).toBe(true);
    // The selection's corner is the origin.
    expect([group.x, group.y]).toEqual([0, 0]);
    expect(group.style).toMatchObject({
      display: "flex",
      "flex-direction": "column",
      gap: "8px",
      padding: "16px",
      "align-items": "center",
      height: "fit-content",
      overflow: "hidden",
      "border-radius": "12px",
      background: "#ffffff",
      border: "1px solid #e6e6e6",
      "box-shadow": "0px 2px 8px 0px rgba(0, 0, 0, 0.12)",
    });
    expect(group.attrs["data-figma-id"]).toBe("1:2");
    expect(html).toContain('data-figma-id="1:2"');

    const rect = findNode(scene, "f1-3")!;
    expect(rect.style.background).toBe("linear-gradient(180deg, #ff6633 0%, #3366ff 100%)");
    expect(rect.style["align-self"]).toBe("stretch");
    expect(rect.name).toBeUndefined();
  });

  it("gives a text its style and a plain label when nothing differs", async () => {
    const { scene } = await convertSelection([textNode()], noImages);
    const text = findNode(scene, "f9-1")!;
    expect(text.kind).toBe("text");
    expect(text.label).toBe("Plan the launch");
    expect(text.style).toMatchObject({
      "font-family": '"Inter", sans-serif',
      "font-size": "24px",
      "font-weight": "600",
      color: "#1a1a1a",
      "line-height": "1.2",
      width: "max-content",
      height: "auto",
      "text-align": "left",
    });
  });

  it("writes only the differences of a styled range, as marks and spans", async () => {
    const node = textNode({
      characters: "Ship it now\nSecond line",
      paragraphSpacing: 6,
      getStyledTextSegments: () => [
        { characters: "Ship ", start: 0, end: 5, fontSize: 24, fontName: { family: "Inter", style: "Semi Bold" }, fills: [solid(0.1, 0.1, 0.1)] },
        { characters: "it", start: 5, end: 7, fontSize: 24, fontName: { family: "Inter", style: "Black Italic" }, fills: [solid(0.7, 0.2, 0.1)] },
        { characters: " now\nSecond line", start: 7, end: 23, fontSize: 14, fontName: { family: "Inter", style: "Regular" }, fills: [solid(0.1, 0.1, 0.1)], textDecoration: "UNDERLINE", hyperlink: { type: "URL", value: "https://example.com" } },
      ],
    });
    const { scene } = await convertSelection([node], noImages);
    const text = findNode(scene, "f9-1")!;
    expect(text.label).toBe(
      '<p style="margin-bottom: 6px">Ship <span style="color: #b3331a; font-weight: 900"><i>it</i></span>' +
        '<a href="https://example.com"><span style="font-size: 14px; font-weight: 400"><u> now</u></span></a></p>' +
        '<p><a href="https://example.com"><span style="font-size: 14px; font-weight: 400"><u>Second line</u></span></a></p>',
    );
    expect(serializeScene(parse(serializeScene(scene)))).toBe(serializeScene(scene));
  });

  it("carries arcs, polygons, vectors and a placeholder for the unknown", async () => {
    const nodes: FigNode[] = [
      { id: "2:1", name: "Ellipse 1", type: "ELLIPSE", x: 0, y: 0, width: 80, height: 80, absoluteTransform: at(0, 0), fills: [solid(0.5, 0.5, 0.5)], arcData: { startingAngle: 0, endingAngle: Math.PI / 2, innerRadius: 0.5 } },
      { id: "2:2", name: "Polygon 1", type: "POLYGON", x: 0, y: 0, width: 60, height: 60, absoluteTransform: at(100, 0), pointCount: 6, fills: [solid(0.2, 0.2, 0.2)] },
      { id: "2:3", name: "Vector 1", type: "VECTOR", x: 0, y: 0, width: 50, height: 20, absoluteTransform: at(200, 0), fills: [], strokes: [solid(0, 0, 0)], strokeWeight: 2, strokeCap: "ROUND", vectorPaths: [{ windingRule: "NONZERO", data: "M 0 10 L 50 10" }] },
      { id: "2:4", name: "Widget", type: "WIDGET", x: 0, y: 0, width: 100, height: 40, absoluteTransform: at(300, 0) },
    ];
    const { scene, report } = await convertSelection(nodes, noImages);
    const ellipse = findNode(scene, "f2-1")!;
    expect(ellipse.kind).toBe("ellipse");
    expect(ellipse).toMatchObject({ start: 90, sweep: 90, inner: 0.5 });
    expect(findNode(scene, "f2-2")).toMatchObject({ kind: "polygon", sides: 6 });
    expect(findNode(scene, "f2-3")).toMatchObject({
      kind: "path",
      d: "M 0 10 L 50 10",
      style: { fill: "none", stroke: "#000000", "stroke-width": "2", "stroke-linecap": "round" },
    });
    expect(findNode(scene, "f2-4")).toMatchObject({ kind: "rect", label: "Widget" });
    expect(report.map((r) => r.code)).toEqual(["stubbed"]);
    const html = serializeScene(scene);
    expect(serializeScene(parse(html))).toBe(html);
  });

  it("writes FigJam connectors as edges between the shapes they join", async () => {
    const nodes: FigNode[] = [
      { id: "3:1", name: "Shape", type: "SHAPE_WITH_TEXT", shapeType: "ROUNDED_RECTANGLE", x: 0, y: 0, width: 120, height: 60, absoluteTransform: at(0, 0), fills: [solid(0.9, 0.9, 1)], text: { characters: "Draft" } },
      { id: "3:2", name: "Shape", type: "SHAPE_WITH_TEXT", shapeType: "ELLIPSE", x: 0, y: 0, width: 120, height: 60, absoluteTransform: at(200, 0), fills: [solid(0.9, 1, 0.9)], text: { characters: "Ship" } },
      { id: "3:3", name: "Connector", type: "CONNECTOR", x: 0, y: 0, width: 0, height: 0, connectorStart: { endpointNodeId: "3:1" }, connectorEnd: { endpointNodeId: "3:2" }, strokes: [solid(0, 0, 0)], strokeWeight: 2, text: { characters: "review" } },
      { id: "3:4", name: "Connector", type: "CONNECTOR", x: 0, y: 0, width: 0, height: 0, connectorStart: { endpointNodeId: "3:1" }, connectorEnd: { position: { x: 5, y: 5 } } },
    ];
    const { scene, report, count } = await convertSelection(nodes, noImages);
    expect(scene.edges).toEqual([
      { id: "e1", from: "f3-1", to: "f3-2", label: "review", style: { stroke: "#000000", "stroke-width": "2" }, attrs: { "data-figma-id": "3:3" } },
    ]);
    expect(count).toBe(3);
    expect(report.map((r) => r.code)).toEqual(["connector_dropped"]);
    expect(findNode(scene, "f3-1")).toMatchObject({ kind: "rect", label: "Draft" });
    expect(findNode(scene, "f3-2")).toMatchObject({ kind: "ellipse", label: "Ship" });
  });

  it("makes a lone image fill an image, and fetches its bytes once", async () => {
    let fetched = 0;
    const images = async (hash: string) => {
      fetched += 1;
      return hash === "abc" ? "data:image/png;base64,AAAA" : null;
    };
    const nodes: FigNode[] = [
      { id: "4:1", name: "Photo", type: "RECTANGLE", x: 0, y: 0, width: 100, height: 100, absoluteTransform: at(0, 0), cornerRadius: 8, fills: [{ type: "IMAGE", imageHash: "abc", scaleMode: "FIT" }] },
      { id: "4:2", name: "Photo", type: "RECTANGLE", x: 0, y: 0, width: 100, height: 100, absoluteTransform: at(200, 0), fills: [{ type: "IMAGE", imageHash: "abc", scaleMode: "FILL" }, solid(1, 0, 0)] },
    ];
    const { scene } = await convertSelection(nodes, images);
    expect(fetched).toBe(1);
    expect(findNode(scene, "f4-1")).toMatchObject({
      kind: "image",
      src: "data:image/png;base64,AAAA",
      style: { "object-fit": "contain", "border-radius": "8px" },
    });
    // A solid above the picture: a background stack, the picture under it.
    expect(findNode(scene, "f4-2")!.style.background).toBe(
      'linear-gradient(#ff0000, #ff0000), url("data:image/png;base64,AAAA") center / cover no-repeat',
    );
  });
});

describe("gradientLayer", () => {
  const stops = [
    { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
    { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
  ];
  it("reads the identity as left to right and the quarter turn as top to bottom", () => {
    expect(gradientLayer({ type: "GRADIENT_LINEAR", gradientStops: stops }, 100, 100)).toBe(
      "linear-gradient(90deg, #000000 0%, #ffffff 100%)",
    );
    expect(
      gradientLayer(
        { type: "GRADIENT_LINEAR", gradientStops: stops, gradientTransform: [[0, 1, 0], [-1, 0, 1]] },
        100,
        100,
      ),
    ).toBe("linear-gradient(180deg, #000000 0%, #ffffff 100%)");
  });
  it("spells a diamond as four quadrant gradients", () => {
    const css = gradientLayer({ type: "GRADIENT_DIAMOND", gradientStops: stops }, 100, 100)!;
    expect(css.split(", linear-gradient").length).toBe(4);
    expect(css).toContain("to top right");
    expect(css).toContain("50% 50% no-repeat");
  });
});
