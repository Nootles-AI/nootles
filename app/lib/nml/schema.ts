import { z } from "zod";
import { albumSchema } from "@/app/components/editor/album/schema";
import type { Album } from "@/app/components/editor/album/types";
import { sceneSchema } from "@/app/components/editor/canvas/scene/schema";
import type { Scene } from "@/app/components/editor/canvas/scene/types";
import { locationSchema } from "@/app/components/editor/location/schema";
import type { Location } from "@/app/components/editor/location/types";
import { storyboardSchema } from "@/app/components/editor/storyboard/schema";
import type { Storyboard } from "@/app/components/editor/storyboard/types";

export const NML_SCHEMA_VERSION = 1 as const;
export const NML_LIMITS = {
  maxBlockDepth: 4,
  maxBlocks: 10_000,
  maxInlineUtf16: 1_000_000,
  maxDomainBytes: 25 * 1024 * 1024,
} as const;

export const NML_MARKS = ["code", "bold", "italic", "strike", "underline"] as const;
export const nmlMarkSchema = z.enum(NML_MARKS);
export type NmlMark = z.infer<typeof nmlMarkSchema>;

export type NmlText = { type: "text"; text: string; marks: NmlMark[] };
export type NmlLink = { type: "link"; href: string; content: NmlText[] };
export type NmlMath = { type: "math"; id: string; latex: string };
export type NmlPageRef = {
  type: "pageRef";
  id: string;
  pageId: string;
  fallbackTitle: string;
};
export type NmlInline = NmlText | NmlLink | NmlMath | NmlPageRef;
export type NmlInlineContent = NmlInline[];

const idSchema = z.string().min(1);
const textSchema = z
  .object({ type: z.literal("text"), text: z.string(), marks: z.array(nmlMarkSchema) })
  .strict();
export const nmlInlineSchema: z.ZodType<NmlInline> = z.discriminatedUnion("type", [
  textSchema,
  z.object({ type: z.literal("link"), href: z.string(), content: z.array(textSchema) }).strict(),
  z.object({ type: z.literal("math"), id: idSchema, latex: z.string() }).strict(),
  z
    .object({
      type: z.literal("pageRef"),
      id: idSchema,
      pageId: idSchema,
      fallbackTitle: z.string(),
    })
    .strict(),
]);
export const nmlInlineContentSchema = z.array(nmlInlineSchema);

type Base<T extends string, P> = { id: string; type: T; props: P; children: NmlBlock[] };
export type NmlTextBlock = Base<"paragraph" | "quote", Record<string, never>> & {
  content: NmlInlineContent;
};
export type NmlHeadingBlock = Base<"heading", { level: 1 | 2 | 3 | 4 | 5 | 6 }> & {
  content: NmlInlineContent;
};
export type NmlListBlock = Base<
  "bulletListItem" | "numberedListItem" | "checkListItem" | "toggleListItem",
  { checked?: boolean; start?: number }
> & { content: NmlInlineContent };
export type NmlTableCell = { id: string; content: NmlInlineContent };
export type NmlTableRow = { id: string; cells: NmlTableCell[] };
export type NmlTableBlock = Base<"table", { headerRows: number }> & {
  columns: Array<{ id: string }>;
  rows: NmlTableRow[];
};
export type NmlCodeBlock = Base<"codeBlock", { language: string }> & { code: string };
export type NmlMathBlock = Base<"mathBlock", Record<string, never>> & {
  rows: Array<{ id: string; latex: string }>;
};
export type NmlDividerBlock = Base<"divider", Record<string, never>>;
export type NmlMediaSource =
  | { kind: "storage"; storageId: string }
  | { kind: "url"; url: string };
export type NmlMediaBlock = Base<
  "image" | "video" | "audio" | "file",
  { source?: NmlMediaSource; caption?: string; name?: string }
>;
export type NmlCanvasBlock = Base<"canvas", Record<string, never>> & { scene: Scene };
export type NmlAlbumBlock = Base<"album", Record<string, never>> & {
  domain: Album;
  legacyMarkup?: string;
};
export type NmlStoryboardBlock = Base<"storyboard", Record<string, never>> & {
  domain: Storyboard;
  legacyMarkup?: string;
};
export type NmlLocationBlock = Base<"location", Record<string, never>> & {
  domain: Location;
  legacyMarkup?: string;
};

