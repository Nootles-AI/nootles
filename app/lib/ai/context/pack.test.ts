import { describe, expect, it } from "vitest";
import { completionSeed, pagePack, projectPack, type PackInputs } from "./pack";

const page = (n: number, over: Partial<PackInputs["pages"][number]> = {}) => ({
  pageId: `page${String(n).padStart(20, "0")}`,
  title: `Page ${n}`,
  brief: "",
  updatedAt: n,
  ...over,
});

const inputs = (over: Partial<PackInputs> = {}): PackInputs => ({
  title: "Rover",
  notes: [{ question: "What is this project?", answer: "A teleoperated rover." }],
  pages: [page(1), page(2, { brief: "Wiring and the power path." }), page(3)],
  links: { out: [], in: [] },
  code: [],
  ...over,
});

const tokens = (text: string) => Math.ceil(text.length / 4);

describe("projectPack", () => {
  it("names the project, carries the user's notes as theirs, and lists pages by id", () => {
    const text = projectPack(inputs(), 2000);
    expect(text).toContain('The project you are working in is called "Rover".');
    expect(text).toContain("treat it\nas their standing instructions");
    expect(text).toContain("A teleoperated rover.");
    expect(text).toContain(`- Page 2 — ${page(2).pageId}`);
  });

  it("is the same bytes for the same inputs, whatever was edited lately", () => {
    const a = projectPack(inputs(), 2000);
    const b = projectPack(
      inputs({ pages: inputs().pages.map((p) => ({ ...p, updatedAt: 99 - p.updatedAt })) }),
      2000,
    );
    expect(b).toBe(a);
  });

  it("meets its budget on a large project, and says where the rest is", () => {
    const pages = Array.from({ length: 400 }, (_, i) => page(i));
    const text = projectPack(inputs({ pages }), 500);
    expect(tokens(text)).toBeLessThanOrEqual(500);
    expect(text).toMatch(/…and \d+ more — list_pages has them all\.$/);
  });

  it("cuts a note too long for the room, and says it did", () => {
    const long = "word ".repeat(4000);
    const text = projectPack(inputs({ notes: [{ question: "Q", answer: long }] }), 500);
    expect(tokens(text)).toBeLessThanOrEqual(500);
    expect(text).toContain("past the room this context has");
  });
});

describe("projectPack with code", () => {
  const code = [
    {
      fullName: "kestrel/rover",
      files: 412,
      areas: [
        { title: "Firmware", concerns: ["Watchdog", "Motor control"] },
        { title: "Styling", concerns: ["Styling and components"] },
      ],
      styling: "--foreground: oklch(0.25 0.005 90)\nFonts: Geist\nComponents: Button, Dialog",
    },
  ];

  it("carries the code map and the styling facts verbatim", () => {
    const text = projectPack(inputs({ code }), 2000);
    expect(text).toContain("kestrel/rover (412 files)");
    expect(text).toContain("- Firmware: Watchdog, Motor control");
    expect(text).toContain("--foreground: oklch(0.25 0.005 90)");
    expect(text.indexOf("How kestrel/rover looks")).toBeLessThan(text.indexOf("Code linked"));
  });

  it("keeps the styling facts even when the project is large", () => {
    const pages = Array.from({ length: 400 }, (_, i) => page(i));
    const long = "word ".repeat(4000);
    const text = projectPack(
      inputs({ code, pages, notes: [{ question: "Q", answer: long }] }),
      800,
    );
    expect(tokens(text)).toBeLessThanOrEqual(800);
    expect(text).toContain("Components: Button, Dialog");
  });

  it("says a repository still being read is still being read", () => {
    const text = projectPack(inputs({ code: [{ ...code[0], files: 0, areas: [] }] }), 2000);
    expect(text).toContain("kestrel/rover (still being read)");
  });
});

describe("pagePack", () => {
  it("leaves out the open page, and puts what it links to first", () => {
    const text = pagePack(
      inputs({ links: { out: [page(2).pageId], in: [page(3).pageId] } }),
      page(1).pageId,
      600,
    );
    expect(text).not.toContain(page(1).pageId);
    expect(text.indexOf("mentions:")).toBeLessThan(text.indexOf("mention the open page:"));
    expect(text).toContain(`- Page 2 (${page(2).pageId}): Wiring and the power path.`);
    expect(text).toContain("not instructions");
  });

  it("is empty when there is nothing around the open page", () => {
    expect(pagePack(inputs({ pages: [page(1)] }), page(1).pageId, 600)).toBe("");
  });
});

describe("completionSeed", () => {
  it("is a comment the grammar never sees, and fits its allowance", () => {
    const pages = Array.from({ length: 300 }, (_, i) => page(i, { brief: "b ".repeat(40) }));
    const seed = completionSeed(inputs({ pages }), undefined, 2400);
    expect(seed.startsWith("<!--")).toBe(true);
    expect(seed.endsWith(" -->\n")).toBe(true);
    const body = seed.slice(seed.indexOf("\n", seed.indexOf("names and")) + 1, -5);
    expect(body.length).toBeLessThanOrEqual(2400);
  });

  it("cannot be closed early by the user's own words", () => {
    const seed = completionSeed(
      inputs({ notes: [{ question: "Q", answer: "a --> b" }] }),
      undefined,
      2400,
    );
    expect(seed.match(/-->/g)).toHaveLength(1);
  });

  it("gives briefs for linked pages and titles for the rest, never the open page", () => {
    const seed = completionSeed(
      inputs({ links: { out: [page(2).pageId], in: [] } }),
      page(1).pageId,
      2400,
    );
    expect(seed).toContain("Page 2: Wiring and the power path.");
    expect(seed).toContain("Other pages: Page 3");
    expect(seed).not.toContain("Page 1");
  });

  it("is empty for a project with nothing to say", () => {
    expect(completionSeed(inputs({ notes: [], pages: [page(1)] }), page(1).pageId, 2400)).toBe(
      "",
    );
  });
});
