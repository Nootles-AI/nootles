import {
  toDocHtml,
  toDocHtmlSplit,
  toDocHtmlWithin,
} from "@/app/lib/ai/html/serialize";
import type { NmlDocument } from "../schema";
import {
  nmlToAnyBlocks,
  type NmlBlockAdapterOptions,
} from "./projection";

type HtmlOptions = Parameters<typeof toDocHtml>[1];

/** Canonical served document → the exact Nootles HTML grammar legacy readers use. */
export function nmlToDocHtml(
  document: NmlDocument,
  options: HtmlOptions = {},
  adapter: NmlBlockAdapterOptions = {},
): string {
  return toDocHtml(nmlToAnyBlocks(document, adapter), options);
}

export function nmlToDocHtmlWithin(
  document: NmlDocument,
  maxChars: number,
  options: HtmlOptions = {},
  adapter: NmlBlockAdapterOptions = {},
): ReturnType<typeof toDocHtmlWithin> {
  return toDocHtmlWithin(nmlToAnyBlocks(document, adapter), maxChars, options);
}

export function nmlToDocHtmlSplit(
  document: NmlDocument,
  cursorBlockId: string,
  offset: number,
  options: HtmlOptions = {},
  cell?: Parameters<typeof toDocHtmlSplit>[4],
  adapter: NmlBlockAdapterOptions = {},
): ReturnType<typeof toDocHtmlSplit> {
  return toDocHtmlSplit(
    nmlToAnyBlocks(document, adapter),
    cursorBlockId,
    offset,
    options,
    cell,
  );
}
