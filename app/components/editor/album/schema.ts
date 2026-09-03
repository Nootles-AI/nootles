import { z } from "zod";
import { MAX_COLS, type Album } from "./types";

const positiveInt = z.number().int().positive();

const originSchema = z
  .object({
    src: z.string().min(1),
    w: positiveInt,
    h: positiveInt,
    poster: z.string().min(1).optional(),
  })
  .strict();

export const albumItemSchema = z
  .object({
    kind: z.enum(["image", "video"]),
    src: z.string().min(1),
    w: positiveInt,
    h: positiveInt,
    span: positiveInt.max(MAX_COLS).optional(),
    poster: z.string().min(1).optional(),
    of: originSchema.optional(),
  })
  .strict();

export const albumSchema: z.ZodType<Album> = z
  .object({
    items: z.array(albumItemSchema),
    id: z.string().min(1).optional(),
    w: positiveInt.optional(),
    cols: positiveInt.max(MAX_COLS).optional(),
  })
  .strict();
