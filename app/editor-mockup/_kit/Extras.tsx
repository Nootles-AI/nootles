"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { mockups } from "./data";
import { useUi } from "./store";
import { Sheet, Tips, Toasts } from "./overlays";
import { ChevronLeft, ChevronRight, FileDoc, Home, Keyboard, LinkIcon, PanelLeft, PanelRight, Plus, Search, Diagram as DiagramIcon } from "./icons";

const SHORTCUTS: [group: string, rows: [string, string][]][] = [
  ["Anywhere", [["Find or do", "⌘K"], ["Undo", "⌘Z"], ["Redo", "⌘⇧Z"], ["Toggle sidebar", "⌘\\"], ["Toggle assistant", "⌘J"]]],
  ["Writing", [["Blocks", "/"], ["Link a page", "@"], ["Accept a completion", "Tab"], ["Bold", "⌘B"], ["Inline code", "⌘E"]]],
  ["Canvas", [["Move", "V"], ["Rectangle", "R"], ["Ellipse", "O"], ["Text", "T"], ["Connector", "C"], ["Pen", "P"], ["Nudge", "← → ↑ ↓"], ["Step out", "Esc"]]],
];

type Action = { id: string; label: string; hint: string; icon: ReactNode; keys?: string; run: () => void };

/** ⌘K, as on the projects screen: one field, one travelling highlight. */
function Palette() {
  const { ui, act } = useUi();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const close = () => {
    act.set({ palette: false });
    setQuery("");
    setIndex(0);
  };

  const actions: Action[] = [
    { id: "new", label: "New page", hint: "Action", icon: <Plus width={16} height={16} />, run: act.addPage },
    { id: "diagram", label: "Edit the diagram", hint: "Action", icon: <DiagramIcon width={16} height={16} />, run: () => act.set({ mode: "diagram", pageId: "overview" }) },
    { id: "share", label: "Copy share link", hint: "Action", icon: <LinkIcon width={16} height={16} />, run: () => act.toast("Link copied") },
    { id: "left", label: ui.left ? "Hide sidebar" : "Show sidebar", hint: "Action", keys: "⌘\\", icon: <PanelLeft width={16} height={16} />, run: () => act.set({ left: !ui.left }) },
    { id: "right", label: ui.right ? "Hide assistant" : "Show assistant", hint: "Action", keys: "⌘J", icon: <PanelRight width={16} height={16} />, run: () => act.set({ right: !ui.right }) },
    { id: "keys", label: "Keyboard shortcuts", hint: "Action", keys: "?", icon: <Keyboard />, run: () => act.set({ sheet: "shortcuts" }) },
    { id: "home", label: "All projects", hint: "Go", icon: <Home />, run: () => router.push("/") },
  ];
  const pages: Action[] = ui.pages.map((p) => ({ id: p.id, label: p.title || "Untitled", hint: p.folder ?? "Page", icon: <FileDoc width={16} height={16} />, run: () => act.openPage(p.id) }));
  const q = query.toLowerCase();
  const rows = [...pages, ...actions].filter((r) => r.label.toLowerCase().includes(q));
  const at = Math.min(index, Math.max(0, rows.length - 1));

  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-row="${at}"]`);
    if (!row || !list.current) return;
    list.current.style.setProperty("--mark-y", `${row.offsetTop}px`);
    list.current.style.setProperty("--mark-h", `${row.offsetHeight}px`);
    row.scrollIntoView({ block: "nearest" });
  }, [at, rows.length, ui.palette]);

  return (
    <Sheet open={ui.palette} label="Find or do" className="ek-palette" onClose={close}>
      <label className="ek-palette-field">
        <Search width={16} height={16} />
        <input
          data-autofocus
          placeholder="Open a page, or do something…"
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % Math.max(1, rows.length));
            }
            if (e.key === "Enter" && rows[at]) {
              close();
              rows[at].run();
            }
          }}
        />
        <kbd className="ek-kbd">esc</kbd>
      </label>
      <div ref={list} className="ek-palette-list">
        {rows.length > 0 && <span className="ek-palette-mark" aria-hidden />}
        {rows.length === 0 && <p className="ek-note ek-pop-empty">Nothing matches “{query}”</p>}
        {rows.map((r, i) => (
          <button
            key={r.id}
            type="button"
            data-row={i}
            data-active={i === at || undefined}
            className="ek-palette-row"
            style={{ "--i": Math.min(i, 10) } as CSSProperties}
            onPointerMove={() => setIndex(i)}
            onClick={() => {
              close();
              r.run();
            }}
          >
            <span className="ek-item-icon">{r.icon}</span>
            <span className="ek-row-label">{r.label}</span>
            <span className="ek-meta">{r.hint}</span>
            {r.keys && <kbd className="ek-kbd">{r.keys}</kbd>}
          </button>
        ))}
      </div>
      <footer className="ek-palette-foot">
        <span>
          <kbd className="ek-kbd">↵</kbd> Open
        </span>
        <span>
          <kbd className="ek-kbd">↑</kbd>
          <kbd className="ek-kbd">↓</kbd> Move
        </span>
      </footer>
    </Sheet>
  );
}

/** Steps between the five. `[` and `]` do the same from the keyboard. */
function Switcher() {
  const n = Number(usePathname().split("/")[2]);
  const at = mockups.find((m) => m.n === n);
  const total = mockups.length;
  const prev = at ? ((n + total - 2) % total) + 1 : total;
  const next = at ? (n % total) + 1 : 1;
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable], [role='dialog']")) return;
      if (e.key === "[") router.push(`/editor-mockup/${prev}`);
      if (e.key === "]") router.push(`/editor-mockup/${next}`);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router, prev, next]);

  if (!at) return null;
  return (
    <nav className="ek-switch" aria-label="Mockups">
      <Link href={`/editor-mockup/${prev}`} aria-label="Previous mockup">
        <ChevronLeft width={14} height={14} />
      </Link>
      <Link href="/editor-mockup" className="ek-switch-name">
        <b>
          {String(n).padStart(2, "0")}/{String(total).padStart(2, "0")}
        </b>
        {at.name}
      </Link>
      <Link href={`/editor-mockup/${next}`} aria-label="Next mockup">
        <ChevronRight width={14} height={14} />
      </Link>
    </nav>
  );
}

/** Everything a mockup needs that is not part of its layout. Mount once, last. */
export function Chrome() {
  const { ui, act } = useUi();
  const page = ui.pages.find((p) => p.id === ui.target);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "k") {
        e.preventDefault();
        return act.set((u) => ({ palette: !u.palette }));
      }
      if (mod && key === "\\") return act.set((u) => ({ left: !u.left }));
      if (mod && key === "j") {
        e.preventDefault();
        return act.set((u) => ({ right: !u.right }));
      }
      if (key === "?" && !(e.target as HTMLElement).closest("input, textarea, [contenteditable]")) act.set({ sheet: "shortcuts" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [act]);

  return (
    <>
      <Palette />
      <Sheet open={ui.sheet === "shortcuts"} label="Keyboard shortcuts" className="ek-keys" onClose={() => act.set({ sheet: null })}>
        <h2>Keyboard shortcuts</h2>
        <div className="ek-keys-cols">
          {SHORTCUTS.map(([group, rows]) => (
            <section key={group}>
              <div className="ek-group-label">{group}</div>
              {rows.map(([label, keys]) => (
                <div key={label} className="ek-keys-row">
                  <span>{label}</span>
                  <kbd className="ek-kbd">{keys}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </Sheet>
      <Sheet open={ui.sheet === "delete"} label="Delete page" className="ek-confirm" onClose={() => act.set({ sheet: null })}>
        <h2>Delete “{page?.title || "Untitled"}”?</h2>
        <p>The page and everything on it goes. Collaborators lose it too. This can be undone for a few seconds.</p>
        <footer>
          <button type="button" className="ek-btn" onClick={() => act.set({ sheet: null })}>
            Cancel
          </button>
          <button
            type="button"
            data-autofocus
            className="ek-btn is-danger"
            onClick={() => {
              if (ui.target) act.deletePage(ui.target);
              act.toast("Page deleted", "Undo");
            }}
          >
            Delete page
          </button>
        </footer>
      </Sheet>
      <Toasts />
      <Tips />
      <Switcher />
    </>
  );
}
