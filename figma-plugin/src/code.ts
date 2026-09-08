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
  | { type: "ready"; html: string; count: number; report: Diagnostic[] }
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
    post({
      type: "ready",
      html: serializeScene(result.scene),
      count: result.count,
      report: result.report,
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
