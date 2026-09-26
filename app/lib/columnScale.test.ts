import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLUMN_VARS, COLUMN_WIDTH } from "./column";
import {
  effectiveScale,
  NARROW_BREAKPOINT,
  PAGE_BREAKPOINT,
  pageFit,
  wideSpan,
} from "./columnScale";
import { WIDE_MARGIN, WIDE_W } from "@/app/components/editor/canvas/scene/bandSpan";

describe("pageFit", () => {
  it("puts the breakpoints where the gutters say", () => {
    expect(PAGE_BREAKPOINT).toBe(832);
    expect(NARROW_BREAKPOINT).toBe(640);
  });

  it("is wide from 832: full measure, wide gutter", () => {
    expect(pageFit(832)).toEqual({ mode: "wide", fit: 1, room: 784 });
    expect(pageFit(1247)).toEqual({ mode: "wide", fit: 1, room: 1199 });
    expect(pageFit(2000)).toEqual({ mode: "wide", fit: 1, room: 1952 });
  });

  it("flows from 640 to 831: the wide gutter holds and the text gives up width", () => {
    expect(pageFit(831)).toEqual({ mode: "flow", fit: 719 / COLUMN_WIDTH, room: 783 });
    expect(pageFit(768)).toEqual({ mode: "flow", fit: 656 / COLUMN_WIDTH, room: 720 });
    expect(pageFit(640)).toEqual({ mode: "flow", fit: 528 / COLUMN_WIDTH, room: 592 });
  });

  it("is narrow below 640: the narrow gutter, and the text is the rest", () => {
    expect(pageFit(639)).toEqual({ mode: "narrow", fit: 591 / COLUMN_WIDTH, room: 591 });
    expect(pageFit(400).fit).toBeCloseTo(352 / 720, 12);
  });

  it("never scales to nothing", () => {
    const { fit, room } = pageFit(0);
    expect(fit).toBeGreaterThan(0);
    expect(room).toBeGreaterThan(0);
  });
});

describe("wideSpan", () => {
  /** A wide band on a pane `pane` px wide: its span in page px, and where the text's edge falls in it. */
  const onPane = (pane: number) => {
    const { fit, room } = pageFit(pane);
    const { width, margin } = wideSpan(fit, room);
    return { fit, page: width * fit, textEdge: margin * fit, width, margin };
  };

  it("shows all of a wide band where the pane has room", () => {
    expect(wideSpan(1, 1200)).toEqual({ width: WIDE_W, margin: WIDE_MARGIN });
    expect(wideSpan(1, 1952)).toEqual({ width: WIDE_W, margin: WIDE_MARGIN });
    expect(onPane(1248)).toMatchObject({ width: 1200, margin: 240 });
  });

  it("is drawn at the text's scale whatever the pane, and shows what fits of its margins", () => {
    // Where the old scale-to-fit drew a wide band at 952/1200 of a column one.
    const at1000 = onPane(1000);
    expect(at1000.fit).toBe(1);
    expect([at1000.width, at1000.margin]).toEqual([952, 116]);
    expect(onPane(832)).toMatchObject({ fit: 1, width: 784, margin: 32 });
  });

  it("keeps the text's edge where the column's is, centred in the room", () => {
    for (const pane of [400, 639, 700, 831, 832, 1000, 1247, 1600]) {
      const { fit, page, textEdge } = onPane(pane);
      const room = Math.max(1, pane - 48);
      expect(page).toBeLessThanOrEqual(Math.max(room, COLUMN_WIDTH * fit) + 1e-9);
      // The column sits in the middle of the band, so the text's edge is as far in as the band's other side is out.
      expect(textEdge * 2 + COLUMN_WIDTH * fit).toBeCloseTo(page, 9);
    }
  });

  it("scales with the text in a flowing pane, and never shows less than the column", () => {
    const flow = onPane(700);
    expect(flow.fit).toBeCloseTo(588 / 720, 12);
    expect(flow.page).toBeCloseTo(652, 9);
    expect(flow.textEdge).toBeCloseTo(32, 9);
    expect(onPane(500)).toMatchObject({ width: COLUMN_WIDTH, margin: 0 });
  });
});

describe("effectiveScale", () => {
  class FakeElement {
    constructor(
      public offsetWidth: number,
      public rectWidth: number,
      public svgHost: FakeElement | null = null,
    ) {}
    getBoundingClientRect() {
      return { width: this.rectWidth };
    }
    closest() {
      return this.svgHost ? { parentElement: this.svgHost } : null;
    }
  }
  class FakeHTMLElement extends FakeElement {}

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const scale = (el: FakeElement) => effectiveScale(el as unknown as Element);

  it("is client width over own width", () => {
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    expect(scale(new FakeHTMLElement(720, 1440))).toBe(2);
    expect(scale(new FakeHTMLElement(720, 720))).toBe(1);
  });

  it("is 1 for an element with no box — detached, or display:none", () => {
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    expect(scale(new FakeHTMLElement(0, 0))).toBe(1);
  });

  it("is 1 when the rect is junk", () => {
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    expect(scale(new FakeHTMLElement(720, NaN))).toBe(1);
    expect(scale(new FakeHTMLElement(720, -5))).toBe(1);
  });

  it("measures an SVG element by the HTML box around its svg", () => {
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    const host = new FakeHTMLElement(600, 900);
    expect(scale(new FakeElement(0, 0, host))).toBe(1.5);
  });

  it("is 1 for an SVG element outside any HTML box", () => {
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    expect(scale(new FakeElement(0, 0))).toBe(1);
  });
});

describe("the stylesheet's fallback body type", () => {
  it("is COLUMN_VARS's, for a root that does not set them", () => {
    const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
    for (const name of ["--text-body", "--leading-body"]) {
      expect(css.match(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`))?.[1]).toBe(COLUMN_VARS[name]);
    }
  });
});
