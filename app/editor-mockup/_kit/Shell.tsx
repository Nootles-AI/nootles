"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { project, type PageNode } from "./data";
import { useUi } from "./store";
import { IconBtn } from "./controls";
import { Item, Pop, Sep } from "./overlays";
import {
  ArrowLeft,
  ChevronRight,
  Context,
  Copy,
  Duplicate,
  FileDoc,
  Folder,
  FolderPlus,
  Keyboard,
  LinkIcon,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sparkle,
  Trash,
} from "./icons";
import { Face, SharePanel } from "./Share";

export { Face };

export function BackLink({ label = "Projects" }: { label?: string }) {
  return (
    <Link href="/" className="ek-row ek-back" data-tip="All projects" data-tip-side="bottom">
      <ArrowLeft width={14} height={14} />
      <span>{label}</span>
    </Link>
  );
}

export function ProjectTitle({ className = "" }: { className?: string }) {
  const [title, setTitle] = useState(project.title);
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <div className={`ek-row ek-project ${className}`}>
        <input
          autoFocus
          aria-label="Project name"
          defaultValue={title}
          className="ek-row-edit"
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            setTitle(e.currentTarget.value.trim() || title);
            setEditing(false);
          }}
          onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()}
        />
      </div>
    );
  return (
    <button type="button" className={`ek-row ek-project ${className}`} data-tip="Double-click to rename" data-tip-side="bottom" onDoubleClick={() => setEditing(true)}>
      {title}
    </button>
  );
}

export function ContextRow() {
  return (
    <button type="button" className="ek-row ek-context" data-tip="What the assistant knows about this project">
      <Context width={14} height={14} />
      <span className="ek-row-label">Context</span>
      <span className="ek-meta">2 repos · 4 files</span>
    </button>
  );
}

/** The find field: a button dressed as one, as on the projects screen. */
export function FindButton({ compact }: { compact?: boolean }) {
  const { act } = useUi();
  return (
    <button type="button" className="ek-find" data-compact={compact || undefined} aria-label="Find a page or an action" onClick={() => act.set({ palette: true })}>
      <Search width={14} height={14} />
      {!compact && <span>Find or do…</span>}
      <kbd className="ek-kbd">⌘K</kbd>
    </button>
  );
}

export function ShareButton({ filled }: { filled?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={filled ? "ek-btn is-ink" : "ek-icon-btn"}
        aria-label="Share project"
        data-tip={filled ? undefined : "Share project"}
        data-tip-side="bottom"
        onClick={() => setOpen((o) => !o)}
      >
        {filled ? "Share" : <LinkIcon width={16} height={16} />}
      </button>
      <Pop open={open} onClose={() => setOpen(false)} anchor={anchor} align={filled ? "end" : "start"} role="dialog" label="Share project" className="ek-pop-share" exitMs={160}>
        <SharePanel />
      </Pop>
    </>
  );
}

export function Facepile() {
  return (
    <div className="ek-facepile ek-stagger" role="group" aria-label="Also here">
      <Face id="maya" />
      <Face id="jonas" />
    </div>
  );
}

export function Account({ align = "start" }: { align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { act } = useUi();
  return (
    <>
      <button ref={anchor} type="button" className="ek-account" aria-label="Account — Ali Hosseini" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Face id="you" size={24} />
      </button>
      <Pop open={open} onClose={() => setOpen(false)} anchor={anchor} align={align} label="Account">
        <div className="ek-pop-who">
          <Face id="you" size={32} />
          <span>
            <b>Ali Hosseini</b>
            <i>Free run · 1 of 2 projects left</i>
          </span>
        </div>
        <Sep />
        <Item icon={<Settings width={16} height={16} />} label="Settings" />
        <Item icon={<Keyboard />} label="Keyboard shortcuts" keys="?" onSelect={() => act.set({ sheet: "shortcuts" })} />
        <Item icon={<Sparkle width={16} height={16} />} label="Upgrade" hint="Unlimited projects and conversations" />
        <Sep />
        <Item label="Sign out" />
      </Pop>
    </>
  );
}

function PageName({ page }: { page: PageNode }) {
  const { ui, act } = useUi();
  if (ui.renaming !== page.id) return <span className="ek-row-label">{page.title || "Untitled"}</span>;
  return (
    <input
      autoFocus
      aria-label="Page name"
      defaultValue={page.title}
      placeholder="Untitled"
      className="ek-row-edit"
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => act.renamePage(page.id, e.currentTarget.value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") act.set({ renaming: null });
      }}
    />
  );
}

