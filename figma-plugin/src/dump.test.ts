import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { convertSelection } from "./convert";
import { misplaced, rehydrate } from "./oracle";

/**
 * A details dump from the plugin's "Copy details for a bug report", run
 * through the converter and the placement oracle:
 *
 *     FIGMA_DUMP=~/Downloads/details.json npx vitest run figma-plugin/src/dump.test.ts
 *
 * Skipped when no dump is named. Every node the dump saw must land where
 * Figma had it, and the markup must round-trip.
 */
const path = process.env.FIGMA_DUMP;
const parse = (html: string) => parseScene(html, (h) => parseHTML(h).document as unknown as Document);

describe.skipIf(!path)("a details dump", () => {
  it("places every node where Figma had it, and round-trips", async () => {
    const dump = JSON.parse(readFileSync(path!, "utf8")) as { selection: unknown[] };
    const selection = dump.selection.map(rehydrate);
    const { scene, report } = await convertSelection(selection, async () => null);
    const html = serializeScene(scene);
    expect(serializeScene(parse(html))).toBe(html);
    // Losses are allowed and listed; a wrong place is not.
    if (report.length) console.log(report.map((r) => `${r.code} ${r.name} (${r.nodeId}): ${r.message}`).join("\n"));
    expect(misplaced(selection, scene)).toEqual([]);
  });
});
