import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DOMParser } from "linkedom";
import { describe, expect, it } from "vitest";
import { toDocHtml } from "@/app/lib/ai/html/serialize";
import type { AnyBlock } from "@/app/lib/ai/projection";
import { convertLegacyDocument, type LegacyDocumentInput } from "../legacy";
import { nmlToDocHtml } from "./html";

(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser = DOMParser;

const fixturesDir = fileURLToPath(new URL("../__fixtures__/legacy", import.meta.url));
const fixtureNames = readdirSync(fixturesDir).filter(
  (name) => name.endsWith(".json") && name !== "edge-cases.json",
);
const loadFixture = (name: string) =>
  JSON.parse(readFileSync(`${fixturesDir}/${name}`, "utf8")) as LegacyDocumentInput;
const counter = () => {
  let id = 0;
  return () => `generated-${++id}`;
};

describe("canonical NML HTML serialization", () => {
  for (const name of fixtureNames) {
    it(`is byte-identical to legacy HTML for ${name}`, () => {
      const fixture = loadFixture(name);
      const legacy = toDocHtml(fixture.blocks as unknown as AnyBlock[]);
      const { document } = convertLegacyDocument(fixture, { createId: counter() });
      expect(nmlToDocHtml(document)).toBe(legacy);
    });
  }

  it("serializes Notion stubs byte-identically to the legacy reader", () => {
    const fixture = loadFixture("edge-cases.json");
    const input = { ...fixture, blocks: fixture.blocks.filter((block) => block.type === "notionStub") };
    const legacy = toDocHtml(input.blocks as unknown as AnyBlock[]);
    const { document } = convertLegacyDocument(input, { createId: counter() });
    expect(nmlToDocHtml(document)).toBe(legacy);
  });

  it("resolves storage-backed media for HTML readers", () => {
    const fixture = loadFixture("media.json");
    const { document } = convertLegacyDocument(fixture, { createId: counter() });
    const image = document.blocks.find((block) => block.type === "image");
    if (!image || image.type !== "image") throw new Error("missing image fixture");
    image.props.source = { kind: "storage", storageId: "stored-image" };
    expect(
      nmlToDocHtml(document, {}, { resolveStorageUrl: () => "https://media.example/image.png" }),
    ).toContain('src="https://media.example/image.png"');
  });
});
