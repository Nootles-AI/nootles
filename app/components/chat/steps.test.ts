import { describe, expect, test } from "vitest";
import { groupLine, planTurn, stepLine, summaryLine, type Part, type ToolPart } from "./steps";

const call = (tool: string, input: unknown, output?: unknown, state = "output-available"): Part =>
  ({ type: `tool-${tool}`, toolCallId: `${tool}-${Math.random()}`, state, input, output }) as unknown as Part;
const text = (t: string): Part => ({ type: "text", text: t }) as Part;
const thought = (t: string): Part => ({ type: "reasoning", text: t }) as unknown as Part;
const step: Part = { type: "step-start" } as Part;

describe("planTurn", () => {
  test("the work above, the answer below; narration before a call joins the notes", () => {
    const { trace, answer } = planTurn([
      step,
      thought("Map the schema first."),
      call("search_context", { query: "schema" }, []),
      call("search_context", { query: "sync" }, []),
      call("search_context", { query: "auth" }, []),
      step,
      text("Found it — reading the schema now."),
      call("read_context", { id: "a" }, { title: "convex/schema.ts" }),
      step,
      thought(""),
      text("The overview is on the page."),
    ]);
    expect(trace.map((i) => (i.kind === "note" ? `note:${i.text}` : `${i.tool}×${i.parts.length}`))).toEqual([
      "note:Map the schema first.",
      "search_context×3",
      "note:Found it — reading the schema now.",
      "read_context×1",
    ]);
    expect(answer.map((a) => a.text)).toEqual(["The overview is on the page."]);
  });

  test("the same tool in two steps is two acts; a draw salvo spans its retries", () => {
    const { trace } = planTurn([
      step,
      call("search_context", { query: "a" }, []),
      step,
      call("search_context", { query: "b" }, []),
      step,
      call("draw", { brief: "x", ratio: "16:9" }, { ref: "d1" }),
      step,
      call("draw", { brief: "y", ratio: "16:9" }, { ref: "d2" }),
    ]);
    expect(trace.map((i) => (i.kind === "step" ? `${i.tool}×${i.parts.length}` : "note"))).toEqual([
      "search_context×1",
      "search_context×1",
      "draw×2",
    ]);
  });

  test("a call waiting on the user is not shown as work", () => {
    const { trace } = planTurn([call("delete_page", { pageId: "p" }, undefined, "approval-requested")]);
    expect(trace).toEqual([]);
  });
});

describe("the lines", () => {
  test("placing writer sections says so", () => {
    const place = call("edit_page", { html: '<nt-section ref="w1"></nt-section><nt-section ref="w2"></nt-section>' }, "Done: 12 blocks added.\n<title>Overview</title>");
    expect(stepLine(place as ToolPart)).toBe("Placed 2 sections");
    const placing = call("edit_page", { html: '<nt-section ref="w1"></nt-section>' }, undefined, "input-available");
    expect(stepLine(placing as ToolPart)).toBe("Placing 1 section…");
  });

  test("following the graph counts where it led", () => {
    const follow = call("expand_context", { id: "n" }, { title: "Backend services", links: [1, 2, 3] });
    expect(stepLine(follow as ToolPart)).toBe("Followed Backend services · 3 links");
  });

  test("a canvas tool has a name, never its identifier", () => {
    expect(stepLine(call("get_geometry", {}, "…") as ToolPart)).toBe("Measured the diagram");
  });

  test("a batch reads as one act, with its progress while it runs", () => {
    const parts = [
      call("write", { brief: "a" }, { headings: ["A"] }),
      call("write", { brief: "b" }, undefined, "input-available"),
      call("write", { brief: "c" }, undefined, "input-available"),
    ] as ToolPart[];
    expect(groupLine("write", parts)).toBe("Drafting 3 sections — 1 done…");
    expect(groupLine("search_context", [call("search_context", {}, []), call("search_context", {}, [])] as ToolPart[])).toBe(
      "Searched the project · 2",
    );
  });
});

describe("summaryLine", () => {
  test("how much work, and the two things most worth knowing", () => {
    const { trace } = planTurn([
      step,
      call("search_context", { query: "a" }, []),
      call("search_context", { query: "b" }, []),
      step,
      call("read_context", { id: "a" }, { title: "a" }),
      step,
      call("write", { brief: "a" }, { headings: ["A"] }),
      call("write", { brief: "b" }, { headings: ["B"] }),
      step,
      call("edit_page", { html: '<nt-section ref="w1"></nt-section><nt-section ref="w2"></nt-section>' }, "Done: 4 blocks added."),
    ]);
    expect(summaryLine(trace)).toBe("6 steps · drafted 2 sections · placed 2 sections");
  });
});
