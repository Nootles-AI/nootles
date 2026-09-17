import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOMParser } from "linkedom";
import { project, type AnyBlock } from "@/app/lib/ai/projection";

// `projection.ts` parses canvas/album/storyboard/location markup with a global
// `DOMParser` (the browser provides one at runtime); supply linkedom's here so
// the domain-carrying fixtures project headless, exactly as the app does live.
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser = DOMParser;
import { convertLegacyDocument, type LegacyDocumentInput } from "../legacy";
import { projectNmlDocument } from "./projection";

const fixturesDir = fileURLToPath(new URL("../__fixtures__/legacy", import.meta.url));
const fixtureNames = readdirSync(fixturesDir).filter((name) => name.endsWith(".json"));

// `notionStub` has no NML v1 representation — the converter omits it as an
// unsupported block — so a migrated doc cannot reproduce its projection line.
// That is an inherent projector limit (documented in projection.ts), not an
// adapter defect, so the one fixture carrying a stub is held out of strict parity.
const STUB_FIXTURES = new Set(["edge-cases.json"]);

const loadFixture = (name: string) =>
  JSON.parse(readFileSync(`${fixturesDir}/${name}`, "utf8")) as LegacyDocumentInput;

// Deterministic ids for the minted-only nodes (table cells, math rows, inline
// atom ids) so the conversion is stable run to run; none of these appear in the
// projection text, so their exact values do not affect parity.
const counter = () => {
  let n = 0;
  return () => `gen-${++n}`;
};

describe("projectNmlDocument parity with the legacy projection", () => {
  for (const name of fixtureNames) {
    if (STUB_FIXTURES.has(name)) {
      it.skip(`${name} (holds a notionStub with no NML representation)`, () => {});
      continue;
    }
    it(`reproduces project() text + index for ${name}`, () => {
      const fixture = loadFixture(name);
      const legacy = project(fixture.blocks as unknown as AnyBlock[]);
      const { document } = convertLegacyDocument(fixture, { createId: counter() });
      const served = projectNmlDocument(document);
      expect(served.text).toBe(legacy.text);
      expect(served.index).toEqual(legacy.index);
    });
  }
});
