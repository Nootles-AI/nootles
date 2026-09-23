"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  CONTEXT_FILE_HELP,
  fileKind,
  MAX_FILE_BYTES,
} from "@/convex/files/shared";
import { reason } from "./github";

/**
 * What was wrong with a chosen file, in a sentence the person can act on —
 * told apart from any other failure so it can be said as it is.
 */
export class ContextFileError extends Error {}

/**
 * A chosen file on its way into the project's context: checked, uploaded to
 * storage, then attached — at which point the server schedules its extraction
 * and the row appears as "Reading…" until that lands.
 */
export async function uploadContextFile(
  convex: ConvexReactClient,
  projectId: Id<"projects">,
  file: File,
): Promise<void> {
  const stored = await storeContextFile(convex, file);
  try {
    await convex.mutation(api.files.context.add, { projectId, ...stored });
  } catch (error) {
    throw new ContextFileError(reason(error, `${stored.filename} could not be added. Try again.`));
  }
}

/**
 * The first half of that, for a project that does not exist yet: the bytes in
 * storage, and what `projects.create` needs to attach them.
 *
 * Checked here as well as on the server so a wrong kind or an oversized file
 * is refused while the user is still holding it, before any bytes move.
 */
export async function storeContextFile(
  convex: ConvexReactClient,
  file: File,
): Promise<{ storageId: Id<"_storage">; filename: string; mediaType: string }> {
  const filename = checkContextFile(file);
  const uploadUrl = await convex.mutation(api.files.context.generateUploadUrl, {});
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!response.ok) throw new ContextFileError(`${filename} didn't upload. Try adding it again.`);
  const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
  return { storageId, filename, mediaType: file.type };
}

/** The name a file is attached under, or why it cannot be. */
export function checkContextFile(file: File): string {
  const filename = file.name || "untitled";
  if (!fileKind(filename, file.type)) {
    throw new ContextFileError(
      `${filename} isn't a kind of file the assistant can read. ${CONTEXT_FILE_HELP}`,
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new ContextFileError(
      `${filename} is ${megabytes(file.size)} — context files have to be under ${megabytes(
        MAX_FILE_BYTES,
      )}.`,
    );
  }
  return filename;
}

/** A file's size the way the row reads it. */
export function fileSize(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))}KB` : megabytes(bytes);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}
