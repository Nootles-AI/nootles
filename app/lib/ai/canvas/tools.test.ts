import { describe, expect, it } from "vitest";
import { fitOps } from "@/app/components/editor/canvas/scene/band";
import { findNode, type Scene } from "@/app/components/editor/canvas/scene/types";
import { CANVAS_TOOLS, CLIENT_TOOLS, TOOLS, type CanvasToolName, type ToolName } from "../chat/tools";
import { runCanvasTool } from "./execute";
import { f1 } from "./fixtures";
import type { CanvasHost, CanvasRead, Refusal, WriteReceipt } from "./host";

/**
 * Table invariants (TOOLS.md §8.1, T1–T8) — cross-cutting properties of the
 * tool table and the shared executor, each checked once here instead of
 * once per tool.
 */

describe("TOOLS table invariants", () => {
  it("T1 every entry declares side, mutates and surfaces", () => {
    for (const name of Object.keys(TOOLS) as ToolName[]) {
      const spec = TOOLS[name];
      expect(["server", "client"]).toContain(spec.side);
      expect(typeof spec.mutates).toBe("boolean");
      expect(Array.isArray(spec.surfaces)).toBe(true);
      expect(spec.surfaces.length).toBeGreaterThan(0);
    }
  });

  it("T2 CLIENT_TOOLS equals the side:\"client\" names", () => {
    const expected = (Object.keys(TOOLS) as ToolName[]).filter((n) => TOOLS[n].side === "client").sort();
    expect([...CLIENT_TOOLS].sort()).toEqual(expected);
  });

  // The whole browser tool module is imported here, and under a full parallel
  // run that alone overran the default 5s (it takes ~0.7s on its own).
  it("T3 every CLIENT_TOOLS name has a registered executor", { timeout: 20_000 }, async () => {
    const { runClientTool } = await import("../chat/clientTools");
    for (const name of CLIENT_TOOLS) {
      await expect(runClientTool(name, {}, {} as never)).rejects.not.toThrow(
        `No client tool named ${name}`,
      );
    }
  });

  it("T4 every CANVAS_TOOLS entry is client-side and offers mcp", () => {
    for (const name of CANVAS_TOOLS) {
      expect(TOOLS[name].side).toBe("client");
      expect(TOOLS[name].surfaces).toContain("mcp");
    }
  });

  it("T5 no canvas tool description leaks implementation vocabulary (store, CRDT, SceneOp)", () => {
    // Bare "op"/"ops" is not itself forbidden — `group`'s own schema field is
    // named `op` (a boolean operation) and its canonical description names
    // it by that word. What T5 actually guards against is the OPERATOR
    // LAYER leaking into model-facing text: "SceneOp", "the op layer", "the
    // store", "CRDT", "dispatch" — none of which any tool needs to say.
    const forbidden = /\bCRDT\b|\bSceneOp\b|\bthe store\b|\bthe op layer\b|\bdispatch(ed)?\b/i;
    for (const name of CANVAS_TOOLS) {
      expect(TOOLS[name].description).not.toMatch(forbidden);
    }
  });

  it("T6 every mutating canvas tool's schema requires blockId", () => {
    for (const name of CANVAS_TOOLS) {
      if (!TOOLS[name].mutates) continue;
      const result = TOOLS[name].inputSchema.safeParse({});
      expect(result.success).toBe(false);
    }
  });

  it("T7 every canvas tool surfaces the shot sentence for a storyboard-shot blockId", async () => {
    const sentence = 'The "b7:2" address is a storyboard shot; shots are rewritten whole through edit_page for now.';
    const shotHost: CanvasHost = {
      readScene: async () => ({ refused: sentence }) satisfies Refusal,
      writeScene: async () => {
        throw new Error("should never write");
      },
      prepareParse: async () => {},
    };
    for (const name of CANVAS_TOOLS) {
      const result = await runCanvasTool(name, minimalInput(name), shotHost);
      expect(result).toBe(sentence);
    }
  });

  it("T8 a write whose receipt comes back all-zero reports Nothing to do", async () => {
    const scene = f1();
    const zeroHost: CanvasHost = {
      readScene: async () => ({ pageId: "p1", blockId: "b1", scene }) satisfies CanvasRead,
      writeScene: async (): Promise<WriteReceipt> => ({ added: 0, removed: 0, changed: 0, hunks: 0 }),
      prepareParse: async () => {},
    };
    const result = await runCanvasTool(
      "move",
      { pageId: "p1", blockId: "b1", ids: ["s1"], dx: 1, dy: 0 },
      zeroHost,
    );
    expect(result).toBe("Nothing to do — the diagram already reads that way.");
  });

  it("read tools never call writeScene", async () => {
    const scene = f1();
    let wrote = false;
    const host: CanvasHost = {
      readScene: async () => ({ pageId: "p1", blockId: "b1", scene }) satisfies CanvasRead,
      writeScene: async () => {
        wrote = true;
        return { added: 0, removed: 0, changed: 0, hunks: 0 };
      },
      prepareParse: async () => {},
    };
    await runCanvasTool("get_geometry", { pageId: "p1", blockId: "b1" }, host);
    expect(wrote).toBe(false);
  });
});

