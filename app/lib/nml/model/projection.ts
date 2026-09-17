import { project, type AnyBlock, type DocIndex, type ProjectOptions } from "@/app/lib/ai/projection";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { serializeAlbum } from "@/app/components/editor/album/serialize";
import { serializeStoryboard } from "@/app/components/editor/storyboard/serialize";
import { serializeLocation } from "@/app/components/editor/location/serialize";
import type { NmlBlock, NmlDocument, NmlInlineContent, NmlMark } from "../schema";

/**
 * The model read projection for a *served* NML document.
 *
 * Parity is by construction, not by reimplementation: an NML AST node carries
 * exactly the facts `app/lib/ai/projection.ts` reads off a BlockNote block, so
 * this module adapts the AST into the same denormalized `AnyBlock` shape and
 * hands it to the one canonical `project()`. The projector — every ⟦id⟧ tag,
 * every markdown-ish line, the reverse `DocIndex` — is shared with the legacy
 * path, which is what makes `projectNmlDocument` and `project(legacyBlocks)`
 * produce byte-identical output (proved fixture-by-fixture in
 * `projection.test.ts`). It is the AI's read surface on a served doc *and* MCP
 * Phase 3's `read_doc`.
 *
 * The adapter is the projection-relevant inverse of `legacy.ts`: it only has to
 * reproduce the fields `project()` consumes (inline runs, `props.data` domain
 * markup, `props.code`/`source`/`level`), reusing the existing domain
 * serializers so canvas/album/storyboard/location read back through the same
 * parsers the legacy projection uses.
 *
 * Two limits are inherent to the projector, not this adapter, and are therefore
 * NOT closed here (matching legacy behaviour exactly is the parity goal):
 *   - `notionStub` has no NML representation, so a migrated doc has none to
 *     project (import artifact; would need schema support to carry through).
 *   - `project()` does not emit table-cell text for any document, legacy or
 *     NML, so a table projects as a bare id tag on both paths.
 */

function stylesFromMarks(marks: NmlMark[]): Record<string, boolean> {
  const styles: Record<string, boolean> = {};
  for (const mark of marks) styles[mark] = true;
  return styles;
}

function textRun(text: string, marks: NmlMark[]) {
  return { type: "text" as const, text, styles: stylesFromMarks(marks) };
}

/** NML inline → the BlockNote inline JSON `project()`'s `inlineToText`/`runsText` read. */
function inlineContent(content: NmlInlineContent): unknown[] {
  return content.map((node) => {
    switch (node.type) {
      case "text":
        return textRun(node.text, node.marks);
      case "link":
        return { type: "link" as const, href: node.href, content: node.content.map((t) => textRun(t.text, t.marks)) };
      case "math":
        return { type: "math" as const, props: { latex: node.latex } };
      case "pageRef":
        return { type: "pageMention" as const, props: { pageId: node.pageId, title: node.fallbackTitle } };
    }
  });
}

function mediaUrl(source: { kind: "url"; url: string } | { kind: "storage"; storageId: string } | undefined): string {
  // `project()` reads `props.url` only. A storage-kind source has no synchronous
  // URL here (the resolver lives in the view), so it projects as empty — matching
  // an unresolved media block. Migration never produces storage-kind sources.
  return source?.kind === "url" ? source.url : "";
}

/** One NML block → the denormalized `AnyBlock` `project()` consumes. */
export function nmlBlockToAnyBlock(block: NmlBlock): AnyBlock {
  const children = block.children.map(nmlBlockToAnyBlock);
  switch (block.type) {
    case "paragraph":
    case "quote":
      return { id: block.id, type: block.type, props: {}, content: inlineContent(block.content), children };
    case "heading":
      return { id: block.id, type: "heading", props: { level: block.props.level }, content: inlineContent(block.content), children };
    case "bulletListItem":
    case "numberedListItem":
    case "checkListItem":
    case "toggleListItem":
      return { id: block.id, type: block.type, props: { ...block.props }, content: inlineContent(block.content), children };
    case "table":
      // `project()` has no table case; it falls to the default and reads
      // `block.content`, which is absent here — a bare id tag, same as legacy.
      return { id: block.id, type: "table", props: { headerRows: block.props.headerRows }, children };
    case "codeBlock":
      // BlockNote carries an (empty) inline content array on code/math blocks, so
      // the legacy index reports `hasContent: true` for them; mirror that here.
      return { id: block.id, type: "codeBlock", props: { language: block.props.language, code: block.code }, content: [], children };
    case "mathBlock":
      return { id: block.id, type: "mathBlock", props: { source: block.rows.map((row) => row.latex).join("\n") }, content: [], children };
    case "divider":
      return { id: block.id, type: "divider", props: {}, children };
    case "image":
    case "video":
    case "audio":
    case "file":
      return {
        id: block.id,
        type: block.type,
        props: { url: mediaUrl(block.props.source), caption: block.props.caption ?? "", name: block.props.name ?? "" },
        children,
      };
    case "canvas":
      return { id: block.id, type: "canvas", props: { data: serializeScene(block.scene) }, children };
    case "album":
      return { id: block.id, type: "album", props: { data: serializeAlbum(block.domain) }, children };
    case "storyboard":
      return { id: block.id, type: "storyboard", props: { data: serializeStoryboard(block.domain) }, children };
    case "location":
      return { id: block.id, type: "location", props: { data: serializeLocation(block.domain) }, children };
  }
}

/** Adapt a whole NML document to the `AnyBlock[]` tree `project()` consumes. */
export function nmlToAnyBlocks(doc: NmlDocument): AnyBlock[] {
  return doc.blocks.map(nmlBlockToAnyBlock);
}

/**
 * The model-facing read of a served NML document: identical text + `DocIndex` to
 * `project()` on the legacy block tree, so every AI lane and MCP `read_doc`
 * consumes one projection regardless of which tree backs the doc.
 */
export function projectNmlDocument(doc: NmlDocument, opts: ProjectOptions = {}): { text: string; index: DocIndex } {
  return project(nmlToAnyBlocks(doc), opts);
}
