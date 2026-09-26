import { DOMParser } from "linkedom";
import { describe, expect, test } from "vitest";
import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { walk } from "@/app/components/editor/canvas/scene/types";
import { diagramStanding, takeBackDiagram } from "./diagram";

/**
 * Taking an agent's diagram change back while the person has been editing the
 * same diagram (NT-70).
 *
 * The scenes are written as the block prop holds them — canvas HTML — because
 * that is what the undo reads and writes, and the checks read the result the
 * same way a reader of the diagram would: which shapes are on it and where.
 */

// The merge parses and serializes scenes itself, with no parser to inject.
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const rect = (id: string, x: number, extra = "") =>
  `  <nt-rect id="${id}" x="${x}" y="0" w="100" h="100"${extra}></nt-rect>`;

const diagram = (...body: string[]) =>
  `<nt-diagram w="400" h="300">\n${body.join("\n")}\n</nt-diagram>`;

/** Every shape as `id@x`, in document order — the harness's own reading. */
const shapes = (html: string) => {
  const out: string[] = [];
  walk(migrateLegacyCanvas(html).nodes, (node) => void out.push(`${node.id}@${node.x}`));
  return out;
};

const edges = (html: string) =>
  migrateLegacyCanvas(html).edges.map((edge) => `${edge.id}:${edge.from}>${edge.to}`);

/** What the block prop said before the turn: one shape. */
const WAS = diagram(rect("a", 0));
/** The agent's whole-diagram write: a second shape beside it. */
const ASKED = diagram(rect("a", 0), rect("b", 220));

