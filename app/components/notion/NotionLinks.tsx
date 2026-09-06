"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useConvex, useQuery } from "convex/react";
import { NodeSelection, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ContextMenu } from "@/app/components/ContextMenu";
import { MenuItem } from "@/app/components/Menu";
import { FileDoc } from "@/app/components/Icons";
import { NotionMark } from "@/app/components/NotionMark";
import { importReferencedPage } from "@/app/lib/notion/importRun";
import type { PageProgress } from "@/app/lib/notion/importRun";
import { isNotionBlockHref, notionPageIdFrom } from "@/app/lib/notion/notionUrl";
import { PageStep } from "./Progress";
import "./notion.css";
import { pageTitle } from "@/app/components/editor/inline/PageMention";

/**
 * Following a reference to a Notion page that was not imported.
 *
 * An import leaves these behind on purpose: it brings the pages you ticked, and
 * a link to one you did not is the truth about what you have. But the reader
 * meeting that link is asking a question the document cannot answer — is this
 * thing here, or over there? — and the two useful answers are different enough
 * that guessing between them is worse than asking.
 *
 * So the link stops being a link for one beat. "Import here" pulls the page in
 * beside this one and turns the link into an ordinary page chip; "Open in
 * Notion" does what an untouched link always did. Nothing is decided for you,
 * and the choice is only ever offered on a link we can actually name a page
 * inside.
 *
 * The offer is raised two ways, because a click is not the only way to reach a
 * link: Mod+Enter with the caret inside one raises the same menu, anchored at
 * the link, and the same key on a selected stub block opens the block's way
 * back to Notion. One key, "follow the Notion reference under the caret".
 */

/**
 * The live surface's link handler, if one is mounted.
 *
 * `notionLinkClick` is what the editor is configured with; it answers `false`
 * whenever no surface has claimed the click, which is BlockNote's way of being
 * told to carry on and open the link as it always did.
 */
let active: ((event: globalThis.MouseEvent) => boolean) | null = null;

export function notionLinkClick(event: globalThis.MouseEvent): boolean {
  return active?.(event) ?? false;
}

type Pending = {
  href: string;
  notionPageId: string;
  label: string;
  x: number;
  y: number;
};

// The editor is schema-generic here for the same reason the applier is.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = any;

