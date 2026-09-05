"use client";

import { useEffect, useState, type RefObject } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ContextMenu } from "@/app/components/ContextMenu";
import { MenuItem } from "@/app/components/Menu";
import { importReferencedPage } from "@/app/lib/notion/importRun";
import type { PageProgress } from "@/app/lib/notion/importRun";
import { notionPageIdFrom } from "@/app/lib/notion/notionUrl";
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
 */

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

  /**
   * A native listener on the document, in the capture phase.
   *
   * React's synthetic capture was not enough: it is delivered from React's own
   * root container, and the anchor's navigation still went ahead. A real
   * capture listener on the document runs before every other handler and before
   * the default action, and `stopImmediatePropagation` closes the last gap —
   * whatever else is listening, on either system, does not get the click.
   *
   * Scoped to anchors inside this editor's surface, so a Notion link anywhere
   * else in the app stays an ordinary link.
   */
  useEffect(() => {
    const onClick = (event: globalThis.MouseEvent) => {
      // A modified click is the reader asking for a new tab explicitly. That is
      // an answer already, so it is not interrupted with a question.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href]");
      if (!anchor || !surface.current?.contains(anchor)) return;
      const href = anchor.getAttribute("href") ?? "";
      const notionPageId = notionPageIdFrom(href);
      if (!notionPageId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPending({
        href,
        notionPageId,
        label: pageTitle(anchor.textContent ?? ""),
        x: event.clientX,
        y: event.clientY,
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [surface]);

  const close = () => {
    setPending(null);
    setRunning(null);
  };

  const openInNotion = (href: string) => {
    window.open(href, "_blank", "noopener,noreferrer");
    close();
  };

  const importHere = async (target: Pending) => {
    if (!page) return;
    const { pageId: made, progress } = await importReferencedPage(client, {
      projectId: page.projectId,
      ...(page.folderId ? { folderId: page.folderId } : {}),
      notionPageId: target.notionPageId,
      title: target.label,
      onProgress: setRunning,
    });
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
        <p className="nt-notion-following">
          {running.state === "failed"
            ? (running.error ?? "That page could not be imported.")
            : label(running.state)}
        </p>
      ) : (
        <>
          {!readOnly && page && (
            <MenuItem onClick={() => void importHere(pending)}>
              Import here and link
            </MenuItem>
          )}
          <MenuItem onClick={() => openInNotion(pending.href)}>Open in Notion</MenuItem>
        </>
      )}
    </ContextMenu>
  ) : null;

  return { menu };
}

function label(state: PageProgress["state"]): string {
  if (state === "copying") return "Copying files…";
  if (state === "writing") return "Writing the page…";
  return "Reading Notion…";
}

/**
 * Turn every link to the page we just imported into an ordinary page chip.
 *
 * Every one, not only the one clicked: the same page is often referenced more
 * than once, and leaving the others pointing at Notion would make the document
 * disagree with itself about where that page lives. Written through
 * `updateBlock`, which is the call a person's own edit makes.
 */
function relink(editor: Editor, href: string, pageId: Id<"pages">, title: string): void {
  for (const block of editor.document) {
    const content = block.content;
    if (!Array.isArray(content)) continue;
    let changed = false;
    const next = content.map((item: { type: string; href?: string }) => {
      if (item.type !== "link" || item.href !== href) return item;
      changed = true;
      return { type: "pageMention", props: { pageId, title } };
    });
    if (changed) editor.updateBlock(block.id, { content: next });
  }
}
