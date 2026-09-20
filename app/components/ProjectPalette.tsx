"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { pages, when } from "@/app/lib/projectMeta";
import { Dialog } from "./Dialog";
import { ChevronRight, FileDoc, Folder, Plus } from "./Icons";
import { NotionMark } from "./NotionMark";
import { PagePreview } from "./PagePreview";

type Project = NonNullable<
  ReturnType<typeof useQuery<typeof api.projects.listForScreen>>
>[number];
type SharedProject = NonNullable<
  ReturnType<typeof useQuery<typeof api.projects.sharedWithMe>>
>[number];

type Row = {
  id: string;
  group: string;
  name: string;
  line: string;
  icon: ReactNode;
  /** Opens a second page of the palette rather than doing something. */
  drill?: boolean;
  /** Wears the New project button's ink, so the two read as the same thing. */
  ink?: boolean;
  project?: Project | SharedProject;
  run: () => void;
};

const noop = () => () => {};

/** ⌘ on Apple hardware, Ctrl elsewhere — read on the client, ⌘ until then. */
export function useModKey(): string {
  const mac = useSyncExternalStore(
    noop,
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => true,
  );
  return mac ? "⌘" : "Ctrl";
}

/**
 * Search on the projects screen, and the keyboard's way to everything else on
 * it: open a project, or start one.
 *
 * Starting one is a row like any other, and it drills into a second page of the
 * same list — blank, or imported — so the ways to begin live in one place and
 * importing is a part of creating rather than a button beside it.
 *
 * It decides nothing itself. Opening, the plan wall and both dialogs belong to
 * the screen; this reports what was chosen and closes.
 */
export function ProjectPalette({
  projects,
  shared,
  canCreate,
  notion,
  onOpen,
  onBlank,
  onNotion,
  onClose,
}: {
  projects: Project[];
  shared: SharedProject[];
  canCreate: boolean;
  notion: boolean;
  onOpen: (id: Id<"projects">) => void;
  onBlank: () => void;
  onNotion: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog label="Search projects" className="nt-palette" onClose={onClose}>
      {(close) => (
        <Palette
          projects={projects}
          shared={shared}
          canCreate={canCreate}
          notion={notion}
          onOpen={(id) => {
            close();
            onOpen(id);
          }}
          onBlank={() => {
            close();
            onBlank();
          }}
          onNotion={() => {
            close();
            onNotion();
          }}
        />
      )}
    </Dialog>
  );
}