export function PageMenuItems({ page }: { page: PageNode }) {
  const { act } = useUi();
  return (
    <>
      <Item icon={<Plus width={16} height={16} />} label="New page" onSelect={act.addPage} />
      <Item icon={<FolderPlus width={16} height={16} />} label="New folder" />
      <Sep />
      <Item icon={<Copy />} label="Copy" keys="⌘C" onSelect={() => act.toast("Copied 1 page")} />
      <Item icon={<Duplicate />} label="Duplicate" keys="⌘D" />
      <Sep />
      <Item label="Rename" keys="↵" onSelect={() => act.set({ renaming: page.id })} />
      <Item label="Change icon…" />
      <Sep />
      <Item icon={<Trash width={16} height={16} />} label="Delete page" danger onSelect={() => act.set({ sheet: "delete", target: page.id })} />
    </>
  );
}

function PageRow({ page, depth = 0 }: { page: PageNode; depth?: number }) {
  const { ui, act } = useUi();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [more, setMore] = useState(false);
  const dots = useRef<HTMLButtonElement>(null);
  const current = ui.pageId === page.id;
  return (
    <li
      className="ek-page"
      data-current={current}
      data-page={page.id}
      style={{ "--depth": depth } as CSSProperties}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {ui.renaming === page.id ? (
        <div className="ek-row ek-page-open">
          <FileDoc width={14} height={14} className="ek-row-icon" />
          <PageName page={page} />
        </div>
      ) : (
        <button type="button" className="ek-row ek-page-open" aria-current={current ? "page" : undefined} onClick={() => act.openPage(page.id)} onDoubleClick={() => act.set({ renaming: page.id })}>
          <FileDoc width={14} height={14} className="ek-row-icon" />
          <PageName page={page} />
        </button>
      )}
      <button ref={dots} type="button" aria-label={`Actions for ${page.title || "Untitled"}`} aria-expanded={more} className="ek-icon-btn is-sm ek-page-more" onClick={() => setMore((o) => !o)}>
        <MoreHorizontal width={14} height={14} />
      </button>
      <Pop open={more} onClose={() => setMore(false)} anchor={dots} label="Page actions">
        <PageMenuItems page={page} />
      </Pop>
      <Pop open={menu !== null} onClose={() => setMenu(null)} anchor={menu ?? { x: 0, y: 0 }} gap={2} label="Page actions">
        <PageMenuItems page={page} />
      </Pop>
    </li>
  );
}

/**
 * The pages of the project. One highlight travels between rows rather than
 * each row owning its own: what moves is the selection, and it should look it.
 */
export function Pages() {
  const { ui, act } = useUi();
  const list = useRef<HTMLUListElement>(null);
  const [folded, setFolded] = useState(false);

  useLayoutEffect(() => {
    const ul = list.current;
    const row = ul?.querySelector<HTMLElement>(`[data-page="${ui.pageId}"]`);
    if (!ul || !row) return;
    // Offsets, not rects: the rows are mid-entrance when this first runs, and a
    // rect would measure them where the animation has them rather than at rest.
    let y = 0;
    for (let el: HTMLElement | null = row; el && el !== ul; el = el.offsetParent as HTMLElement | null) y += el.offsetTop;
    ul.style.setProperty("--mark-y", `${y}px`);
    ul.style.setProperty("--mark-h", `${row.offsetHeight}px`);
    ul.dataset.marked = String(row.offsetHeight > 0);
  }, [ui.pageId, ui.pages, folded, ui.renaming]);

  const top = ui.pages.filter((p) => !p.folder);
  const research = ui.pages.filter((p) => p.folder === "Research");
  const before = top.slice(0, 3);
  const after = top.slice(3);

  return (
    <nav className="ek-pages" aria-label="Pages">
      <header className="ek-section-label">
        <span>Pages</span>
        <IconBtn tip="New folder" className="is-sm">
          <FolderPlus width={14} height={14} />
        </IconBtn>
        <IconBtn tip="New page" className="is-sm" onClick={act.addPage}>
          <Plus width={14} height={14} />
        </IconBtn>
      </header>
      <ul ref={list} className="ek-pages-list ek-stagger" role="tree">
        <li className="ek-pages-mark" role="presentation" aria-hidden />
        {before.map((p) => (
          <PageRow key={p.id} page={p} />
        ))}
        {research.length > 0 && (
          <li className="ek-folder" data-open={!folded}>
            <button type="button" className="ek-row" aria-expanded={!folded} onClick={() => setFolded((f) => !f)}>
              <ChevronRight width={12} height={12} className="ek-row-twist" />
              <Folder width={14} height={14} className="ek-row-icon" />
              <span className="ek-row-label">Research</span>
              <span className="ek-meta">{research.length}</span>
            </button>
            <div className="ek-fold" inert={folded}>
              <ul>
                {research.map((p) => (
                  <PageRow key={p.id} page={p} depth={1} />
                ))}
              </ul>
            </div>
          </li>
        )}
        {after.map((p) => (
          <PageRow key={p.id} page={p} />
        ))}
      </ul>
    </nav>
  );
}
