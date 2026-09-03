import { z } from "zod";
import { PARTS, type Location } from "./types";

export const locationSchema: z.ZodType<Location> = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string(),
    address: z.string().optional(),
    at: z.object({ lat: z.number().finite(), lng: z.number().finite() }).strict().optional(),
    place: z.string().optional(),
    rating: z.number().min(0).max(5).optional(),
    votes: z.number().int().nonnegative().optional(),
    note: z.string().optional(),
    images: z.array(
      z.object({ src: z.string().min(1), off: z.boolean().optional() }).strict(),
    ),
    off: z.array(z.enum(PARTS)),
  })
  .strict();
