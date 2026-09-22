import { describe, expect, it } from "vitest";
import { DIGEST_LIMITS, digestFits } from "@/convex/context/shape";
import type { AnyBlock } from "../projection";
import { digestPage } from "./digest";

const text = (t: string) => [{ type: "text", text: t, styles: {} }];
const block = (id: string, type: string, content: unknown, props = {}): AnyBlock => ({
  id,
  type,
  props,
  content,
  children: [],
});

const page: AnyBlock[] = [
  block("h1", "heading", text("Watchdog"), { level: 2 }),
  block("p1", "paragraph", [
    ...text("Stops the rover within 300 ms — see "),
    { type: "pageMention", props: { pageId: "req15", title: "REQ-015" } },
    ...text("."),
  ]),
  {
    ...block("t1", "table", {
      type: "tableContent",
      rows: [{ cells: [{ type: "tableCell", content: text("Heartbeat") }] }],
    }),
    children: [
      block("p2", "paragraph", [
        { type: "pageMention", props: { pageId: "req15", title: "REQ-015" } },
        { type: "pageMention", props: { pageId: "icd", title: "ICD" } },
      ]),
    ],
  },
  block("c1", "codeBlock", undefined, { code: "#define HEARTBEAT_TIMEOUT_MS 300" }),
  block("d1", "canvas", undefined, {
    data: JSON.stringify({
      nodes: [{ id: "n1", position: { x: 0, y: 0 }, data: { label: "Motor controller" } }],
      edges: [],
    }),
  }),
];

describe("digestPage", () => {
  it("briefs a page by its first prose, not its heading", () => {
    expect(digestPage(page).brief).toBe("Stops the rover within 300 ms — see REQ-015.");
  });

  it("outlines the sections, then how the page opens", () => {
    expect(digestPage(page).summary).toMatch(/^Sections: Watchdog\nStops the rover/);
  });

  it("finds words wherever they are held: tables, code, diagram labels", () => {
    const { terms } = digestPage(page);
    for (const word of ["Heartbeat", "HEARTBEAT_TIMEOUT_MS", "Motor controller", "REQ-015"]) {
      expect(terms).toContain(word);
    }
  });

  it("collects mentions once each, in document order", () => {
    expect(digestPage(page).mentions).toEqual(["req15", "icd"]);
  });

  it("fingerprints what it digested, and nothing else", () => {
    expect(digestPage(page).contentHash).toBe(digestPage(structuredClone(page)).contentHash);
    const edited = structuredClone(page);
    edited[1] = block("p1", "paragraph", text("Stops the rover within 250 ms."));
    expect(digestPage(edited).contentHash).not.toBe(digestPage(page).contentHash);
  });

  it("stays inside what the graph stores, however long the page", () => {
    const long = Array.from({ length: 400 }, (_, i) =>
      block(`p${i}`, "paragraph", text("A long sentence about the rover's safety case. ".repeat(4))),
    );
    const digest = digestPage(long);
    expect(digestFits(digest)).toBe(true);
    expect(digest.brief.length).toBeLessThanOrEqual(DIGEST_LIMITS.brief);
  });

  it("digests an empty page to nothing", () => {
    expect(digestPage([])).toMatchObject({ brief: "", summary: "", terms: "", mentions: [] });
  });
});
