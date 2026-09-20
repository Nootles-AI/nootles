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
import { GitHubRepos } from "./context/GitHubRepos";
import { ChevronRight, FileDoc, Folder, Plus, Template } from "./Icons";
import { useNewProjectDraft, type NewProject } from "./NewProjectDialog";
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
 * same list — blank, from a template, or imported — so the ways to begin live
 * in one place and importing is a part of creating rather than a button beside
 * it. A blank project is made here, on a third page: the same fields the
 * dialog asks, in the palette's own dress, under the crumbs that say where you
 * are.
 *
 * It decides little itself. Opening, the plan wall, the import dialog and the
 * making of the project belong to the screen; this reports and closes.
 */
export function ProjectPalette({
  projects,
  shared,
  canCreate,
  room,
  notion,
  onOpen,
  onWall,
  onCreate,
  onNotion,
  onClose,
}: {
  projects: Project[];
  shared: SharedProject[];
  canCreate: boolean;
  /** Whether the plan has room for another project; without it, the wall. */
  room: boolean;
  notion: boolean;
  onOpen: (id: Id<"projects">) => void;
  onWall: () => void;
  /** Resolves once the project exists and is being opened. */
  onCreate: (project: NewProject) => Promise<void>;
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
          room={room}
          notion={notion}
          onOpen={(id) => {
            close();
            onOpen(id);
          }}
          onWall={() => {
            close();
            onWall();
          }}
          onCreate={onCreate}
          onNotion={() => {
            close();
            onNotion();
          }}
        />
      )}
    </Dialog>
  );
}

type Page = "root" | "create" | "blank";

function Palette({
  projects,
  shared,
  canCreate,
  room,
  notion,
  onOpen,
  onWall,
  onCreate,
  onNotion,
}: {
  projects: Project[];
  shared: SharedProject[];
  canCreate: boolean;
  room: boolean;
  notion: boolean;
  onOpen: (id: Id<"projects">) => void;
  onWall: () => void;
  onCreate: (project: NewProject) => Promise<void>;
  onNotion: () => void;
}) {
  const router = useRouter();
  const [page, setPage] = useState<Page>("root");
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const go = (to: Page) => {
    setPage(to);
    setQuery("");
    setIndex(0);
  };
  // The wall stands in front of the form exactly as it does the header's button.
  const startBlank = () => (room ? go("blank") : onWall());

  const root: Row[] = [
    ...(canCreate
      ? [
          {
            id: "create",
            group: "Create",
            name: "New project",
            line: notion ? "Blank, from a template, or imported" : "Blank, or from a template",
            icon: <Plus />,
            ink: true,
            drill: true,
            run: () => go("create"),
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
      drill: true,
      run: startBlank,
    },
    {
      id: "template",
      group: "Start",
      name: "Start from template",
      line: "Pages already laid out for a kind of work",
      icon: <Template />,
      drill: true,
      // No templates exist yet — the same placeholder as the header's menu.
      run: startBlank,
    },
    ...(notion
      ? [
          {
            id: "notion",
            group: "Import from",
            name: "Notion",
            line: "Choose which pages come across",
            icon: <NotionMark />,
            run: onNotion,
          },
        ]
      : []),
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
    // The form page has fields; arrows and Enter are theirs. Escape still backs
    // out one page rather than closing the palette.
    if (page === "blank") {
      if (e.key === "Escape") {
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        go("create");
      }
      return;
    }
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
        {page !== "root" && (
          <button type="button" className="nt-pal-crumb" onClick={() => go("root")}>
            New project
          </button>
        )}
        {page === "blank" && (
          <>
            <ChevronRight width={14} height={14} className="nt-pal-crumb-sep" aria-hidden="true" />
            <button type="button" className="nt-pal-crumb" onClick={() => go("create")}>
              Blank project
            </button>
          </>
        )}
        {page === "blank" ? (
          <span className="flex-1" />
        ) : (
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
        )}
        <kbd className="nt-kbd">esc</kbd>
      </div>

      {page === "blank" ? (
        <BlankForm onCreate={onCreate} onBack={() => go("create")} />
      ) : (
        <>
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
              {page === "root" ? (current?.drill ? "Choose how" : "Open") : current?.drill ? "Continue" : "Start"}
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
        </>
      )}
    </div>
  );
}

/**
 * The New project dialog's fields, on the palette's third page. Same questions
 * in the same order, same draft and the same send; only the dress is the
 * palette's — group labels, hairlines, type at the field's size.
 */
function BlankForm({
  onCreate,
  onBack,
}: {
  onCreate: (project: NewProject) => Promise<void>;
  onBack: () => void;
}) {
  const {
    title, setTitle, description, setDescription, context, setContext,
    repos, addRepo, removeRepo, busy, failure, named, submit, sendOnModEnter,
  } = useNewProjectDraft(onCreate);

  return (
    <form className="nt-pal-form" onSubmit={submit}>
      {/* The name leads, at the query field's size and with no label: it is
          the one thing a project needs, and the thing you came to type. */}
      <label className="nt-pal-name-row">
        <span className="sr-only">Title</span>
        <input
          autoFocus
          autoComplete="off"
          className="nt-pal-name-input"
          placeholder="Project title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      {/* The rest is one thing — what the assistant is told — and reads as one
          group: a heading in the palette's section voice, then keys down the
          left and answers down the right. */}
      <div className="nt-pal-fields">
        <div className="nt-pal-group">
          For the assistant <em>All optional</em>
        </div>
        <label className="nt-pal-fld">
          <span className="nt-pal-key">Description</span>
          <input
            autoComplete="off"
            className="nt-pal-input"
            placeholder="One line on what it is"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="nt-pal-fld">
          <span className="nt-pal-key">Repositories</span>
          <div className="min-w-0">
            <GitHubRepos
              bare
              repos={repos.map((repo) => ({
                key: repo.fullName,
                fullName: repo.fullName,
                description: repo.description,
                private: repo.private,
              }))}
              onAdd={addRepo}
              onRemove={removeRepo}
            />
          </div>
        </div>
        <label className="nt-pal-fld">
          <span className="nt-pal-key">Context</span>
          <textarea
            className="nt-pal-input"
            rows={4}
            placeholder="Who it is for, what has been decided, anything the assistant should take as given"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            onKeyDown={sendOnModEnter}
          />
        </label>
      </div>

      <div className="nt-pal-foot">
        {failure ? (
          <span role="alert" className="text-danger">
            {failure}
          </span>
        ) : (
          <span>
            <kbd className="nt-kbd">↵</kbd>
            Create
          </span>
        )}
        <span className="ml-auto flex gap-1">
          <button type="button" onClick={onBack} className="nt-row px-2.5">
            Back
          </button>
          <button type="submit" disabled={!named || busy} className="nt-row nt-solid px-3 font-medium">
            {busy ? "Creating…" : "Create"}
          </button>
        </span>
      </div>
    </form>
  );
}
