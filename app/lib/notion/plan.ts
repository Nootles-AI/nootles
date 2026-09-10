import type { NmlIssue } from "@/app/lib/nml/schema";

/**
 * A node of the Notion page tree the wizard shows, as the fetcher assembles it.
 * `title` is already flattened out of Notion's title property.
 */
export type NotionPageNode = {
  id: string;
  title: string;
  /** Emoji page icon, when the page has one. File icons are not carried yet. */
  emoji?: string;
  hasFileIcon?: boolean;
  children: NotionPageNode[];
};

/**
 * A row the import will create. Keys are placeholders, not Convex ids: the plan
 * is pure and the ids do not exist until the mutation inserts the rows, so the
 * plan names things and the mutation resolves those names.
 */
export type PlannedFolder = {
  key: string;
  title: string;
  parentKey?: string;
  order: number;
  emoji?: string;
};

export type PlannedPage = {
  key: string;
  notionId: string;
  title: string;
  /** Containing folder key; absent is the project's top level. */
  folderKey?: string;
  order: number;
  emoji?: string;
};

export type NotionImportPlan = {
  folders: PlannedFolder[];
  pages: PlannedPage[];
  diagnostics: NmlIssue[];
};

const UNTITLED = "Untitled";

/**
 * A selected Notion tree as Nootles rows.
 *
 * The shape question this answers: a Notion page is a document and a container
 * at once, and Nootles separates those — `Project → Page` is non-recursive, with
 * nestable folders for organisation (`convex/schema.ts:279`). So a page with
 * selected children becomes a **folder of the same name holding a page of the
 * same name**, with the children beside that page. It is the only arrangement
 * that keeps both the writing and the tree; naming the folder after the page is
 * what makes it read as one thing in the sidebar rather than two.
 *
 * Order is one line per level across folders and pages alike, matching how the
 * sidebar already orders its rows.
 */
export function planImport(
  roots: NotionPageNode[],
  selection: ReadonlySet<string>,
): NotionImportPlan {
  const folders: PlannedFolder[] = [];
  const pages: PlannedPage[] = [];
  const diagnostics: NmlIssue[] = [];
  let keys = 0;
  const key = (prefix: string) => `${prefix}-${++keys}`;

  const walk = (nodes: NotionPageNode[], parentKey: string | undefined, path: Array<string | number>) => {
    let order = 0;
    nodes.forEach((node, index) => {
      const here = [...path, index];
      const selectedChildren = node.children.filter((child) => containsSelection(child, selection));
      const selected = selection.has(node.id);

      if (!selected && !selectedChildren.length) return;

      const title = node.title.trim() || UNTITLED;
      if (node.hasFileIcon && !node.emoji) {
        diagnostics.push({
          code: "file_icon_dropped",
          severity: "warning",
          path: here,
          message: `The uploaded icon on "${title}" was not imported; the page uses the default glyph.`,
        });
      }

      // A leaf, or a page whose children were not selected: one plain page.
      if (!selectedChildren.length) {
        pages.push({ key: key("page"), notionId: node.id, title, folderKey: parentKey, order: order++, ...(node.emoji ? { emoji: node.emoji } : {}) });
        return;
      }

      // A container: a folder of the same name, holding this page and its children.
      const folderKey = key("folder");
      folders.push({ key: folderKey, title, parentKey, order: order++, ...(node.emoji ? { emoji: node.emoji } : {}) });
      let inner = 0;
      if (selected) {
        pages.push({ key: key("page"), notionId: node.id, title, folderKey, order: inner++, ...(node.emoji ? { emoji: node.emoji } : {}) });
      } else {
        diagnostics.push({
          code: "container_not_selected",
          severity: "warning",
          path: here,
          message: `"${title}" was not selected, but holds pages that were; it became a folder without a page of its own.`,
        });
      }
      walkInto(selectedChildren, folderKey, [...here, "children"], inner);
    });
  };

  const walkInto = (
    nodes: NotionPageNode[],
    parentKey: string,
    path: Array<string | number>,
    startOrder: number,
  ) => {
    const before = { folders: folders.length, pages: pages.length };
    walk(nodes, parentKey, path);
    // `walk` numbers each level from zero; shift this level past the page that
    // already sits in the folder.
    for (const folder of folders.slice(before.folders)) {
      if (folder.parentKey === parentKey) folder.order += startOrder;
    }
    for (const page of pages.slice(before.pages)) {
      if (page.folderKey === parentKey) page.order += startOrder;
    }
  };

  walk(roots, undefined, ["roots"]);
  return { folders, pages, diagnostics };
}

function containsSelection(node: NotionPageNode, selection: ReadonlySet<string>): boolean {
  return selection.has(node.id) || node.children.some((child) => containsSelection(child, selection));
}

/**
 * The converter's `resolvePage`, once the mutation knows which Convex page each
 * Notion page became. Links to anything outside the map stay links to Notion.
 */
export function pageIdResolver(
  byNotionId: ReadonlyMap<string, string>,
): (notionPageId: string) => string | undefined {
  // Notion hands ids back in both dashed and undashed form depending on the
  // surface, and a mention that missed by a hyphen would silently become an
  // external link.
  const bare = new Map<string, string>();
  for (const [notionId, pageId] of byNotionId) bare.set(notionId.replace(/-/g, ""), pageId);
  return (notionPageId: string) => byNotionId.get(notionPageId) ?? bare.get(notionPageId.replace(/-/g, ""));
}
