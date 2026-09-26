import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLUMN_VARS, COLUMN_WIDTH } from "./column";
import {
  effectiveScale,
  NARROW_BREAKPOINT,
  PAGE_BREAKPOINT,
  pageFit,
} from "./columnScale";

describe("pageFit", () => {
  it("puts the breakpoints where the gutters say", () => {
    expect(PAGE_BREAKPOINT).toBe(832);
    expect(NARROW_BREAKPOINT).toBe(640);
  });

  it("is wide from 832: full measure, wide gutter", () => {
    expect(pageFit(832)).toEqual({ mode: "wide", fit: 1, wideFit: 784 / 1200 });
    expect(pageFit(1247)).toEqual({ mode: "wide", fit: 1, wideFit: 1199 / 1200 });
    expect(pageFit(1248)).toEqual({ mode: "wide", fit: 1, wideFit: 1 });
    expect(pageFit(2000).wideFit).toBe(1);
  });

  it("flows from 640 to 831: the wide gutter holds and the text gives up width", () => {
    expect(pageFit(831)).toEqual({ mode: "flow", fit: 719 / COLUMN_WIDTH, wideFit: 783 / 1200 });
    expect(pageFit(768)).toEqual({ mode: "flow", fit: 656 / COLUMN_WIDTH, wideFit: 720 / 1200 });
    expect(pageFit(767)).toEqual({ mode: "flow", fit: 655 / COLUMN_WIDTH, wideFit: 719 / 1200 });
    expect(pageFit(640)).toEqual({ mode: "flow", fit: 528 / COLUMN_WIDTH, wideFit: 592 / 1200 });
  });

  it("is narrow below 640: the narrow gutter, and the text is the rest", () => {
    expect(pageFit(639)).toEqual({ mode: "narrow", fit: 591 / COLUMN_WIDTH, wideFit: 591 / 1200 });
    expect(pageFit(400).fit).toBeCloseTo(352 / 720, 12);
  });

  it("never scales to nothing", () => {
    const { fit, wideFit } = pageFit(0);
    expect(fit).toBeGreaterThan(0);
    expect(wideFit).toBeGreaterThan(0);
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
