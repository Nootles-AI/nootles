import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireOwner } from "./auth";
import { uploadUrl } from "./uploads";

/**
 * Where an album's photos and videos are put.
 *
 * An upload door and the one lookup that follows it, because an album keeps the
 * storage URL rather than the storage id. `storage.getUrl` returns a permanent
 * bearer URL — it stops working only when the file is deleted — so the id is
 * exchanged for a URL once, as the file lands, and that URL is what goes into
 * the block's markup. It buys two things a stored id cannot: a tile starts
 * loading on the first paint instead of after a round trip, and a shared page,
 * which has no signed-in identity to derive a URL with, can show its pictures at
 * all. The URL is exactly as shareable as the page holding it.
 *
 * Separate from `chat/attachments.ts` deliberately: that door decides what a
 * model may read and holds ids because a thread is re-read months later; this
 * one decides what a document may hold. They share one authorization policy
 * (`uploads.ts`) and will not stay the same shape.
 */

export const generateUploadUrl = mutation({ args: {}, handler: uploadUrl });

/**
 * Signed-in only, which is as far as ownership can reach: a storage id is not a
 * row, so there is nothing to hang an `ownerId` off. It is read exactly once per
 * file, by the account that just uploaded it.
 */
export const url = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.storage.getUrl(args.storageId);
  },
});

/**
 * Hosts a found picture's bytes may be fetched from.
 *
 * Belt as well as braces. The URL already cannot come from the model — it is
 * read from a `foundImages` row that only `find_images` writes — so this guards
 * against a future caller getting that wrong rather than against today's. A
 * fetch on this server reaches wherever it is pointed.
 */
const SOURCES = ["images.unsplash.com", "plus.unsplash.com"];

/**
 * The other upload door: bytes we fetch, rather than bytes a browser sends.
 *
 * A found picture is COPIED into our own storage rather than linked. Hot-linking
 * would put a stranger's URL in the document, where it can rot, be rate-limited,
 * or be withdrawn — while every other picture in the same album is permanent —
 * and would make the album's pictures unreadable to a canvas. Copying is also
 * what makes the licence's attribution something we can keep.
 *
 * The resize is the provider's: their URLs take the dimensions we want, so the
 * bytes that arrive are already the bytes we would have re-encoded to. Nothing
 * here decodes an image, which is why this can be a plain action.
 */
export const ingest = action({
  args: { refs: v.array(v.string()), edge: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ ref: string; src: string; w: number; h: number }[]> => {
    const owner = (await ctx.auth.getUserIdentity())?.subject;
    if (!owner) throw new Error("Not signed in");

    const found = await ctx.runQuery(internal.ai.found.get, {
      ownerId: owner,
      refs: args.refs,
    });
    const edge = Math.min(2560, Math.max(320, Math.round(args.edge ?? 1600)));

    const landed: { ref: string; src: string; w: number; h: number }[] = [];
    const described: {
      src: string;
      hex: string;
      hue: number;
      sat: number;
      light: number;
      alt: string;
    }[] = [];

    for (const row of found) {
      let address: URL;
      try {
        address = new URL(row.url);
      } catch {
        continue;
      }
      if (address.protocol !== "https:" || !SOURCES.includes(address.hostname)) continue;
      address.searchParams.set("w", String(edge));
      address.searchParams.set("fm", "webp");
      address.searchParams.set("q", "82");

      const response = await fetch(address).catch(() => null);
      if (!response?.ok) continue;
      const blob = await response.blob().catch(() => null);
      if (!blob) continue;

      const storageId = await ctx.storage.store(blob);
      const src = await ctx.storage.getUrl(storageId);
      if (!src) continue;

      const scale = Math.min(1, edge / Math.max(row.w, row.h));
      landed.push({
        ref: row.ref,
        src,
        w: Math.max(1, Math.round(row.w * scale)),
        h: Math.max(1, Math.round(row.h * scale)),
      });
      described.push({ src, alt: row.alt, ...colourOf(row.hex) });

      // The licence asks that keeping a picture be reported, and asks it of
      // whoever kept it. Fire and forget: a photograph that landed must not be
      // lost because a courtesy ping did not.
      if (row.report) void fetch(row.report).catch(() => {});
    }

    if (described.length) {
      await ctx.runMutation(internal.imageMeta.putPublished, {
        ownerId: owner,
        entries: described,
      });
    }
    return landed;
  },
});

/** `#rrggbb` as the columns `imageMeta` keeps colour in. */
function colourOf(hex: string): { hex: string; hue: number; sat: number; light: number } {
  const clean = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!clean) return { hex: "#808080", hue: 0, sat: 0, light: 50 };
  const n = Number.parseInt(clean[1], 16);
  const r = (n >> 16) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * light - 1));
  const hue =
    d === 0
      ? 0
      : max === r
        ? ((g - b) / d + (g < b ? 6 : 0)) * 60
        : max === g
          ? ((b - r) / d + 2) * 60
          : ((r - g) / d + 4) * 60;
  return {
    hex: `#${clean[1].toLowerCase()}`,
    hue: Math.round(hue),
    sat: Math.round(sat * 100),
    light: Math.round(light * 100),
  };
}
