"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { PageNode } from "../_kit/data";
import { useUi } from "../_kit/store";
import { Item, Pop } from "../_kit/overlays";
import { ChevronDown, FileDoc, Folder, MoreHorizontal, Plus } from "../_kit/icons";
import { PageMenuItems } from "../_kit/Shell";

function Tab({ page }: { page: PageNode }) {
  const { ui, act } = useUi();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [more, setMore] = useState(false);
  const dots = useRef<HTMLButtonElement>(null);
  const active = ui.pageId === page.id;
  const name = page.title || "Untitled";
  return (
    <div
      className="m-tab"
      role="presentation"
      data-active={active}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {ui.renaming === page.id ? (
        <div className="m-tab-open">
          <FileDoc width={14} height={14} />
          <input
            autoFocus
            aria-label="Page name"
            defaultValue={page.title}
            placeholder="Untitled"
            className="m-tab-edit"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => act.renamePage(page.id, e.currentTarget.value.trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") act.set({ renaming: null });
            }}
          />
        </div>
      ) : (
        <button type="button" role="tab" aria-selected={active} className="m-tab-open" onClick={() => act.openPage(page.id)} onDoubleClick={() => act.set({ renaming: page.id })}>
          <FileDoc width={14} height={14} />
          <span>{name}</span>
        </button>
      )}
      {active && ui.renaming !== page.id && (
        <button ref={dots} type="button" aria-label={`Actions for ${name}`} aria-expanded={more} className="ek-icon-btn is-sm m-tab-more" onClick={() => setMore((o) => !o)}>
          <MoreHorizontal width={14} height={14} />
        </button>
      )}
      <Pop open={more} onClose={() => setMore(false)} anchor={dots} label="Page actions">
        <PageMenuItems page={page} />
      </Pop>
      <Pop open={menu !== null} onClose={() => setMenu(null)} anchor={menu ?? { x: 0, y: 0 }} gap={2} label="Page actions">
        <PageMenuItems page={page} />
      </Pop>
    </div>
  );
}

function FolderTab({ name, pages }: { name: string; pages: PageNode[] }) {
  const { ui, act } = useUi();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const inside = pages.find((p) => p.id === ui.pageId);
  return (
    <div className="m-tab" role="presentation" data-active={inside !== undefined}>
      <button ref={anchor} type="button" role="tab" aria-selected={inside !== undefined} aria-haspopup="menu" aria-expanded={open} className="m-tab-open" onClick={() => setOpen((o) => !o)}>
        <Folder width={14} height={14} />
        <span>{inside ? `${name} / ${inside.title || "Untitled"}` : name}</span>
        <span className="ek-meta">{pages.length}</span>
        <ChevronDown width={12} height={12} className="m-tab-caret" />
      </button>
      <Pop open={open} onClose={() => setOpen(false)} anchor={anchor} label={`Pages in ${name}`} className="ek-pop-wide">
        {pages.map((p) => (
          <Item key={p.id} icon={<FileDoc width={14} height={14} />} label={p.title || "Untitled"} checked={p.id === ui.pageId} onSelect={() => act.openPage(p.id)} />
        ))}
      </Pop>
    </div>
  );
}

/**
 * Pages as index tabs on the sheet's top edge. One piece of paper travels
 * between them: the tab that is open is the sheet, continued upward.
 */
export function PageTabs() {
  const { ui, act } = useUi();
  const strip = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const tab = el.querySelector<HTMLElement>('.m-tab[data-active="true"]');
      el.dataset.marked = String(tab !== null);
      if (!tab) return;
      el.style.setProperty("--mark-x", `${tab.offsetLeft}px`);
      el.style.setProperty("--mark-w", `${tab.offsetWidth}px`);
    };
    measure();
    el.querySelector<HTMLElement>('.m-tab[data-active="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
    // The face swaps in after first paint and a rename changes a width.
    const watch = new ResizeObserver(measure);
    el.querySelectorAll(".m-tab").forEach((t) => watch.observe(t));
    return () => watch.disconnect();
  }, [ui.pageId, ui.pages, ui.renaming]);

  const top = ui.pages.filter((p) => !p.folder);
  const research = ui.pages.filter((p) => p.folder === "Research");
  return (
    <div ref={strip} className="m-tabs ek-stagger" role="tablist" aria-label="Pages">
      <span className="m-tab-mark" aria-hidden />
      {top.slice(0, 3).map((p) => (
        <Tab key={p.id} page={p} />
      ))}
      {research.length > 0 && <FolderTab name="Research" pages={research} />}
      {top.slice(3).map((p) => (
        <Tab key={p.id} page={p} />
      ))}
      <button type="button" className="ek-icon-btn is-sm m-tab-add" aria-label="New page" data-tip="New page" onClick={act.addPage}>
        <Plus width={14} height={14} />
      </button>
    </div>
  );
}