function Palette({
  projects,
  shared,
  canCreate,
  notion,
  onOpen,
  onBlank,
  onNotion,
}: {
  projects: Project[];
  shared: SharedProject[];
  canCreate: boolean;
  notion: boolean;
  onOpen: (id: Id<"projects">) => void;
  onBlank: () => void;
  onNotion: () => void;
}) {
  const router = useRouter();
  const [page, setPage] = useState<"root" | "create">("root");
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const go = (to: "root" | "create") => {
    setPage(to);
    setQuery("");
    setIndex(0);
  };

  const root: Row[] = [
    ...(canCreate
      ? [
          {
            id: "create",
            group: "Create",
            name: "New project",
            line: notion ? "Blank, or imported" : "A title and an empty first page",
            icon: <Plus />,
            ink: true,
            drill: notion,
            run: notion ? () => go("create") : onBlank,
          },
        ]
      : []),
    ...projects.map((p) => ({
      id: p._id,
      group: "Yours",
      name: p.title || "Untitled project",
      line: `${pages(p.pageCount)} · ${when(p.updatedAt)}`,
      icon: <Folder />,
      project: p,
      run: () => onOpen(p._id),
    })),
    ...shared.map((p) => ({
      id: p._id,
      group: "Shared with me",
      name: p.title || "Untitled project",
      line: [p.ownerName && `by ${p.ownerName}`, p.role === "editor" ? "can edit" : "view only"]
        .filter(Boolean)
        .join(" · "),
      icon: <Folder />,
      project: p,
      run: () => onOpen(p._id),
    })),
  ];

  const create: Row[] = [
    {
      id: "blank",
      group: "Start",
      name: "Blank project",
      line: "A title and an empty first page",
      icon: <FileDoc />,
      run: onBlank,
    },
    {
      id: "notion",
      group: "Import from",
      name: "Notion",
      line: "Choose which pages come across",
      icon: <NotionMark />,
      run: onNotion,
    },
  ];

  const q = query.trim().toLowerCase();
  const rows = (page === "root" ? root : create).filter(
    (r) => !q || r.name.toLowerCase().includes(q),
  );
  const at = Math.min(index, Math.max(rows.length - 1, 0));
  const current = rows.at(at);

  // The highlight is one element that travels, so it is placed from the
  // selected row's measured box rather than drawn by the row.
  useEffect(() => {
    const box = list.current;
    const row = box?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!box || !row) return;
    box.style.setProperty("--hl-y", `${row.offsetTop}px`);
    box.style.setProperty("--hl-h", `${row.offsetHeight}px`);
    row.scrollIntoView({ block: "nearest" });
  }, [at, page, rows.length]);

  // The preview and the route warm-up trail the selection by a beat: holding an
  // arrow key would otherwise mount a live thumbnail, and fetch the editor's
  // bundle, for every row on the way past.
  const currentProject = current?.project;
  const [shown, setShown] = useState(currentProject);
  useEffect(() => {
    const t = setTimeout(() => {
      setShown(currentProject);
      if (currentProject) router.prefetch(`/p/${currentProject._id}`);
    }, 110);
    return () => clearTimeout(t);
  }, [currentProject, router]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" && rows.length) {
      e.preventDefault();
      setIndex((at + 1) % rows.length);
    } else if (e.key === "ArrowUp" && rows.length) {
      e.preventDefault();
      setIndex((at - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter" || (e.key === "ArrowRight" && current?.drill && !query)) {
      e.preventDefault();
      current?.run();
    } else if (
      page === "create" &&
      (e.key === "Escape" || ((e.key === "Backspace" || e.key === "ArrowLeft") && !query))
    ) {
      // Escape backs out of the second page before it closes the palette. The
      // dialog hears Escape on `document`, which is where React listens too, so
      // stopping propagation is not enough to keep it from closing.
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      go("root");
    }
  };

  return (
    <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="nt-pal-field">
        {page === "create" && (
          <button type="button" className="nt-pal-crumb" onClick={() => go("root")}>
            New project
          </button>
        )}
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="nt-pal-list"
          aria-activedescendant={current ? `nt-pal-${current.id}` : undefined}
          aria-label={page === "root" ? "Search projects" : "How to start"}
          placeholder={page === "root" ? "Open a project, or start one…" : "How do you want to start?"}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
        />
        <kbd className="nt-kbd">esc</kbd>
      </div>

      <div className="nt-pal-panes">
        <div
          ref={list}
          id="nt-pal-list"
          role="listbox"
          aria-label={page === "root" ? "Projects" : "Ways to start"}
          className="nt-pal-list"
          data-page={page}
          key={page}
        >
          <span className="nt-pal-hl" aria-hidden="true" data-none={rows.length === 0} />
          {rows.map((r, i) => (
            <div key={r.id}>
              {r.group !== rows[i - 1]?.group && <div className="nt-pal-group">{r.group}</div>}
              <div
                id={`nt-pal-${r.id}`}
                role="option"
                aria-selected={i === at}
                className="nt-pal-row"
                // The field keeps focus through a click, or drilling in with
                // the mouse would leave the arrow keys with nowhere to land.
                onMouseDown={(e) => e.preventDefault()}
                onPointerMove={() => {
                  if (i !== at) setIndex(i);
                }}
                onClick={r.run}
              >
                <span className={`nt-pal-icon${r.ink ? " is-ink" : ""}`}>{r.icon}</span>
                <span className="nt-pal-text">
                  <span className="nt-pal-name">{r.name}</span>
                  <span className="nt-pal-line">{r.line}</span>
                </span>
                {r.drill && <ChevronRight width={14} height={14} className="nt-pal-chev" />}
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="nt-pal-none">
              {page === "root" ? `No project matches “${query}”.` : `Nothing matches “${query}”.`}
            </p>
          )}
        </div>

        <aside className="nt-pal-side" aria-hidden="true">
          {shown && shown._id === currentProject?._id ? (
            <div className="nt-pal-card" key={shown._id}>
              <PagePreview docId={shown.firstPageDocId} />
              <p className="nt-pal-card-name">{shown.title || "Untitled project"}</p>
              {"description" in shown && shown.description && (
                <p className="nt-pal-card-line">{shown.description}</p>
              )}
              <dl className="nt-pal-facts">
                <div>
                  <dt>Pages</dt>
                  <dd className="nt-meta">{shown.pageCount}</dd>
                </div>
                <div>
                  <dt>Edited</dt>
                  <dd className="nt-meta">{when(shown.updatedAt)}</dd>
                </div>
              </dl>
            </div>
          ) : (
            !currentProject &&
            current && (
              <div className="nt-pal-card is-action" key={current.id}>
                <span className={`nt-pal-big${current.ink ? " is-ink" : ""}`}>{current.icon}</span>
                <p className="nt-pal-card-name">{current.name}</p>
                <p className="nt-pal-card-line">{current.line}</p>
              </div>
            )
          )}
        </aside>
      </div>

      <div className="nt-pal-foot">
        <span>
          <kbd className="nt-kbd">↵</kbd>
          {current?.drill ? "Choose how" : page === "create" ? "Start" : "Open"}
        </span>
        <span>
          <kbd className="nt-kbd">↑</kbd>
          <kbd className="nt-kbd">↓</kbd>
          Move
        </span>
        {page === "create" && (
          <span>
            <kbd className="nt-kbd">⌫</kbd>
            Back
          </span>
        )}
      </div>
    </div>
  );
}
