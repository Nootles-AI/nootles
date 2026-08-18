import { describe, expect, it } from "vitest";
import { DEFAULT_DRAW_CHOICE, type DrawChoice } from "./drawStyles";
import { recraftRequest } from "./vectorDraw";

type Controls = {
  artistic_level: number;
  colors?: { rgb: number[] }[];
  background_color?: { rgb: number[] };
};

/** Through the aggregator: style and dial ride the provider passthrough. */
type Routed = {
  model: string;
  prompt: string;
  aspect_ratio: string;
  provider: { options: { recraft: { style: string; controls: Controls } } };
};

/** Straight to Recraft: the same four things, written at the top level. */
type Direct = {
  model: string;
  prompt: string;
  size: string;
  style: string;
  controls: Controls;
  response_format: string;
};

const request = (
  frame: { w: number; h: number },
  choice: DrawChoice = DEFAULT_DRAW_CHOICE,
): Routed =>
  recraftRequest("a lighthouse at dusk", frame, choice, {
    model: "recraft/recraft-v3",
    direct: false,
  }) as Routed;

const directRequest = (
  frame: { w: number; h: number },
  choice: DrawChoice = DEFAULT_DRAW_CHOICE,
): Direct =>
  recraftRequest("a lighthouse at dusk", frame, choice, {
    model: "recraftv3_vector",
    direct: true,
  }) as Direct;

describe("recraftRequest", () => {
  it("picks the nearest ratio the endpoint accepts", () => {
    expect(request({ w: 320, h: 180 }).aspect_ratio).toBe("16:9");
    expect(request({ w: 600, h: 450 }).aspect_ratio).toBe("4:3");
    expect(request({ w: 320, h: 480 }).aspect_ratio).toBe("3:4");
    expect(request({ w: 500, h: 500 }).aspect_ratio).toBe("1:1");
    expect(request({ w: 200, h: 900 }).aspect_ratio).toBe("9:16");
  });

  it("rides style and dial on the provider passthrough", () => {
    const req = request({ w: 320, h: 180 }, { style: "Cutout", artisticLevel: 4 });
    expect(req.provider.options.recraft).toEqual({
      style: "Cutout",
      controls: { artistic_level: 4 },
    });
  });

  it("states black on white for the ink styles, and nothing for the rest", () => {
    const ink = request({ w: 320, h: 180 }, { style: "Line art", artisticLevel: 1 })
      .provider.options.recraft.controls;
    expect(ink.colors).toEqual([{ rgb: [0, 0, 0] }]);
    expect(ink.background_color).toEqual({ rgb: [255, 255, 255] });

    // A colour style must keep its colours: no palette is imposed on it.
    const colour = request({ w: 320, h: 180 }, { style: "Vivid shapes", artisticLevel: 1 })
      .provider.options.recraft.controls;
    expect(colour.colors).toBeUndefined();
    expect(colour.background_color).toBeUndefined();
  });

  it("keeps the economy suffix only on the unstyled default", () => {
    expect(request({ w: 320, h: 180 }).prompt).toMatch(/no fine detail/);
    expect(
      request({ w: 320, h: 180 }, { style: "Line art", artisticLevel: 2 }).prompt,
    ).toBe("a lighthouse at dusk");
  });

  describe("called directly", () => {
    it("spells the same ratio as a pixel size, and asks for base64", () => {
      expect(directRequest({ w: 320, h: 180 }).size).toBe("1820x1024");
      expect(directRequest({ w: 600, h: 450 }).size).toBe("1365x1024");
      expect(directRequest({ w: 500, h: 500 }).size).toBe("1024x1024");
      expect(directRequest({ w: 200, h: 900 }).size).toBe("1024x1820");
      // The default is a URL, which this lane cannot read.
      expect(directRequest({ w: 500, h: 500 }).response_format).toBe("b64_json");
    });

    it("lifts style and controls out of the passthrough", () => {
      const req = directRequest({ w: 320, h: 180 }, { style: "Cutout", artisticLevel: 4 });
      expect(req.style).toBe("Cutout");
      expect(req.controls).toEqual({ artistic_level: 4 });
      expect(req).not.toHaveProperty("provider");
      expect(req).not.toHaveProperty("aspect_ratio");
    });

    it("asks for the same drawing either way", () => {
      const choice: DrawChoice = { style: "Line art", artisticLevel: 3 };
      const routed = request({ w: 320, h: 180 }, choice);
      const straight = directRequest({ w: 320, h: 180 }, choice);
      expect(straight.prompt).toBe(routed.prompt);
      expect(straight.style).toBe(routed.provider.options.recraft.style);
      expect(straight.controls).toEqual(routed.provider.options.recraft.controls);
    });

    it("names the model the way each endpoint does", () => {
      expect(request({ w: 500, h: 500 }).model).toBe("recraft/recraft-v3");
      // The `_vector` suffix is what returns SVG; the bare id is the raster
      // model, whose bytes this lane cannot read.
      expect(directRequest({ w: 500, h: 500 }).model).toBe("recraftv3_vector");
    });
  });
});
