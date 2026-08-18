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
 * A chosen file on its way into the project's context: checked, uploaded to
 * storage, then attached — at which point the server schedules its extraction
 * and the row appears as "Reading…" until that lands.
 *
 * Checked here as well as in the mutation so a wrong kind or an oversized file
 * is refused while the user is still holding it, before any bytes move.
 */
export async function uploadContextFile(
  convex: ConvexReactClient,
  projectId: Id<"projects">,
  file: File,
): Promise<void> {
  const filename = file.name || "untitled";
  if (!fileKind(filename, file.type)) {
    throw new Error(`${filename} isn't a kind of file the assistant can read. ${CONTEXT_FILE_HELP}`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `${filename} is ${megabytes(file.size)} — context files have to be under ${megabytes(
        MAX_FILE_BYTES,
      )}.`,
    );
  }

  const uploadUrl = await convex.mutation(api.files.context.generateUploadUrl, {});
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!response.ok) throw new Error(`${filename} didn't upload. Try adding it again.`);

  const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
  try {
    await convex.mutation(api.files.context.add, {
      projectId,
      storageId,
      filename,
      mediaType: file.type,
    });
  } catch (error) {
    throw new Error(reason(error, `${filename} could not be added. Try again.`));
  }
}

/** A file's size the way the row reads it. */
export function fileSize(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))}KB` : megabytes(bytes);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}
