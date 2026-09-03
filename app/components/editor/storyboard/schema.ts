import { z } from "zod";
import { RATIOS, type Storyboard } from "./types";

const ratioSchema = z.enum(RATIOS.map(({ id }) => id) as [
  (typeof RATIOS)[number]["id"],
  ...(typeof RATIOS)[number]["id"][],
]);

export const storyboardSchema: z.ZodType<Storyboard> = z
  .object({
    ratio: ratioSchema,
    shots: z.array(z.object({ scene: z.string(), note: z.string() }).strict()),
    w: z.number().int().positive().optional(),
    cols: z.number().int().positive().optional(),
    id: z.string().min(1).optional(),
  })
  .strict();
