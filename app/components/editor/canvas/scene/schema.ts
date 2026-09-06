import { z } from "zod";
import { labelRuns, runsToLabel } from "./label";
import type { Scene, SceneNode } from "./types";

const stringMap = z.record(z.string(), z.string());
const finite = z.number().finite();
const canonicalLabel = z.string().refine((label) => runsToLabel(labelRuns(label)) === label, {
  message: "Canvas labels must use canonical escaped text, <b>, and <nt-ref> markup.",
});
const base = {
  id: z.string().min(1),
  x: finite,
  y: finite,
  w: finite.nonnegative(),
  h: finite.nonnegative(),
  rot: finite,
  style: stringMap,
  label: canonicalLabel,
  name: z.string().optional(),
  locked: z.boolean(),
  hidden: z.boolean(),
  attrs: stringMap,
};

export const sceneNodeSchema: z.ZodType<SceneNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ ...base, kind: z.literal("rect") }).strict(),
    z
      .object({
        ...base,
        kind: z.literal("ellipse"),
        start: finite.optional(),
        sweep: finite.min(-360).max(360).optional(),
        inner: finite.min(0).max(1).optional(),
      })
      .strict(),
    z.object({ ...base, kind: z.literal("polygon"), sides: z.number().int().min(3) }).strict(),
    z.object({ ...base, kind: z.literal("text") }).strict(),
    z.object({ ...base, kind: z.literal("image"), src: z.string() }).strict(),
    z.object({ ...base, kind: z.literal("path"), d: z.string() }).strict(),
    z.object({ ...base, kind: z.literal("group"), children: z.array(sceneNodeSchema) }).strict(),
  ]),
);

export const sceneSchema: z.ZodType<Scene> = z
  .object({
    w: finite.nonnegative(),
    h: finite.nonnegative(),
    style: stringMap,
    nodes: z.array(sceneNodeSchema),
    edges: z.array(
      z
        .object({
          id: z.string().min(1),
          from: z.string().min(1),
          to: z.string().min(1),
          label: z.string(),
          style: stringMap,
          attrs: stringMap,
        })
        .strict(),
    ),
    id: z.string().min(1).optional(),
    attrs: stringMap,
  })
  .strict();
