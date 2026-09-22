import { gzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { untar } from "./tar";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function field(block: Uint8Array, at: number, text: string) {
  block.set(encoder.encode(text), at);
}

function header(name: string, size: number, type: string, prefix = ""): Uint8Array {
  const h = new Uint8Array(512);
  field(h, 0, name);
  field(h, 100, "0000644\0");
  field(h, 108, "0000000\0");
  field(h, 116, "0000000\0");
  field(h, 124, `${size.toString(8).padStart(11, "0")}\0`);
  field(h, 136, "00000000000\0");
  field(h, 148, "        ");
  field(h, 156, type);
  field(h, 257, "ustar\0");
  field(h, 263, "00");
  field(h, 345, prefix);
  const sum = h.reduce((s, b) => s + b, 0);
  field(h, 148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

function entry(name: string, body: string | Uint8Array, type = "0", prefix = ""): Uint8Array[] {
  const data = typeof body === "string" ? encoder.encode(body) : body;
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [header(name, data.length, type, prefix), padded];
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length++;
  return `${length}${body}`;
}

function tarball(parts: Uint8Array[][]): Uint8Array {
  const blocks = [...parts.flat(), new Uint8Array(1024)];
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    tar.set(b, at);
    at += b.length;
  }
  return gzipSync(tar);
}

const ROOT = "acme-app-1a2b3c4";

describe("untar", () => {
  test("strips GitHub's top-level directory and keeps only regular files", () => {
    const long = `${ROOT}/${"deep/".repeat(30)}file.ts`;
    const gnuLong = `${ROOT}/${"gnu/".repeat(30)}named.ts`;
    const gz = tarball([
      entry("pax_global_header", paxRecord("comment", "1a2b3c4"), "g"),
      entry(`${ROOT}/`, "", "5"),
      entry(`${ROOT}/src/`, "", "5"),
      entry(`${ROOT}/src/a.ts`, "export const a = 1;\n"),
      entry("PaxHeader", paxRecord("path", long), "x"),
      entry(long.slice(0, 99), "long pax\n"),
      entry("././@LongLink", `${gnuLong}\0`, "L"),
      entry(gnuLong.slice(0, 99), "long gnu\n"),
      entry("b.md", "# prefixed\n", "0", `${ROOT}/docs`),
      entry(`${ROOT}/link.ts`, "", "2"),
      entry(`${ROOT}/../escape.ts`, "nope"),
      entry(`${ROOT}/empty.txt`, ""),
      entry(`${ROOT}/block.txt`, "x".repeat(512)),
      entry(`${ROOT}/old.ts`, "old style\n", "\0"),
    ]);

    const files = untar(gz);
    expect(files.map((f) => f.path)).toEqual([
      "src/a.ts",
      long.slice(ROOT.length + 1),
      gnuLong.slice(ROOT.length + 1),
      "docs/b.md",
      "empty.txt",
      "block.txt",
      "old.ts",
    ]);
    expect(decoder.decode(files[0].data)).toBe("export const a = 1;\n");
    expect(decoder.decode(files[1].data)).toBe("long pax\n");
    expect(decoder.decode(files[2].data)).toBe("long gnu\n");
    expect(files[4].data.length).toBe(0);
    expect(files[5].data.length).toBe(512);
  });

  test("round-trips binary content byte for byte", () => {
    const bytes = new Uint8Array(1500).map((_, i) => (i * 37) % 256);
    const [file] = untar(tarball([entry(`${ROOT}/bin.dat`, bytes)]));
    expect(file.path).toBe("bin.dat");
    expect([...file.data]).toEqual([...bytes]);
  });

  test("an empty archive has no files", () => {
    expect(untar(tarball([]))).toEqual([]);
  });
});
