import { describe, expect, it } from "vitest";
import { joinUpdateRows, splitUpdate, UPDATE_CHUNK_BYTES } from "./yshape";

/** Deterministic bytes — the content only has to survive the round trip. */
function bytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + 7) % 256;
  return out;
}

describe("splitUpdate / joinUpdateRows", () => {
  it("leaves a small update whole", () => {
    const update = bytes(1_000);
    const chunks = splitUpdate(update);
    expect(chunks).toHaveLength(1);
    expect(new Uint8Array(chunks[0])).toEqual(update);
  });

  it("splits an oversized update and joins it back byte for byte", () => {
    const update = bytes(Math.floor(UPDATE_CHUNK_BYTES * 2.5));
    const chunks = splitUpdate(update);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.byteLength <= UPDATE_CHUNK_BYTES)).toBe(true);

    const rows = chunks.map((c, part) => ({
      seq: 7,
      update: c,
      part,
      parts: chunks.length,
    }));
    const joined = joinUpdateRows(rows);
    expect(joined).toHaveLength(1);
    expect(joined[0].seq).toBe(7);
    expect(joined[0].update).toEqual(update);
  });

  it("joins groups in among whole rows", () => {
    const big = bytes(UPDATE_CHUNK_BYTES + 10);
    const chunks = splitUpdate(big);
    const rows = [
      { seq: 1, update: bytes(8).buffer as ArrayBuffer },
      ...chunks.map((c, part) => ({ seq: 2, update: c, part, parts: chunks.length })),
      { seq: 3, update: bytes(4).buffer as ArrayBuffer },
    ];
    const joined = joinUpdateRows(rows);
    expect(joined.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(joined[1].update).toEqual(big);
  });

  it("drops a torn group rather than joining half an update", () => {
    const chunks = splitUpdate(bytes(UPDATE_CHUNK_BYTES * 2 + 1));
    const rows = [
      // Middle part missing — must never surface as an update.
      { seq: 5, update: chunks[0], part: 0, parts: chunks.length },
      { seq: 5, update: chunks[2], part: 2, parts: chunks.length },
      { seq: 6, update: bytes(4).buffer as ArrayBuffer },
    ];
    const joined = joinUpdateRows(rows);
    expect(joined.map((r) => r.seq)).toEqual([6]);
  });
});