describe("takeBackDiagram", () => {
  test("takes the change's shape back and leaves the person's move alone", () => {
    const live = diagram(rect("a", 80), rect("b", 220));
    expect(shapes(takeBackDiagram(WAS, ASKED, live))).toEqual(["a@80"]);
  });

  test("with nothing edited since, it is the checkpoint", () => {
    expect(shapes(takeBackDiagram(WAS, ASKED, ASKED))).toEqual(["a@0"]);
  });

  test("a shape the person drew during the review stays", () => {
    const live = diagram(rect("a", 0), rect("b", 220), rect("mine", 300));
    expect(shapes(takeBackDiagram(WAS, ASKED, live))).toEqual(["a@0", "mine@300"]);
  });

  test("a shape the change rewrote and the person then moved is theirs", () => {
    const asked = diagram(rect("a", 150));
    const live = diagram(rect("a", 260));
    expect(shapes(takeBackDiagram(WAS, asked, live))).toEqual(["a@260"]);
  });

  test("a shape the change rewrote and nobody touched goes back", () => {
    const asked = diagram(rect("a", 150));
    expect(shapes(takeBackDiagram(WAS, asked, asked))).toEqual(["a@0"]);
  });

  test("a shape the change deleted comes back where it stood", () => {
    const was = diagram(rect("a", 0), rect("b", 100), rect("c", 200));
    const asked = diagram(rect("a", 0), rect("c", 200));
    const live = diagram(rect("a", 0), rect("c", 260));
    expect(shapes(takeBackDiagram(was, asked, live))).toEqual(["a@0", "b@100", "c@260"]);
  });

  test("a whole diagram the change replaced comes back, and their new shape stays", () => {
    const asked = diagram(rect("x", 0), rect("y", 100));
    const live = diagram(rect("x", 0), rect("y", 100), rect("mine", 300));
    expect(shapes(takeBackDiagram(WAS, asked, live))).toEqual(["a@0", "mine@300"]);
  });

  test("the surface's own fields go back unless the person changed them", () => {
    const surface = (html: string) => {
      const scene = migrateLegacyCanvas(html);
      return { h: scene.h, wide: scene.wide === true };
    };
    // WAS is an old root no one pinned: its band follows its content.
    const asked = `<nt-diagram h="400" wide>\n${rect("a", 0)}\n</nt-diagram>`;
    expect(surface(takeBackDiagram(WAS, asked, asked))).toEqual({ h: 0, wide: false });
    const resized = `<nt-diagram h="500" wide>\n${rect("a", 0)}\n</nt-diagram>`;
    expect(surface(takeBackDiagram(WAS, asked, resized))).toEqual({ h: 500, wide: true });
    const narrowed = `<nt-diagram h="400">\n${rect("a", 0)}\n</nt-diagram>`;
    expect(surface(takeBackDiagram(WAS, asked, narrowed))).toEqual({ h: 400, wide: false });
  });

  test("moving the change's shape further down is not a change to the surface", () => {
    const box = (id: string, y: number) =>
      `  <nt-rect id="${id}" x="0" y="${y}" w="100" h="72"></nt-rect>`;
    const was = `<nt-diagram h="120">\n${box("a", 24)}\n</nt-diagram>`;
    const asked = `<nt-diagram h="246">\n${box("a", 24)}\n${box("b", 150)}\n</nt-diagram>`;
    const live = `<nt-diagram h="246">\n${box("a", 24)}\n${box("b", 400)}\n</nt-diagram>`;
    const back = takeBackDiagram(was, asked, live);
    expect([migrateLegacyCanvas(back).h, shapes(back)]).toEqual([120, ["a@0"]]);
  });

  test("a shape the person drew inside a group the change added is theirs", () => {
    const asked = diagram(
      rect("a", 0),
      `  <nt-group id="g" x="200" y="0" w="200" h="200">`,
      rect("b", 0),
      `  </nt-group>`,
    );
    const live = asked.replace("</nt-group>", `${rect("mine", 50)}\n  </nt-group>`);
    // Out where the group was holding it, in the group's place: a child's box
    // is relative to its group's, so it takes the group's origin with it.
    expect(shapes(takeBackDiagram(WAS, asked, live))).toEqual(["a@0", "mine@250"]);
  });

  test("…through however many groups the change nested it in", () => {
    const asked = diagram(
      rect("a", 0),
      `  <nt-group id="g" x="200" y="0" w="200" h="200">`,
      `    <nt-group id="h" x="30" y="0" w="100" h="100">`,
      `    </nt-group>`,
      `  </nt-group>`,
    );
    const live = asked.replace("</nt-group>\n  </nt-group>", `${rect("mine", 50)}\n    </nt-group>\n  </nt-group>`);
    expect(shapes(takeBackDiagram(WAS, asked, live))).toEqual(["a@0", "mine@280"]);
  });

  test("connectors follow the shapes they join", () => {
    const was = diagram(rect("a", 0), rect("b", 220));
    const asked = diagram(
      rect("a", 0),
      rect("b", 220),
      `  <nt-edge id="e" from="a" to="b"></nt-edge>`,
    );
    const live = asked.replace('x="0"', 'x="80"');
    const back = takeBackDiagram(was, asked, live);
    expect(edges(back)).toEqual([]);
    expect(shapes(back)).toEqual(["a@80", "b@220"]);
  });

  test("a connector the change cut comes back", () => {
    const was = diagram(
      rect("a", 0),
      rect("b", 220),
      `  <nt-edge id="e" from="a" to="b"></nt-edge>`,
    );
    const asked = diagram(rect("a", 0), rect("b", 220));
    const live = asked.replace('x="0"', 'x="80"');
    expect(edges(takeBackDiagram(was, asked, live))).toEqual(["e:a>b"]);
  });

  test("the round trip is exact where there is nothing to take back", () => {
    const live = diagram(rect("a", 80));
    expect(takeBackDiagram(WAS, WAS, live)).toBe(serializeScene(migrateLegacyCanvas(live)));
  });
});

describe("diagramStanding", () => {
  test("the change's shape is still there", () => {
    expect(diagramStanding(WAS, ASKED, ASKED)).toBe(true);
  });

  test("…and still there once the person has moved another shape", () => {
    expect(diagramStanding(WAS, ASKED, diagram(rect("a", 80), rect("b", 220)))).toBe(true);
  });

  test("the fork died with its editor: the diagram is the checkpoint again", () => {
    expect(diagramStanding(WAS, ASKED, WAS)).toBe(false);
  });

  test("the person deleted the change's shape but moved another: their work is there", () => {
    expect(diagramStanding(WAS, ASKED, diagram(rect("a", 80)))).toBe(true);
  });
});
