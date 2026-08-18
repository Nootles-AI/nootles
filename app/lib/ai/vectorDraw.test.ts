import { describe, expect, it } from "vitest";
import { DEFAULT_DRAW_CHOICE } from "./drawStyles";
import { recraftRequest } from "./vectorDraw";

type Controls = {
  artistic_level: number;
  colors?: { rgb: number[] }[];
  background_color?: { rgb: number[] };
};

type Req = {
  model: string;
  prompt: string;
  aspect_ratio: string;
  provider: { options: { recraft: { style: string; controls: Controls } } };
};

const request = (
  frame: { w: number; h: number },
  choice = DEFAULT_DRAW_CHOICE,
): Req => recraftRequest("a lighthouse at dusk", frame, choice) as Req;

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
});
