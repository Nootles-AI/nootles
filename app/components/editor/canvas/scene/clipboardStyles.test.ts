import { describe, expect, it } from "vitest";
import { clipboardStyles, localizeClipboardStyles } from "./clipboardStyles";
import { parseScene } from "./parse";
import { serializeScene } from "./serialize";
import { parseHTML } from "linkedom";

const parse = (html: string) => parseScene(html, (source) => parseHTML(source).document as unknown as Document);

describe("portable clipboard styles", () => {
  it("carries tokens and typography, not board paint or dimensions", () => {
    expect(clipboardStyles({ "--ink": "red", color: "var(--ink)", "font-family": "Arial", background: "blue", width: "400px" })).toEqual({ "--ink": "red", color: "red", "font-family": "Arial" });
  });
  it("localizes dependencies without overwriting authored child declarations", () => {
    const source = parse('<nt-diagram w="400" h="300" style="--ink: red; --alias: var(--ink)"><nt-rect id="a" w="100" h="100" style="background: var(--alias); --ink: blue"></nt-rect></nt-diagram>');
    const localized = localizeClipboardStyles(source);
    expect(localized.nodes[0].style).toMatchObject({ "--ink": "blue", "--alias": "red", background: "var(--alias)" });
    expect(source.nodes[0].style["--alias"]).toBeUndefined();
    const canonical = serializeScene(localized);
    expect(serializeScene(parse(canonical))).toBe(canonical);
  });
});