export type NmlBlock =
  | NmlTextBlock
  | NmlHeadingBlock
  | NmlListBlock
  | NmlTableBlock
  | NmlCodeBlock
  | NmlMathBlock
  | NmlDividerBlock
  | NmlMediaBlock
  | NmlCanvasBlock
  | NmlAlbumBlock
  | NmlStoryboardBlock
  | NmlLocationBlock;

const emptyProps = z.object({}).strict();
const leafBase = { id: idSchema, children: z.array(z.never()).max(0) };
const content = { content: nmlInlineContentSchema };
const blockSchemaImpl: z.ZodType<NmlBlock> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ ...leafBase, ...content, type: z.literal("paragraph"), props: emptyProps }).strict(),
    z.object({ ...leafBase, ...content, type: z.literal("quote"), props: emptyProps }).strict(),
    z
      .object({
        ...leafBase,
        ...content,
        type: z.literal("heading"),
        props: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]) }).strict(),
      })
      .strict(),
    ...(["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"] as const).map(
      (type) =>
        z
          .object({
            id: idSchema,
            type: z.literal(type),
            props: z.object({ checked: z.boolean().optional(), start: z.number().int().positive().optional() }).strict(),
            content: nmlInlineContentSchema,
            children: z.array(blockSchemaImpl),
          })
          .strict(),
    ),
    z
      .object({
        ...leafBase,
        type: z.literal("table"),
        props: z.object({ headerRows: z.number().int().nonnegative() }).strict(),
        columns: z.array(z.object({ id: idSchema }).strict()),
        rows: z.array(
          z.object({ id: idSchema, cells: z.array(z.object({ id: idSchema, content: nmlInlineContentSchema }).strict()) }).strict(),
        ),
      })
      .strict(),
    z.object({ ...leafBase, type: z.literal("codeBlock"), props: z.object({ language: z.string() }).strict(), code: z.string() }).strict(),
    z.object({ ...leafBase, type: z.literal("mathBlock"), props: emptyProps, rows: z.array(z.object({ id: idSchema, latex: z.string() }).strict()) }).strict(),
    z.object({ ...leafBase, type: z.literal("divider"), props: emptyProps }).strict(),
    ...(["image", "video", "audio", "file"] as const).map((type) =>
      z
        .object({
          ...leafBase,
          type: z.literal(type),
          props: z
            .object({
              source: z
                .discriminatedUnion("kind", [
                  z.object({ kind: z.literal("storage"), storageId: idSchema }).strict(),
                  z.object({ kind: z.literal("url"), url: z.string() }).strict(),
                ])
                .optional(),
              caption: z.string().optional(),
              name: z.string().optional(),
            })
            .strict(),
        })
        .strict(),
    ),
    z.object({ ...leafBase, type: z.literal("canvas"), props: emptyProps, scene: sceneSchema }).strict(),
    z.object({ ...leafBase, type: z.literal("album"), props: emptyProps, domain: albumSchema, legacyMarkup: z.string().optional() }).strict(),
    z.object({ ...leafBase, type: z.literal("storyboard"), props: emptyProps, domain: storyboardSchema, legacyMarkup: z.string().optional() }).strict(),
    z.object({ ...leafBase, type: z.literal("location"), props: emptyProps, domain: locationSchema, legacyMarkup: z.string().optional() }).strict(),
  ] as never),
);

export const nmlBlockSchema = blockSchemaImpl;
export type NmlDocument = {
  schemaVersion: typeof NML_SCHEMA_VERSION;
  documentId: string;
  blocks: NmlBlock[];
};
export const nmlDocumentSchema: z.ZodType<NmlDocument> = z
  .object({ schemaVersion: z.literal(NML_SCHEMA_VERSION), documentId: idSchema, blocks: z.array(nmlBlockSchema) })
  .strict();

export type NmlIssue = {
  code: string;
  severity: "error" | "repair" | "warning";
  nodeId?: string;
  path: Array<string | number>;
  message: string;
  proposedRepair?: string;
};
