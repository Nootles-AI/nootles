"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AI } from "../aiConfig";
import type { AbMessage } from "./types";

/**
 * Files on their way into a message.
 *
 * Two kinds, because a provider takes them two different ways: an image is
 * something to look at and travels as a `file` part pointing at Convex storage,
 * while a text file is something to read and is inlined into the message. That
 * is also why only images reach storage — inlining a text file twice, once as
 * bytes and once as words, would leave two copies to disagree.
 */

/** Chosen but not sent: still a `File`, because nothing is uploaded until it is. */
export type PendingAttachment = {
  id: string;
  filename: string;
  mediaType: string;
} & ({ kind: "image"; file: File } | { kind: "text"; text: string });

/** Resolved at send: an image has a storage id, a text file has its words. */
export type ReadyAttachment = { filename: string; mediaType: string } & (
  | { kind: "image"; storageId: Id<"_storage">; url: string }
  | { kind: "text"; text: string }
);

/**
 * What the vision models actually accept. Anything else — SVG, HEIC, a PDF —
 * is refused here rather than at the provider, where it comes back as a failed
 * turn several seconds later.
 */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const TEXT_TYPES = [
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/sql",
];

/**
 * Code, by extension. Browsers report no media type at all for most source
 * files — a `.ts`, `.rs` or `.go` file arrives as `""` — so the name is the only
 * thing left to read it from.
 */
const TEXT_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "swift", "c", "h", "cpp", "cs", "php", "sh", "sql", "css", "scss", "html",
  "json", "md", "txt", "csv", "tsv", "yml", "yaml", "toml", "ini", "env", "xml",
];

/** Named for the message the user reads when a file is refused. */
export const ATTACHMENT_HELP =
  "I can take images (PNG, JPEG, GIF, WebP) and text files — code, Markdown, CSV, JSON.";

/** The picker's filter, from the same lists the check reads, so they agree. */
export const ATTACHMENT_ACCEPT = [
  ...IMAGE_TYPES,
  "text/*",
  ...TEXT_TYPES,
  ...TEXT_EXTENSIONS.map((ext) => `.${ext}`),
].join(",");

/**
 * Reads a chosen file, or says why it cannot be sent.
 *
 * Text is read now rather than at send: it is what makes the character cap a
 * refusal you get while you are still holding the file, instead of a message
 * that fails after you press Send.
 */
export async function acceptFile(file: File): Promise<PendingAttachment> {
  const filename = file.name || "untitled";
  const mediaType = file.type;

  if (file.size > AI.chat.attachments.maxBytes) {
    throw new Error(
      `${filename} is ${megabytes(file.size)} — files have to be under ${megabytes(
        AI.chat.attachments.maxBytes,
      )}.`,
    );
  }

  const base = { id: crypto.randomUUID(), filename };
  if (IMAGE_TYPES.includes(mediaType)) {
    return { ...base, kind: "image", mediaType, file };
  }
  if (!isText(mediaType, filename)) {
    throw new Error(`${filename} isn't a kind of file I can read. ${ATTACHMENT_HELP}`);
  }

  const text = await file.text();
  if (text.length > AI.chat.attachments.maxTextChars) {
    throw new Error(
      `${filename} is ${text.length.toLocaleString()} characters — text files have to be under ${AI.chat.attachments.maxTextChars.toLocaleString()}.`,
    );
  }
  // A source file with no media type of its own is still text to whoever reads it.
  return { ...base, kind: "text", mediaType: mediaType || "text/plain", text };
}

function isText(mediaType: string, filename: string): boolean {
  if (mediaType.startsWith("text/") || TEXT_TYPES.includes(mediaType)) return true;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.includes(ext);
}

/**
 * Puts an image where the model can fetch it, and reads back the URL to send.
 *
 * At send, not at attach: a file the user thought better of never reaches
 * storage, so removing a chip cannot leave a blob behind that nothing refers to.
 */
export async function uploadAttachment(
  convex: ConvexReactClient,
  pending: PendingAttachment,
): Promise<ReadyAttachment> {
  const { filename, mediaType } = pending;
  if (pending.kind === "text") return { kind: "text", filename, mediaType, text: pending.text };

  const uploadUrl = await convex.mutation(api.chat.attachments.generateUploadUrl, {});
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": mediaType },
    body: pending.file,
  });
  if (!response.ok) throw new Error(`${filename} didn't upload. Try attaching it again.`);

  const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
  const url = await convex.query(api.chat.attachments.url, { storageId });
  if (!url) throw new Error(`${filename} didn't upload. Try attaching it again.`);
  return { kind: "image", filename, mediaType, storageId, url };
}

/**
 * Puts today's URLs back on a message read from the database.
 *
 * Storage URLs expire, so a message stores the storage id beside the index of
 * the part that used it and the URL is derived on every read. A part whose file
 * has since gone is dropped rather than kept with a dead URL: the SDK parses it
 * on the way to the model, and one unreadable attachment would fail every later
 * turn in the thread.
 */
export function withAttachmentUrls(
  parts: AbMessage["parts"],
  urls: { partIndex: number; url: string | null }[] | undefined,
): AbMessage["parts"] {
  if (!urls?.length) return parts;
  const byIndex = new Map(urls.map((u) => [u.partIndex, u.url]));
  return parts.flatMap((part, i) => {
    if (part.type !== "file" || !byIndex.has(i)) return [part];
    const url = byIndex.get(i);
    return url ? [{ ...part, url }] : [];
  });
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}
