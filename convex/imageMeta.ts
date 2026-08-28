import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { ownerId, requireOwner } from "./auth";

/**
 * The index of what an album's pictures look like — see the schema note on
 * `imageMeta`.
 *
 * Reads answer for the signed-in account only, which is the same reach the
 * upload door in `albums.ts` has: a storage id is not a row, so there is
 * nothing to hang a project's sharing off. Every caller that needs this is
 * signed in — the editor writing stats as a photo lands, and the agent's tools,
 * which run as the user whose thread they are in.
 *
 * A row is derived data about a picture that already exists, so nothing here
 * deletes: an album that loses a photo simply stops asking about it, and the
 * row costs a few dozen bytes against a photograph that cost megabytes.
 */

const STATS = {
  hex: v.string(),
  palette: v.array(v.string()),
  hue: v.number(),
  sat: v.number(),
  light: v.number(),
  energy: v.number(),
};

/** How many pictures one call may ask about. Far past the biggest album. */
const MOST = 256;

export const put = mutation({
  args: { entries: v.array(v.object({ src: v.string(), ...STATS })) },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    for (const entry of args.entries.slice(0, MOST)) {
      const { src, ...stats } = entry;
      const existing = await ctx.db
        .query("imageMeta")
        .withIndex("by_owner_and_src", (q) => q.eq("ownerId", owner).eq("src", src))
        .unique();
      // Upsert, and never over the caption: colour is measured from the file
      // and cannot have changed, so a second write of it is a re-upload of the
      // same picture — not a reason to throw away a caption that cost a call.
      if (existing) await ctx.db.patch(existing._id, stats);
      else await ctx.db.insert("imageMeta", { ownerId: owner, src, ...stats, createdAt: Date.now() });
    }
    return null;
  },
});

/**
 * What the captioning pass learned. Separate from `put` because it arrives from
 * somewhere else, at a different time, and must not disturb the colour columns.
 */
export const describe = mutation({
  args: {
    entries: v.array(
      v.object({ src: v.string(), alt: v.string(), striking: v.number() }),
    ),
  },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const now = Date.now();
    for (const { src, alt, striking } of args.entries.slice(0, MOST)) {
      const existing = await ctx.db
        .query("imageMeta")
        .withIndex("by_owner_and_src", (q) => q.eq("ownerId", owner).eq("src", src))
        .unique();
      const described = { alt, striking, indexedAt: now };
      if (existing) {
        await ctx.db.patch(existing._id, described);
        continue;
      }
      // No colour row: a picture that predates the stats pass, or one added
      // from somewhere other than the uploader. A caption alone is still worth
      // keeping, and the neutral colours say plainly that none were measured.
      await ctx.db.insert("imageMeta", {
        ownerId: owner,
        src,
        hex: "#808080",
        palette: [],
        hue: 0,
        sat: 0,
        light: 50,
        energy: 0,
        ...described,
        createdAt: now,
      });
    }
    return null;
  },
});

/**
 * Colour for a picture that arrived from the web, where the provider published
 * its own dominant colour and no canvas here ever saw the pixels. Internal:
 * only the ingest action, which is the only thing that knows this is true.
 */
export const putPublished = internalMutation({
  args: {
    ownerId: v.string(),
    entries: v.array(
      v.object({
        src: v.string(),
        hex: v.string(),
        hue: v.number(),
        sat: v.number(),
        light: v.number(),
        alt: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const { src, hex, hue, sat, light, alt } of args.entries) {
      const existing = await ctx.db
        .query("imageMeta")
        .withIndex("by_owner_and_src", (q) => q.eq("ownerId", args.ownerId).eq("src", src))
        .unique();
      if (existing) continue;
      await ctx.db.insert("imageMeta", {
        ownerId: args.ownerId,
        src,
        hex,
        palette: [hex],
        hue,
        sat,
        light,
        // The provider's own words about the picture, which is a caption that
        // cost nothing — so a found picture is indexed the moment it lands and
        // never needs the captioning pass at all.
        ...(alt ? { alt, indexedAt: now } : {}),
        createdAt: now,
      });
    }
    return null;
  },
});

export const read = query({
  args: { srcs: v.array(v.string()) },
  handler: async (ctx, args) => {
    const owner = await ownerId(ctx);
    if (!owner) return [];
    const rows = [];
    for (const src of args.srcs.slice(0, MOST)) {
      const row = await ctx.db
        .query("imageMeta")
        .withIndex("by_owner_and_src", (q) => q.eq("ownerId", owner).eq("src", src))
        .unique();
      if (row) {
        const { _id, _creationTime, ownerId: _owner, createdAt: _at, ...meta } = row;
        rows.push(meta);
      }
    }
    return rows;
  },
});
