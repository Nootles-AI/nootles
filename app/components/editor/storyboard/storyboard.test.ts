import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { parseStoryboard } from "./parse";
import { serializeStoryboard } from "./serialize";
import { emptyStoryboard, shotHeight, SHOT_W, type Storyboard } from "./types";

const dom = (html: string) => parseHTML(html).document as unknown as Document;
const parse = (html: string) => parseStoryboard(html, dom);

/** A board with a drawing in the first shot, in the canonical spelling. */
const DRAWN = `<nt-storyboard ratio="16:9">
  <nt-shot>
    <nt-diagram w="320" h="180">
      <nt-path id="hill" x="0" y="120" w="320" h="60" d="M 0 60 L 0 24 C 80 -8 240 -8 320 24 L 320 60 Z" style="fill: #dfe7d8"></nt-path>
      <nt-ellipse id="sun" x="240" y="28" w="40" h="40" style="background: #f0d9a8"></nt-ellipse>
    </nt-diagram>
    <nt-note>Dawn over the ridge.
She wakes before the alarm.</nt-note>
  </nt-shot>
  <nt-shot>
    <nt-note>The empty highway.</nt-note>
  </nt-shot>
</nt-storyboard>`;

describe("storyboard format", () => {
  it("round-trips byte for byte", () => {
    expect(serializeStoryboard(parse(DRAWN))).toBe(DRAWN);
  });

  it("round-trips an empty board at every ratio", () => {
    for (const ratio of ["16:9", "2.39:1", "1.85:1", "4:3", "1:1", "9:16"] as const) {
      const html = serializeStoryboard(emptyStoryboard(3, ratio));
      expect(serializeStoryboard(parse(html))).toBe(html);
      expect(parse(html).ratio).toBe(ratio);
    }
  });

  it("survives a scene round-trip through the board", () => {
    const once = parse(DRAWN);
    const twice = parse(serializeStoryboard(once));
    expect(twice).toEqual(once);
  });

  it("reads shots in order, with their notes", () => {
    const board = parse(DRAWN);
    expect(board.shots).toHaveLength(2);
    expect(board.shots[0].note).toBe(
      "Dawn over the ridge.\nShe wakes before the alarm.",
    );
    expect(board.shots[1].note).toBe("The empty highway.");
    expect(board.shots[1].scene).toBe("");
  });

  it("sizes every shot's canvas to the board's ratio", () => {
    // A model asked for a 2.39 board will happily write 16:9 boxes; the board
    // settles the frame, so the shot's own w/h is imposed rather than read.
    const wrong = `<nt-storyboard ratio="2.39:1">
  <nt-shot>
    <nt-diagram w="999" h="111">
      <nt-rect id="a" x="0" y="0" w="10" h="10" style="background: #eee"></nt-rect>
    </nt-diagram>
    <nt-note></nt-note>
  </nt-shot>
</nt-storyboard>`;
    const board = parse(wrong);
    expect(board.shots[0].scene).toContain(`w="${SHOT_W}"`);
    expect(board.shots[0].scene).toContain(`h="${shotHeight("2.39:1")}"`);
  });

  it("keeps a drawing's coordinates when the ratio changes", () => {
    // Re-crop, not squash: the frame changes and the drawing does not move.
    const board = parse(DRAWN);
    const narrowed: Storyboard = { ...board, ratio: "2.39:1" };
    const reread = parse(serializeStoryboard(narrowed));
    expect(reread.shots[0].scene).toContain('x="0" y="120"');
    expect(reread.shots[0].scene).toContain(`h="${shotHeight("2.39:1")}"`);
  });

  it("accepts the tags a model might reach for instead", () => {
    const loose = `<storyboard ratio="4:3">
      <shot><caption>Wide on the valley.</caption></shot>
      <panel><note>Push in.</note></panel>
    </storyboard>`;
    const board = parse(loose);
    expect(board.ratio).toBe("4:3");
    expect(board.shots.map((s) => s.note)).toEqual([
      "Wide on the valley.",
      "Push in.",
    ]);
  });

  it("reads <br> in a note as a line break", () => {
    const board = parse(
      `<nt-storyboard ratio="16:9"><nt-shot><nt-note>one<br>two</nt-note></nt-shot></nt-storyboard>`,
    );
    expect(board.shots[0].note).toBe("one\ntwo");
  });

  it("escapes note text that would otherwise be markup", () => {
    const board: Storyboard = {
      ratio: "16:9",
      shots: [{ scene: "", note: "a < b & <b>not bold</b>" }],
    };
    const html = serializeStoryboard(board);
    expect(parse(html).shots[0].note).toBe("a < b & <b>not bold</b>");
  });

  it("a portrait frame is taller than it is wide", () => {
    expect(shotHeight("9:16")).toBe(Math.round((SHOT_W * 16) / 9));
  });

  it("carries the display width, and only when set", () => {
    const sized: Storyboard = { ratio: "16:9", shots: [{ scene: "", note: "" }], w: 840 };
    const html = serializeStoryboard(sized);
    expect(html).toContain('w="840"');
    expect(parse(html).w).toBe(840);
    expect(serializeStoryboard(parse(html))).toBe(html);
    // Absent stays absent — a board nobody widened must not acquire a width.
    const plain = serializeStoryboard(emptyStoryboard());
    expect(plain).not.toContain(' w="');
    expect(parse(plain).w).toBeUndefined();
  });

  it("carries the column pin, and only when set", () => {
    const pinned: Storyboard = {
      ratio: "16:9",
      shots: [{ scene: "", note: "" }],
      w: 840,
      cols: 2,
    };
    const html = serializeStoryboard(pinned);
    expect(html).toContain('w="840" cols="2"');
    expect(parse(html).cols).toBe(2);
    expect(serializeStoryboard(parse(html))).toBe(html);
    const plain = serializeStoryboard(emptyStoryboard());
    expect(plain).not.toContain("cols=");
    expect(parse(plain).cols).toBeUndefined();
  });

  it("an empty board is still a board", () => {
    const html = serializeStoryboard({ ratio: "16:9", shots: [] });
    expect(parse(html).shots).toHaveLength(0);
    expect(serializeStoryboard(parse(html))).toBe(html);
  });
});
