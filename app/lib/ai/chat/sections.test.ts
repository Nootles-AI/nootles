import { describe, expect, test, vi } from "vitest";
import { redeemSections } from "./clientTools";

const ctx = (pen: Record<string, string>) => {
  const query = vi.fn(async (_fn: unknown, args: { refs: string[] }) =>
    Object.fromEntries(args.refs.flatMap((r) => (r in pen ? [[r, pen[r]]] : []))),
  );
  return { ctx: { convex: { query } } as never, query };
};

describe("redeemSections", () => {
  test("each placed section becomes the blocks the writer drafted, in place", async () => {
    const { ctx: c } = ctx({ w1: "<h2>One</h2>\n<p>a</p>", w2: "<p>$1 costs $$</p>" });
    const out = await redeemSections(
      c,
      '<p id="x">keep</p>\n<nt-section ref="w1"></nt-section>\n<nt-section ref="w2"></nt-section>',
    );
    expect(out).toEqual({ html: '<p id="x">keep</p>\n<h2>One</h2>\n<p>a</p>\n<p>$1 costs $$</p>' });
  });

  test("the writer's flags stay off the page", async () => {
    const { ctx: c } = ctx({ w1: "<p>a</p>\n<!-- unsourced:\n- a claim\n-->" });
    expect(await redeemSections(c, '<nt-section ref="w1"></nt-section>')).toEqual({ html: "<p>a</p>" });
  });

  test("a name with nothing behind it is reported, and nothing is placed", async () => {
    const { ctx: c } = ctx({ w1: "<p>a</p>" });
    expect(await redeemSections(c, '<nt-section ref="w1"></nt-section><nt-section ref="w9"></nt-section>')).toEqual({
      missing: ["w9"],
    });
  });

  test("an edit without sections never asks", async () => {
    const { ctx: c, query } = ctx({});
    expect(await redeemSections(c, "<p>plain</p>")).toEqual({ html: "<p>plain</p>" });
    expect(query).not.toHaveBeenCalled();
  });
});
