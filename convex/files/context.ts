import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { projectRole, readOwned, requireOwned, requireOwner } from "../auth";
import { CONTEXT_FILE_HELP, fileKind, MAX_FILE_BYTES } from "./shared";

/**
 * Files uploaded as project context.
 *
 * The sibling of `github/repos.ts`: a row here is what "the agent may read this
 * file" means, the head of its extracted text is read into every prompt, and
 * `read` is the tool that returns the rest. The bytes themselves live in
 * storage and are parsed once, by `files/extract.ts`, the moment the row is
 * written.
 */

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const listForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    if (!(await readOwned(ctx, "projects", args.projectId))) return [];
    return await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

/**
 * Attach an uploaded file to a project and start reading it. Adding and
 * extracting are one act to the user and two to the database, same as linking
 * a repository: the row has to exist before the parse can write into it, and
 * parsing is work a mutation may not do.
 */
export const add = mutation({
  args: {
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mediaType: v.string(),
  },
  handler: async (ctx, args) => {
    const { ownerId } = await requireOwned(ctx, "projects", args.projectId);
    const filename = args.filename.trim();
    if (!filename || !fileKind(filename, args.mediaType)) {
      throw new ConvexError(`"${filename}" isn't a kind of file the assistant can read. ${CONTEXT_FILE_HELP}`);
    }
    // The system row is the truth about what was uploaded; the client's word
    // for the size is not.
    const meta = await ctx.db.system.get(args.storageId);
    if (!meta) throw new ConvexError(`${filename} didn't upload. Try adding it again.`);
    if (meta.size > MAX_FILE_BYTES) {
      await ctx.storage.delete(args.storageId);
      throw new ConvexError(
        `${filename} is ${(meta.size / 1_000_000).toFixed(1)}MB — context files have to be under ${MAX_FILE_BYTES / 1_000_000}MB.`,
      );
    }

    // The same name replaces rather than doubles: two files both called
    // "spec.pdf" would leave the agent unable to name the one it means.
    const existing = await ctx.db
      .query("projectFiles")
      .withIndex("by_project_and_filename", (q) =>
        q.eq("projectId", args.projectId).eq("filename", filename),
      )
      .unique();
    if (existing) {
      await ctx.storage.delete(existing.storageId);
      await ctx.db.delete(existing._id);
    }

    const fileId = await ctx.db.insert("projectFiles", {
      ownerId,
      projectId: args.projectId,
      storageId: args.storageId,
      filename,
      mediaType: args.mediaType,
      size: meta.size,
      addedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.files.extract.run, { fileId, ownerId });
    return fileId;
  },
});

export const remove = mutation({
  args: { fileId: v.id("projectFiles") },
  handler: async (ctx, args) => {
    const file = await requireOwned(ctx, "projectFiles", args.fileId);
    await ctx.storage.delete(file.storageId);
    await ctx.db.delete(args.fileId);
  },
});

/** Run the extraction again — the way out of a failed parse. */
export const refresh = mutation({
  args: { fileId: v.id("projectFiles") },
  handler: async (ctx, args) => {
    const file = await requireOwned(ctx, "projectFiles", args.fileId);
    await ctx.scheduler.runAfter(0, internal.files.extract.run, {
      fileId: file._id,
      ownerId: file.ownerId,
    });
  },
});

/**
 * The whole extracted text — what the chat tool returns. Editors read it too,
 * the same reach `forPrompt` has: the context is the project's, not the
 * owner's alone. A query rather than an action, because unlike a repository
 * there is nothing left to fetch.
 */
export const read = query({
  args: { projectId: v.id("projects"), name: v.string() },
  handler: async (ctx, args) => {
    const role = await projectRole(ctx, args.projectId);
    if (role !== "owner" && role !== "editor") throw new ConvexError("Not found");
    const name = args.name.trim();
    const file = await ctx.db
      .query("projectFiles")
      .withIndex("by_project_and_filename", (q) =>
        q.eq("projectId", args.projectId).eq("filename", name),
      )
      .unique();
    if (!file) {
      const rows = await ctx.db
        .query("projectFiles")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .collect();
      throw new ConvexError(
        rows.length
          ? `"${name}" is not one of this project's context files. They are: ${rows
              .map((r) => r.filename)
              .join(", ")}.`
          : "This project has no context files.",
      );
    }
    if (file.syncError) {
      throw new ConvexError(`"${name}" could not be read: ${file.syncError}`);
    }
    if (file.text === undefined) {
      return { name, pending: true as const, note: "Still being read — ask again in a moment." };
    }
    return {
      name,
      mediaType: file.mediaType,
      content: file.text,
      ...(file.fullChars && file.fullChars > file.text.length
        ? {
            truncated: `Showing the first ${file.text.length} characters of ${file.fullChars}.`,
          }
        : {}),
    };
  },
});

// ---- Internal ------------------------------------------------------------

export const row = internalQuery({
  args: { fileId: v.id("projectFiles"), ownerId: v.string() },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    return file && file.ownerId === args.ownerId ? file : null;
  },
});

export const writeText = internalMutation({
  args: {
    fileId: v.id("projectFiles"),
    text: v.optional(v.string()),
    fullChars: v.optional(v.number()),
    syncError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.fileId))) return;
    await ctx.db.patch(args.fileId, {
      // A failed parse records why and leaves the last good text alone, the
      // same trade `writeSummary` makes for a repository.
      ...(args.text !== undefined
        ? { text: args.text, fullChars: args.fullChars, syncError: undefined }
        : {}),
      ...(args.syncError ? { syncError: args.syncError } : {}),
      syncedAt: Date.now(),
    });
  },
});
