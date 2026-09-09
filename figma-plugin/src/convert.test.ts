import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { findNode, isGroup, type SceneNode } from "@/app/components/editor/canvas/scene/types";
import { convertSelection } from "./convert";
import type { FigNode, Transform } from "./model";
import { misplaced } from "./oracle";
import { gradientLayer } from "./paint";

const parse = (html: string) => parseScene(html, (h) => parseHTML(h).document as unknown as Document);

const at = (x: number, y: number): Transform => [
  [1, 0, x],
  [0, 1, y],
];

/** Figma's spelling of a turn: `deg` counter-clockwise about the top-left, at (x, y). */
const turned = (deg: number, x: number, y: number): Transform => {
  const r = (deg * Math.PI) / 180;
  return [
    [Math.cos(r), Math.sin(r), x],
    [-Math.sin(r), Math.cos(r), y],
  ];
};

/** `outer · inner`: `inner` applies first. */
const mul = (o: Transform, i: Transform): Transform => [
  [o[0][0] * i[0][0] + o[0][1] * i[1][0], o[0][0] * i[0][1] + o[0][1] * i[1][1], o[0][0] * i[0][2] + o[0][1] * i[1][2] + o[0][2]],
  [o[1][0] * i[0][0] + o[1][1] * i[1][0], o[1][0] * i[0][1] + o[1][1] * i[1][1], o[1][0] * i[0][2] + o[1][1] * i[1][2] + o[1][2]],
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
    relativeTransform: at(20, 16),
    absoluteTransform: at(120, 96),
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
          absoluteTransform: at(116, 144),
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
    expect(misplaced([card], scene)).toEqual([]);

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

describe("placement", () => {
  // Figma sees through a group: its children's relativeTransform is in the
  // containing frame's space, not the group's. Only the absolutes tell where
  // a child sits inside its group.
  const rect = (id: string, abs: Transform, rel: Transform): FigNode => ({
    id,
    name: "Rectangle 1",
    type: "RECTANGLE",
    x: rel[0][2],
    y: rel[1][2],
    width: 40,
    height: 20,
    absoluteTransform: abs,
    relativeTransform: rel,
    fills: [solid(0.5, 0.5, 0.5)],
  });
  const frame = (group: FigNode): FigNode => ({
    id: "1:1",
    name: "Frame 1",
    type: "FRAME",
    x: 100,
    y: 80,
    width: 300,
    height: 200,
    absoluteTransform: at(100, 80),
    children: [group],
  });

  it("places a group's children in the group's space, not the frame's", async () => {
    const selection = frame({
      id: "1:2",
      name: "Group 1",
      type: "GROUP",
      x: 20,
      y: 20,
      width: 100,
      height: 60,
      absoluteTransform: at(120, 100),
      relativeTransform: at(20, 20),
      children: [rect("1:3", at(130, 110), at(30, 30))],
    });
    const { scene } = await convertSelection([selection], noImages);
    expect(findNode(scene, "f1-2")).toMatchObject({ x: 20, y: 20, rot: 0 });
    expect(findNode(scene, "f1-3")).toMatchObject({ x: 10, y: 10, rot: 0 });
    expect(misplaced([selection], scene)).toEqual([]);
  });

  it("keeps a child of a turned group where Figma had it on the page", async () => {
    const groupAbs = turned(30, 120, 100);
    const rectAbs = mul(groupAbs, at(10, 10));
    const selection = frame({
      id: "1:2",
      name: "Group 1",
      type: "GROUP",
      x: 20,
      y: 20,
      width: 100,
      height: 60,
      rotation: 30,
      absoluteTransform: groupAbs,
      relativeTransform: turned(30, 20, 20),
      children: [rect("1:3", rectAbs, mul(at(-100, -80), rectAbs))],
    });
    const { scene } = await convertSelection([selection], noImages);
    expect(findNode(scene, "f1-2")).toMatchObject({ rot: 330 });
    expect(findNode(scene, "f1-3")).toMatchObject({ x: 10, y: 10, rot: 0 });
    expect(misplaced([selection], scene)).toEqual([]);
  });
});

// Reduced from a details dump of a phone frame whose every group pasted
// shifted: the ids and names are the file's own.
describe("placement, from the report", () => {
  const phone = (child: FigNode): FigNode => ({
    id: "1:2",
    name: "iPhone 16 - 1",
    type: "FRAME",
    x: -54,
    y: -153,
    width: 393,
    height: 852,
    absoluteTransform: at(-54, -153),
    relativeTransform: at(-54, -153),
    fills: [solid(1, 1, 1)],
    children: [child],
  });
  const white = [solid(1, 1, 1)];

  it("places a group inside a group, each in its own parent's space", async () => {
    const selection = phone({
      id: "11:505",
      name: "Group 22",
      type: "GROUP",
      x: 36.17,
      y: 89.29,
      width: 323.71,
      height: 44.25,
      absoluteTransform: at(-17.8316, -63.7062),
      relativeTransform: at(36.1684, 89.2938),
      children: [
        {
          id: "11:549",
          name: "Group 25",
          type: "GROUP",
          x: 36.17,
          y: 89.29,
          width: 323.71,
          height: 44.25,
          absoluteTransform: at(-17.8316, -63.7062),
          relativeTransform: at(36.1684, 89.2938),
          children: [
            { id: "11:506", name: "Rectangle 10", type: "RECTANGLE", x: 36.17, y: 89.29, width: 323.71, height: 44.25, absoluteTransform: at(-17.8316, -63.7062), relativeTransform: at(36.1684, 89.2938), cornerRadius: 15, fills: [solid(0.137, 0.137, 0.137)] },
            { id: "11:547", name: "Icon", type: "VECTOR", x: 49.87, y: 103.92, width: 15, height: 15, absoluteTransform: at(-4.1303, -49.0788), relativeTransform: at(49.8697, 103.9212), fills: [], strokes: white, strokeWeight: 1, vectorPaths: [{ windingRule: "NONE", data: "M 15 15 L 11.375 11.375" }] },
          ],
        },
      ],
    });
    const { scene, report } = await convertSelection([selection], noImages);
    expect(report).toEqual([]);
    expect(findNode(scene, "f11-505")).toMatchObject({ x: 36.17, y: 89.29 });
    expect(findNode(scene, "f11-549")).toMatchObject({ x: 0, y: 0 });
    expect(findNode(scene, "f11-506")).toMatchObject({ x: 0, y: 0 });
    expect(findNode(scene, "f11-547")).toMatchObject({ x: 13.7, y: 14.63 });
    expect(misplaced([selection], scene)).toEqual([]);
  });

  it("keeps a skewed group's children at their true centres and angles, and says the skew was lost", async () => {
    const selection = phone({
      id: "36:363",
      name: "Group 44",
      type: "GROUP",
      x: 17.33,
      y: 795.18,
      width: 364.87,
      height: 65.82,
      absoluteTransform: at(-36.6741, 642.1754),
      relativeTransform: at(17.3259, 795.1754),
      children: [
        {
          id: "36:365",
          name: "Group 9",
          type: "GROUP",
          x: 47.79,
          y: 816.78,
          width: 43.27,
          height: 29.86,
          rotation: 3.3496,
          absoluteTransform: [[0.9983, -0.3909, -6.211], [-0.0584, 0.9204, 663.7778]],
          relativeTransform: [[0.9983, -0.3909, 47.789], [-0.0584, 0.9204, 816.7778]],
          children: [
            { id: "36:366", name: "Rectangle 9", type: "RECTANGLE", x: 78.5, y: 816.22, width: 1.88, height: 21.39, rotation: -57.3202, absoluteTransform: [[0.4029, -0.9965, 24.4969], [0.628, 0.6707, 663.2204]], relativeTransform: [[0.4029, -0.9965, 78.4969], [0.628, 0.6707, 816.2204]], fills: white },
            { id: "36:367", name: "Vector 1", type: "VECTOR", x: 47.79, y: 816.78, width: 31.52, height: 24.96, rotation: 0, absoluteTransform: [[1, 0, -6.211], [0, 1, 663.7778]], relativeTransform: [[1, 0, 47.789], [0, 1, 816.7778]], fills: [solid(0.858, 0.858, 0.858)], vectorPaths: [{ windingRule: "NONE", data: "M 0 21.08 L 31.52 0" }] },
            { id: "36:368", name: "Vector", type: "VECTOR", x: 59.41, y: 825.33, width: 10.02, height: 13.95, rotation: -54.482, absoluteTransform: [[0.4332, -0.9839, 5.4067], [0.6069, 0.6899, 672.3303]], relativeTransform: [[0.4332, -0.9839, 59.4067], [0.6069, 0.6899, 825.3303]], fills: white, vectorPaths: [{ windingRule: "NONZERO", data: "M 0 8.58 L 10.02 13.95" }] },
          ],
        },
      ],
    });
    const { scene, report } = await convertSelection([selection], noImages);
    // Vector 1 is square on the page even inside the skewed group, and is not reported.
    expect(report.map((r) => `${r.code} ${r.nodeId}`)).toEqual(["skewed 36:365", "skewed 36:366", "skewed 36:368"]);
    expect(report[0].message).toBe("A skewed layer was drawn unskewed; the canvas has no skew.");
    expect(misplaced([selection], scene)).toEqual([]);
  });
});

// Reduced from a details dump of a row of app icons whose vectors pasted
// "weird": black squares where the SVG importer's masks were, black outlines
// where gradient fills had been dropped, and rectangles cast as shadows.
describe("vectors, from the report", () => {
  const box = (w: number, h: number) => `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} L 0 0 Z`;
  const byFigmaId = (nodes: SceneNode[], id: string): SceneNode | null => {
    for (const n of nodes) {
      if (n.attrs["data-figma-id"] === id) return n;
      if (n.kind === "group") {
        const inner = byFigmaId(n.children, id);
        if (inner) return inner;
      }
    }
    return null;
  };
  const vector = (id: string, abs: Transform, w: number, h: number, extra: Partial<FigNode> = {}): FigNode => ({
    id,
    name: "Vector",
    type: "VECTOR",
    x: abs[0][2],
    y: abs[1][2],
    width: w,
    height: h,
    absoluteTransform: abs,
    relativeTransform: abs,
    strokes: [],
    strokeWeight: 1,
    vectorPaths: [{ windingRule: "NONZERO", data: box(w, h) }],
    ...extra,
  });
  const group = (id: string, name: string, abs: Transform, w: number, h: number, children: FigNode[], extra: Partial<FigNode> = {}): FigNode => ({
    id,
    name,
    type: "GROUP",
    x: abs[0][2],
    y: abs[1][2],
    width: w,
    height: h,
    absoluteTransform: abs,
    relativeTransform: abs,
    children,
    ...extra,
  });
  const plum = { r: 0.447, g: 0.322, b: 0.667, a: 1 };
  const gradient = {
    type: "GRADIENT_LINEAR",
    gradientStops: [
      { position: 0, color: plum },
      { position: 1, color: plum },
    ],
    gradientTransform: [[-0.645, 0.575, 0.532], [-0.65, -0.571, 1.036]] as Transform,
  };
  const shadow = { type: "DROP_SHADOW", radius: 5.18, spread: 0, offset: { x: 0, y: 1.29 }, color: { r: 0, g: 0, b: 0, a: 0.22 } };

  it("applies the importer's masks as clips, paints gradients as backgrounds, and leaves the unpainted unpainted", async () => {
    const side = 85.9102554321289;
    const at0 = at(145.0445556640625, 519.666015625);
    const clip = group("1:306", "Clip path group", at0, side, side, [
      group("1:307", "a", at0, side, side, [vector("1:308", at0, side, side, { fills: [solid(0, 0, 0)] })], { isMask: true, maskType: "VECTOR" }),
      group("1:322", "Group", at(146.477, 519.666), 82.884, 73.382, [vector("1:323", at(146.477, 519.666), 82.884, 73.382, { fills: [gradient] })], { effects: [shadow] }),
    ]);
    const frame: FigNode = {
      id: "1:305",
      name: "Frame",
      type: "FRAME",
      x: 0,
      y: 0,
      width: 125,
      height: 125,
      absoluteTransform: at(125.5, 500.1214599609375),
      relativeTransform: at(0, 0),
      clipsContent: true,
      fills: [{ ...solid(1, 1, 1), visible: false }],
      children: [
        clip,
        vector("1:27", at(125.882, 500.121), 94.31, 93, { fills: [] }),
        { id: "1:12", name: "Vector", type: "LINE", x: 0, y: 0, width: 58.85, height: 0, absoluteTransform: at(155.446, 514.653), relativeTransform: at(29.946, 14.531), fills: [], strokes: [solid(0, 0, 0)], strokeWeight: 1, fillGeometry: [{ data: "M0 0 L58.85 0 Z" }], strokeGeometry: [{ data: "M0 -0.5 L58.85 -0.5 L58.85 0.5 L0 0.5 Z" }] },
      ],
    };

    const { scene, report } = await convertSelection([frame], noImages);
    expect(report).toEqual([]);
    // The mask is the group's clip, not a node; a plain box over the whole group is the group clipping its contents.
    expect(byFigmaId(scene.nodes, "1:307")).toBeNull();
    expect(byFigmaId(scene.nodes, "1:308")).toBeNull();
    expect(byFigmaId(scene.nodes, "1:306")!.style).toEqual({ overflow: "hidden" });
    // A gradient is the same background a box wears, and nothing else that would ink an outline.
    const plumb = byFigmaId(scene.nodes, "1:323")!;
    expect(plumb.style.background).toMatch(/^linear-gradient\(/);
    expect(plumb.style).toMatchObject({ stroke: "none" });
    expect(plumb.style.fill).toBeUndefined();
    // The document keeps the shadow's own spelling; the renderer casts it from the drawing.
    expect(byFigmaId(scene.nodes, "1:322")!.style["box-shadow"]).toBe("0px 1.29px 5.18px 0px rgba(0, 0, 0, 0.22)");
    // The importer's bounding rectangle: no fill, no stroke, and said so.
    expect(byFigmaId(scene.nodes, "1:27")!.style).toEqual({ fill: "none", stroke: "none" });
    // A line is the segment across its box, stroked once.
    expect(byFigmaId(scene.nodes, "1:12")).toMatchObject({ kind: "path", d: "M 0 0 L 58.85 0", style: { fill: "none", stroke: "#000000", "stroke-width": "1" } });
    const html = serializeScene(scene);
    expect(serializeScene(parse(html))).toBe(html);
    expect(misplaced([frame], scene)).toEqual([]);
  });

  it("wraps what a mask above the bottom masks, in a group that keeps the mask's id and outline", async () => {
    const holder = group("2:1", "Group 1", at(0, 0), 100, 100, [
      vector("2:2", at(0, 0), 100, 100, { fills: [solid(0.9, 0.9, 0.9)] }),
      { id: "2:3", name: "Mask", type: "RECTANGLE", x: 10, y: 10, width: 20, height: 20, absoluteTransform: at(10, 10), relativeTransform: at(10, 10), isMask: true, fills: [solid(0, 0, 0)] },
      vector("2:4", at(5, 5), 40, 40, { fills: [solid(1, 0, 0)] }),
    ]);
    const { scene, report } = await convertSelection([holder], noImages);
    expect(report).toEqual([]);
    const outer = findNode(scene, "f2-1")!;
    expect(isGroup(outer) && outer.children.map((c) => c.id)).toEqual(["f2-2", "f2-3"]);
    const wrapper = findNode(scene, "f2-3")!;
    expect(wrapper).toMatchObject({ kind: "group", x: 0, y: 0, w: 100, h: 100, name: "Mask", attrs: { "data-figma-id": "2:3" } });
    expect(wrapper.style["clip-path"]).toMatch(/^path\("M 10 10 L 30 10 L 30 30 L 10 30 (L 10 10 )?Z"\)$/);
    expect(isGroup(wrapper) && wrapper.children.map((c) => c.id)).toEqual(["f2-4"]);
    expect(findNode(scene, "f2-4")).toMatchObject({ x: 5, y: 5 });
    const html = serializeScene(scene);
    expect(serializeScene(parse(html))).toBe(html);
  });

  // The navigation row from a second dump: space-between with a stale gap of
  // 290 that Figma does not consult, which pushed the last button off the end.
  it("writes one gap along the main axis, none under space-between, and the cross gap only when wrapping", async () => {
    const row = (id: string, extra: Partial<FigNode>): FigNode => ({
      id,
      name: "Frame 856",
      type: "FRAME",
      x: 0,
      y: 0,
      width: 1303,
      height: 60,
      absoluteTransform: at(0, 0),
      layoutMode: "HORIZONTAL",
      itemSpacing: 290,
      counterAxisSpacing: 12,
      ...extra,
    });
    const { scene } = await convertSelection(
      [
        row("4:1", { primaryAxisAlignItems: "SPACE_BETWEEN" }),
        row("4:2", { absoluteTransform: at(0, 100), primaryAxisAlignItems: "MIN" }),
        row("4:3", { absoluteTransform: at(0, 200), layoutWrap: "WRAP" }),
      ],
      noImages,
    );
    expect(findNode(scene, "f4-1")!.style).toMatchObject({ "justify-content": "space-between" });
    expect(findNode(scene, "f4-1")!.style.gap).toBeUndefined();
    expect(findNode(scene, "f4-2")!.style).toMatchObject({ gap: "290px" });
    expect(findNode(scene, "f4-2")!.style["row-gap"]).toBeUndefined();
    expect(findNode(scene, "f4-3")!.style).toMatchObject({ "flex-wrap": "wrap", gap: "290px", "row-gap": "12px" });
  });

  it("wears a gradient stroke in its first colour and says so", async () => {
    const frame: FigNode = {
      id: "3:1",
      name: "Frame 8",
      type: "FRAME",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      absoluteTransform: at(0, 0),
      fills: [solid(1, 1, 1)],
      strokes: [{ type: "GRADIENT_LINEAR", gradientStops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { position: 1, color: { r: 0.66, g: 0.66, b: 0.66, a: 1 } }] }],
      strokeWeight: 1,
      strokeAlign: "INSIDE",
    };
    const { scene, report } = await convertSelection([frame], noImages);
    expect(findNode(scene, "f3-1")!.style.border).toBe("1px solid #ffffff");
    expect(report.map((r) => r.code)).toEqual(["gradient_stroke"]);
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
