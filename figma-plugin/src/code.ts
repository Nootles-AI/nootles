/// <reference types="@figma/plugin-typings" />

/**
 * The plugin's main thread: what runs inside Figma with the document in reach.
 *
 * It does two things. It tells the UI what is selected, so the button can say
 * what it will copy. And when the button is pressed it converts the selection
 * into the canvas's own markup and hands the text to the UI, because only the
 * UI's iframe can reach the clipboard. Nothing is sent anywhere else: the
 * manifest asks for no network, and the markup goes from here to the
 * clipboard and no further.
 */

import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { convertSelection, type Diagnostic } from "./convert";
import type { FigNode } from "./model";

type ToUi =
  | { type: "selection"; count: number; names: string[] }
  | { type: "busy" }
  | { type: "ready"; html: string; count: number; report: Diagnostic[]; details: string }
  | { type: "failed"; message: string };

type FromUi = { type: "copy" } | { type: "close" };

const post = (message: ToUi) => figma.ui.postMessage(message);

figma.showUI(__html__, { width: 320, height: 380, themeColors: true });

function describeSelection() {
  const selection = figma.currentPage.selection;
  post({
    type: "selection",
    count: selection.length,
    names: selection.slice(0, 3).map((node) => node.name),
  });
}

/** The PNG and JPEG magic bytes, so the data URI says what it holds. */
function mimeOf(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return "application/octet-stream";
}

async function imageSource(hash: string): Promise<string | null> {
  const image = figma.getImageByHash(hash);
  if (!image) return null;
  const bytes = await image.getBytesAsync();
  return `data:${mimeOf(bytes)};base64,${figma.base64Encode(bytes)}`;
}

/**
 * The fields the converter reads, as plain JSON, for a bug report.
 *
 * Positions are the thing most likely to be wrong and least possible to fix
 * from a description, so the report carries exactly what the converter saw:
 * every transform, size and layout setting, down the tree. Image hashes stay
 * hashes; the bytes are not what anyone needs to read.
 */
const DETAIL_FIELDS = [
  "id", "name", "type", "visible", "locked",
  "x", "y", "width", "height", "rotation", "relativeTransform", "absoluteTransform",
  "opacity", "blendMode", "fills", "strokes", "strokeWeight", "strokeAlign", "dashPattern",
  "strokeCap", "strokeJoin", "cornerRadius", "topLeftRadius", "topRightRadius",
  "bottomRightRadius", "bottomLeftRadius", "effects",
  "layoutMode", "layoutWrap", "itemSpacing", "counterAxisSpacing", "paddingLeft",
  "paddingRight", "paddingTop", "paddingBottom", "primaryAxisAlignItems",
  "counterAxisAlignItems", "layoutSizingHorizontal", "layoutSizingVertical",
  "layoutPositioning", "clipsContent", "arcData", "pointCount",
  "vectorPaths", "fillGeometry", "strokeGeometry",
  "characters", "fontSize", "fontName", "textAlignHorizontal", "textAlignVertical",
  "textAutoResize", "maxLines", "lineHeight", "letterSpacing", "paragraphSpacing",
  "textCase", "textDecoration",
  "connectorStart", "connectorEnd", "connectorLineType", "text", "shapeType",
] as const;

function detail(node: unknown, depth = 0): unknown {
  if (depth > 12 || typeof node !== "object" || node === null) return undefined;
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of DETAIL_FIELDS) {
    const value = source[field];
    if (value === undefined || typeof value === "symbol") continue;
    out[field] = typeof value === "function" ? undefined : value;
  }
  if (typeof source.getStyledTextSegments === "function") {
    try {
      out.segments = (source.getStyledTextSegments as (f: string[]) => unknown)([
        "fontSize", "fontName", "fills", "textDecoration", "textCase", "letterSpacing", "hyperlink", "listOptions",
      ]);
    } catch {
      // A text whose font is missing refuses; the rest of the node still tells.
    }
  }
  if (Array.isArray(source.children)) {
    out.children = (source.children as unknown[]).map((child) => detail(child, depth + 1));
  }
  return out;
}

async function copy() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    post({ type: "failed", message: "Select something to copy first." });
    return;
  }
  post({ type: "busy" });
  try {
    // The Plugin API's nodes are the model's shape and more; the converter
    // reads only the fields the model names.
    const result = await convertSelection(selection as unknown as FigNode[], imageSource);
    const html = serializeScene(result.scene);
    post({
      type: "ready",
      html,
      count: result.count,
      report: result.report,
      details: JSON.stringify(
        { selection: selection.map((node) => detail(node)), html, report: result.report },
        (_key, value: unknown) => (typeof value === "symbol" ? "mixed" : value),
        2,
      ),
    });
  } catch (error) {
    post({
      type: "failed",
      message: error instanceof Error ? error.message : "That selection could not be converted.",
    });
  }
}

figma.ui.onmessage = (message: FromUi) => {
  if (message.type === "copy") void copy();
  if (message.type === "close") figma.closePlugin();
};

figma.on("selectionchange", describeSelection);
describeSelection();