describe("a verb lands inside the band", () => {
  /** F1 as the diagram, and every scene the executor writes. */
  function recording() {
    const scene = f1();
    const written: Scene[] = [];
    const host: CanvasHost = {
      readScene: async () => ({ pageId: "p1", blockId: "b1", scene }) satisfies CanvasRead,
      writeScene: async (_read, next): Promise<WriteReceipt> => {
        written.push(next);
        return { added: 0, removed: 0, changed: 1, hunks: 1 };
      },
      prepareParse: async () => {},
    };
    return { host, written };
  }
  const move = (ids: string[], dx: number) => ({ pageId: "p1", blockId: "b1", ids, dx });

  it("a move past the column shifts the whole drawing back in, and says so", async () => {
    const { host, written } = recording();
    // p1 is 40 wide at x=520: moved to 700, the drawing ends at 740.
    const reply = await runCanvasTool("move", move(["p1"], 180), host);
    expect(reply).toBe(
      "Done: moved 1 shape by (180, 0).\nThe whole drawing then moved by (-20, 0) to stay inside the diagram.",
    );
    expect(findNode(written[0], "p1")).toMatchObject({ x: 680, y: 40 });
    expect(findNode(written[0], "s1")).toMatchObject({ x: 20, y: 40 });
  });

  it("a move that leaves the drawing wider than the column scales it, and says both", async () => {
    const { host, written } = recording();
    // s1 at 1000 stretches the drawing to 40…1200: 1160 across, into 720.
    const reply = await runCanvasTool("move", move(["s1"], 960), host);
    expect(reply).toBe(
      [
        "Done: moved 1 shape by (960, 0).",
        "The diagram was scaled to 0.621× to fit its 720px width.",
        "The whole drawing then moved by (-40, 0) to stay inside the diagram.",
      ].join("\n"),
    );
    expect(fitOps(written[0])).toEqual([]);
  });

  it("a move that stays inside says nothing more", async () => {
    const { host } = recording();
    expect(await runCanvasTool("move", move(["s1"], 10), host)).toBe("Done: moved 1 shape by (10, 0).");
  });
});

/** A payload that clears each tool's own zod schema, addressed at "b1" so
 *  T7/T8 never fail on validation before reaching the host. */
function minimalInput(name: CanvasToolName): Record<string, unknown> {
  const base = { pageId: "p1", blockId: "b1" };
  switch (name) {
    case "get_geometry":
    case "get_styles":
    case "get_html":
      return base;
    case "write_nodes":
      return { ...base, html: "<nt-rect></nt-rect>" };
    case "update_styles":
      return { ...base, patches: [{ ids: ["s1"], style: { background: "#000" } }] };
    case "set_text":
      return { ...base, id: "s1", text: "x" };
    case "rename":
      return { ...base, id: "s1", name: "x" };
    case "duplicate":
      return { ...base, ids: ["s1"] };
    case "move":
      return { ...base, ids: ["s1"], dx: 1 };
    case "delete":
      return { ...base, ids: ["s1"] };
    case "reorder":
      return { ...base, ids: ["s1"], to: "front" };
    case "group":
      return { ...base, ids: ["s1", "s2"] };
    case "ungroup":
      return { ...base, ids: ["g1"] };
  }
}
