"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { fileKind, htmlToText, MAX_FILE_TEXT } from "./shared";

/**
 * Turns an uploaded context file into the text the agent reads. Node rather
 * than the default runtime for the parsers' sake — unpdf and mammoth both
 * want Node — and scheduled by `files/context.add`, so the row shows up
 * unread for as long as the parse takes.
 */
export const run = internalAction({
  args: { fileId: v.id("projectFiles"), ownerId: v.string() },
  handler: async (ctx, args) => {
    const file: Doc<"projectFiles"> | null = await ctx.runQuery(
      internal.files.context.row,
      args,
    );
    if (!file) return;
    try {
      const blob = await ctx.storage.get(file.storageId);
      if (!blob) throw new Error("The uploaded bytes are gone from storage.");
      const text = tidy(await extract(file, await blob.arrayBuffer()));
      if (!text) throw new Error("No readable text was found in this file.");
      await ctx.runMutation(internal.files.context.writeText, {
        fileId: file._id,
        text: text.slice(0, MAX_FILE_TEXT),
        fullChars: text.length,
      });
    } catch (error) {
      // A file that cannot be parsed is still listed, and says why on its row.
      // Throwing here would only lose the reason in a scheduled function's logs.
      await ctx.runMutation(internal.files.context.writeText, {
        fileId: file._id,
        syncError: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

async function extract(file: Doc<"projectFiles">, bytes: ArrayBuffer): Promise<string> {
  switch (fileKind(file.filename, file.mediaType)) {
    case "pdf": {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      return text;
    }
    case "docx": {
      const { default: mammoth } = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return value;
    }
    case "html":
      return htmlToText(new TextDecoder().decode(bytes));
    case "text":
      return new TextDecoder().decode(bytes);
    default:
      // `add` refuses these up front; reachable only for a row written before
      // this extractor learned the kind was unreadable.
      throw new Error("This kind of file cannot be read as text.");
  }
}

/**
 * The parsers' output, made worth storing. A NUL byte is the one reliable tell
 * that what was uploaded was never text — a renamed binary decodes to noise,
 * and noise costs the same as prose in every prompt that carries it.
 */
function tidy(text: string): string {
  if (text.includes("\u0000")) throw new Error("This file is binary, not text.");
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