export function useNotionLinks({
  editor,
  pageId,
  readOnly,
  surface,
}: {
  editor: Editor;
  pageId?: Id<"pages">;
  readOnly: boolean;
  /** The editor surface; only links inside it are ours to intercept. */
  surface: RefObject<HTMLElement | null>;
}) {
  const client = useConvex();
  const page = useQuery(api.pages.get, pageId ? { pageId } : "skip");
  const [pending, setPending] = useState<Pending | null>(null);
  const [running, setRunning] = useState<PageProgress | null>(null);
  const follow = useRef<AbortController | null>(null);
  const openItem = useRef<HTMLButtonElement>(null);

  /**
   * Raise the offer for a link, if it is one we can name a page inside.
   * Answers whether it was raised, so a caller can hand an unclaimed link
   * back to whatever it interrupted.
   */
  const offer = useCallback((href: string, label: string, x: number, y: number): boolean => {
    // A link to a block inside a page is an ordinary link: not a page, so
    // nothing to offer.
    if (isNotionBlockHref(href)) return false;
    const notionPageId = notionPageIdFrom(href);
    if (!notionPageId) return false;
    setPending({ href, notionPageId, label: pageTitle(label), x, y });
    return true;
  }, []);

  /**
   * BlockNote's own link-click seam.
   *
   * Its Link extension opens links itself — `window.open`, from a ProseMirror
   * click handler — so neither React's synthetic capture nor a real capture
   * listener on the document reliably got there first. The library provides
   * `links.onClick` for exactly this: supply one and the default open is
   * disabled, and returning `false` hands the click straight back.
   *
   * Registered through a module slot rather than a prop because the editor is
   * constructed a level above this surface, and its options are built before
   * any of this state exists. One slot is enough: one document is open at a
   * time, and the effect's cleanup is what makes that true rather than hopeful.
   */
  useEffect(() => {
    active = (event) => {
      // A modified click is the reader asking for a new tab explicitly. That is
      // an answer already, so it is not interrupted with a question.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href]");
      if (!anchor || !surface.current?.contains(anchor)) return false;
      const href = anchor.getAttribute("href") ?? "";
      return offer(href, anchor.textContent ?? "", event.clientX, event.clientY);
    };
    return () => {
      active = null;
    };
  }, [offer, surface]);

  /**
   * The same offer from the keyboard.
   *
   * Heard in the capture phase on the surface, ahead of ProseMirror's own
   * keymaps, and claimed only when there is a Notion reference to follow —
   * every other Mod+Enter goes on to whoever wanted it. A stub block has one
   * answer, so it is opened outright; a link has two, so the menu is raised
   * where the link is and takes focus, the way it does from a click.
   */
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey || event.isComposing) return;
      const view = editor.prosemirrorView as EditorView | undefined;
      if (!view) return;
      const { selection } = view.state;

      if (selection instanceof NodeSelection && selection.node.type.name === "notionStub") {
        const href = String(selection.node.attrs.href ?? "");
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        window.open(href, "_blank", "noopener,noreferrer");
        return;
      }

      const link = linkAtCaret(view.state);
      if (!link) return;
      const { left, bottom } = view.coordsAtPos(link.from);
      if (!offer(link.href, link.text, left, bottom)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    el.addEventListener("keydown", onKey, true);
    return () => el.removeEventListener("keydown", onKey, true);
  }, [editor, offer, surface]);

  // A follow still running when the document goes away is abandoned with it.
  useEffect(() => () => follow.current?.abort(), []);

  /**
   * Every way out of the menu comes through here, so every one of them gives
   * the caret back: the menu took focus, and a reader who pressed Escape
   * should be where they were, not on the page body. Closing also stops a
   * follow in progress — the menu is the only place its progress is shown,
   * and an import that carries on after its status has gone would land a
   * page nobody watched arrive.
   */
  const close = () => {
    follow.current?.abort();
    follow.current = null;
    setPending(null);
    setRunning(null);
    editor.focus();
  };

  const openInNotion = (href: string) => {
    window.open(href, "_blank", "noopener,noreferrer");
    close();
  };

  const importHere = async (target: Pending) => {
    if (!page) return;
    // The item just pressed is about to give way to the progress line; focus
    // moves to the item that stays, so the menu keeps it.
    openItem.current?.focus();
    const controller = new AbortController();
    follow.current = controller;
    const { pageId: made, progress } = await importReferencedPage(client, {
      projectId: page.projectId,
      ...(page.folderId ? { folderId: page.folderId } : {}),
      notionPageId: target.notionPageId,
      title: target.label,
      onProgress: setRunning,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    follow.current = null;
    if (progress.state === "done") {
      relink(editor, target.href, made, target.label);
      close();
    } else {
      setRunning(progress);
    }
  };

  const menu = pending ? (
    <ContextMenu x={pending.x} y={pending.y} label="Notion page" onClose={close}>
      {running ? (
        // The step, where the item that started it was: the reader is
        // already looking here, and a region that announces its changes is
        // the only way the step reaches a reader who cannot see it.
        <p role="status" className="nt-notion-following" data-state={running.state}>
          <PageStep page={running} />
        </p>
      ) : (
        !readOnly &&
        page && (
          <MenuItem onClick={() => void importHere(pending)}>
            <span className="nt-notion-menu-icon" aria-hidden>
              <FileDoc width={14} height={14} />
            </span>
            Import here and link
          </MenuItem>
        )
      )}
      {/* Present throughout, so the menu is never a menu with nothing in it
          and focus always has an item to sit on. The two glyphs carry the
          actual distinction: one ends as a page in this project, the other
          goes back to where it still lives. */}
      <MenuItem ref={openItem} onClick={() => openInNotion(pending.href)}>
        <span className="nt-notion-menu-icon" aria-hidden>
          <NotionMark width={14} height={14} />
        </span>
        Open in Notion
      </MenuItem>
    </ContextMenu>
  ) : null;

  return { menu };
}

/**
 * The link the caret is in, if any: its address, its whole text, and where it
 * starts. Walks the caret's own textblock, grouping the runs of text that
 * carry one link mark to one address, and answers with the run the caret
 * sits in or at either edge of.
 */
function linkAtCaret(state: EditorState): { href: string; text: string; from: number } | null {
  if (state.selection instanceof NodeSelection) return null;
  const type = state.schema.marks.link;
  const { $from } = state.selection;
  if (!type || !$from.parent.isTextblock) return null;
  const at = $from.parentOffset;
  const base = $from.start();

  let hit: { href: string; text: string; from: number } | null = null;
  let run: { href: string; text: string; from: number; to: number } | null = null;
  $from.parent.forEach((node, offset) => {
    const mark = type.isInSet(node.marks);
    const href = mark ? String(mark.attrs.href ?? "") : null;
    if (href !== null && run && run.href === href && run.to === offset) {
      run.text += node.textContent;
      run.to = offset + node.nodeSize;
    } else {
      run =
        href === null
          ? null
          : { href, text: node.textContent, from: offset, to: offset + node.nodeSize };
    }
    if (run && run.from <= at && at <= run.to) {
      hit = { href: run.href, text: run.text, from: base + run.from };
    }
  });
  return hit;
}

/**
 * Turn every link to the page we just imported into an ordinary page chip.
 *
 * Every one, not only the one clicked: the same page is often referenced more
 * than once, and leaving the others pointing at Notion would make the document
 * disagree with itself about where that page lives. Every block, too, at any
 * depth — a reference inside a list item is no less a reference. Written
 * through `updateBlock`, which is the call a person's own edit makes.
 */
function relink(editor: Editor, href: string, pageId: Id<"pages">, title: string): void {
  editor.forEachBlock((block: { id: string; content: unknown }) => {
    const content = block.content;
    if (Array.isArray(content)) {
      let changed = false;
      const next = content.map((item: { type: string; href?: string }) => {
        if (item.type !== "link" || item.href !== href) return item;
        changed = true;
        return { type: "pageMention", props: { pageId, title } };
      });
      if (changed) editor.updateBlock(block.id, { content: next });
    }
    return true;
  });
}
