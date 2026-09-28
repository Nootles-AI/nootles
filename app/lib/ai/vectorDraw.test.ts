import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DRAW_CHOICE, type DrawChoice } from "./drawStyles";

vi.mock("./providers", () => ({
  imageTarget: () => ({ url: "https://example.invalid/recraft", key: "test-only", model: "recraftv3_vector" }),
  reportUpstream: vi.fn(),
}));

import { generateVectorDrawing, recraftRequest, retryDelayMs } from "./vectorDraw";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

const frame = { w: 320, h: 180 };
const svg = Buffer.from('<svg viewBox="0 0 100 100"><rect x="0" y="0" width="100" height="100"/></svg>').toString("base64");
const image = () => new Response(JSON.stringify({ data: [{ b64_json: svg }] }), { status: 200 });

describe("vector draw retries", () => {
  it("reads delta seconds and HTTP dates, capping a long Retry-After", () => {
    const now = Date.parse("2026-09-28T00:00:00Z");
    expect(retryDelayMs("3", 2_000, now)).toBe(3_000);
    expect(retryDelayMs("Mon, 28 Sep 2026 00:00:08 GMT", 2_000, now)).toBe(8_000);
    expect(retryDelayMs("120", 2_000, now)).toBe(20_000);
    expect(retryDelayMs("bad", 2_000, now)).toBe(2_000);
  });

  it("waits for the provider's Retry-After, then imports the drawing", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls.push(Date.now());
      return calls.length === 1
        ? new Response("busy", { status: 429, headers: { "Retry-After": "3" } })
        : image();
    }));
    const drawn = generateVectorDrawing("a lighthouse", frame);
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await drawn;
    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBe(3_000);
    expect(result.html).toContain("<nt-diagram");
  });

  it("does not make another paid attempt when Retry-After exceeds the remaining request time", async () => {
    const fetch = vi.fn(async () => new Response("busy", { status: 429, headers: { "Retry-After": "120" } }));
    vi.stubGlobal("fetch", fetch);
    const result = await generateVectorDrawing("a lighthouse", frame, DEFAULT_DRAW_CHOICE, undefined, Date.now() + 5_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ html: null, status: "error", errorCode: "upstream-429" });
  });

  it("stops fixed-backoff retries at the route budget instead of sleeping through it", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const drawn = generateVectorDrawing("a lighthouse", frame, DEFAULT_DRAW_CHOICE, undefined, Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await drawn).toMatchObject({ html: null, errorCode: "upstream-503" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds a hung provider call by the remaining request time", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })));
    const result = await generateVectorDrawing("a lighthouse", frame, DEFAULT_DRAW_CHOICE, undefined, Date.now() + 1_100);
    expect(result).toMatchObject({ html: null, status: "timeout" });
  });

  it("reports a successful response with unusable SVG as a cacheable failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("not an svg").toString("base64") }],
    }), { status: 200 })));
    expect(await generateVectorDrawing("a lighthouse", frame)).toMatchObject({
      html: null, status: "error", errorCode: "invalid-svg", cacheFailure: true,
    });
  });

  it("does not repeat a request after a successful but unreadable response", async () => {
    const fetch = vi.fn(async () => new Response("broken JSON", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await generateVectorDrawing("a lighthouse", frame)).toMatchObject({
      html: null, errorCode: "invalid-response",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
