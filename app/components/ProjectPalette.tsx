"use client";

import dynamic from "next/dynamic";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { pages, when } from "@/app/lib/projectMeta";
import { projectPath } from "@/app/lib/containerPaths";
import { Dialog } from "./Dialog";
import { PROJECT_TEMPLATES, pagePicture, type ProjectTemplate } from "@/app/lib/templates";
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  FileDoc,
  Folder,
  Plus,
  Sparkles,
  Template,
} from "./Icons";
import { Menu, MenuItem } from "./Menu";
import { Segmented } from "./Segmented";
import { useNewProjectDraft, type NewProject, type ProjectHome } from "./newProjectDraft";
import { slugOf, useContainer } from "./workspaces/ContainerContext";
import { NotionMark } from "./NotionMark";
import { NotionPort } from "./NotionPort";
import { BlankStart } from "./BlankStart";
import { ProLift } from "./ProLift";
import { usePlan } from "@/app/lib/usePlan";
import { BlocksThumb, PagePreview } from "./PagePreview";
import { TemplateWall } from "./TemplateWall";
import { DraftSources } from "./context/ContextSources";
import { GitHubSourcePage, NotionSourcePage } from "./context/SourcePages";
import { repoPlaceholder, searchable, useGitHubDoor } from "./context/useGitHubDoor";

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
  /** What the side pane previews in place of a project. */
  template?: ProjectTemplate;
  /** A picture in the side pane, rather than a card about the row. */
  picture?: "wall" | "blank" | "notion" | "pro";
  run: () => void;
};

/*
 * The import runs the editor headless to build the pages it brings across
 * (`importRun` → `onboarding/seed` → the BlockNote schema), so a static import
 * here put BlockNote, KaTeX, Yjs and the whole canvas in this screen's first
 * bundle — for the last page of a palette most visits never open. Fetched when
 * the highlight rests on its row, which is before it can be asked for.
 */
const loadNotionImport = () => import("./notion/NotionImport");
const NotionImportBody = dynamic(() => loadNotionImport().then((m) => m.NotionImportBody), {
  ssr: false,
});

// Its own module, so the workspace can name the key without importing this one.
export { useModKey } from "@/app/lib/useModKey";

/**
 * Search on the projects screen, and the keyboard's way to everything else on
 * it: open a project, or start one.
 *
 * Starting one is a row like any other, and it drills into a second page of the
 * same list — blank, from a template, or imported — so the ways to begin live
 * in one place and importing is a part of creating rather than a button beside
 * it. The project is made here too: "From template" is a page of templates,
 * and both it and "Blank project" end on the details page — the fields the
 * dialog asks, in the palette's own dress, under crumbs that say where you are.
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
  onClose,
  start = "root",
}: {
  /** The page to open on — the header's template item opens on "template". */
  start?: Page;
  projects: Project[];
  shared: SharedProject[];
  canCreate: boolean;
  /** Whether the plan has room for another project. Only the import asks
   *  before starting — making one by hand meets the wall at its Create button. */
  room: boolean;
  notion: boolean;
  onOpen: (id: Id<"projects">) => void;
  onWall: () => void;
  /** Resolves once the project exists and is being opened. */
  onCreate: (project: NewProject) => Promise<boolean | void>;
  onClose: () => void;
}) {
  return (
    <Dialog label="Search projects" className="nt-palette" onClose={onClose}>
      {(close) => (
        <Palette
          start={start}
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
          onDone={close}
        />
      )}
    </Dialog>
  );
}

/** Each page's way back, which is also what Escape and the crumbs follow. */
export type Page =
  | "root"
  | "create"
  | "template"
  | "details"
  | "notion"
  /** The details form's GitHub and Notion doors, each a page of its own. */
  | "sourceGithub"
  | "sourceNotion";

function Palette({
  start,
  projects,
  shared,
  canCreate,
  room,
  notion,
  onOpen,
  onWall,
  onCreate,
  onDone,
}: {
  start: Page;
  projects: Project[];
  shared: SharedProject[];
  canCreate: boolean;
  room: boolean;
  notion: boolean;
  onOpen: (id: Id<"projects">) => void;
  onWall: () => void;
  onCreate: (project: NewProject) => Promise<boolean | void>;
  /** Closes the palette, playing its way out. */
  onDone: () => void;
}) {
  const router = useRouter();
  const here = useContainer();
  const [page, setPage] = useState<Page>(start);
  // What the details page is making: a template, or null for blank.
  const [template, setTemplate] = useState<{ id: string; name: string } | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // A project started on a workspace's home is that workspace's unless its
  // maker says otherwise — and a guest, who makes nothing there, starts one
  // of their own.
  const home: ProjectHome | undefined =
    here.kind === "workspace" && here.role !== "guest"
      ? { workspaceId: here.workspaceId, slug: here.slug, visibility: "workspace" }
      : undefined;
  // Held here rather than in the form: the form's source doors are pages of
  // their own, and what was typed has to be there when they step back.
  const draft = useNewProjectDraft(onCreate, template?.id, home);

  const go = (to: Page) => {
    setPage(to);
    setQuery("");
    setIndex(0);
  };
  // No wall in front of making a project: the whole of it — blank or template,
  // the name, the context — is theirs to write, and the plan is asked at the
  // Create button (`ProjectsScreen`'s `create`), with what they wrote kept.
  const startBlank = () => {
    setTemplate(null);
    go("details");
  };
  const back: Record<Page, Page | null> = {
    root: null,
    create: "root",
    template: "create",
    details: template ? "template" : "create",
    notion: "create",
    sourceGithub: "details",
    sourceNotion: "details",
  };
  const sourcePage = page === "sourceGithub" || page === "sourceNotion";
  // Pages that are not a list of rows: the keys belong to whatever is on them.
  const listless = page === "details" || page === "notion" || sourcePage;
  // The import's pick state is searched from this field rather than one of its
  // own; it says when it has pages to search.
  const [notionSearch, setNotionSearch] = useState(false);
  // A source's page is searched once it has something to search: not on its
  // connect screen.
  // A workspace's project takes its repositories from the workspace's GitHub
  // App; the draft says which container it is going to.
  const githubDoor = useGitHubDoor(draft.workspace?.workspaceId, page === "sourceGithub");
  const notionStatus = useQuery(api.notion.account.status, page === "sourceNotion" ? {} : "skip");
  const sourceReady =
    (page === "sourceGithub" && searchable(githubDoor)) ||
    (page === "sourceNotion" && !!notionStatus?.account && !notionStatus.account.invalidAt);
  const fielded = !listless || (page === "notion" && notionSearch) || sourceReady;

  // Anyone not on Pro is offered it first — once the plan has answered, so an
  // account that has paid never sees it flash. Not to a stand-in operator,
  // who is not the one who would be paying, and not on a workspace's home,
  // where the plan that matters is the workspace's.
  const { left } = usePlan();
  const root: Row[] = [
    ...(canCreate && left && here.kind === "account"
      ? [
          {
            id: "upgrade",
            group: "Pro",
            name: "Upgrade to Pro",
            line: "Unlimited projects, completions and conversations",
            icon: <Sparkles />,
            picture: "pro" as const,
            run: () => {
              onDone();
              router.push("/upgrade");
            },
          },
        ]
      : []),
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
      group: here.kind === "workspace" ? here.name : "Yours",
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
      picture: "blank",
      run: startBlank,
    },
    {
      id: "template",
      group: "Start",
      name: "Start from template",
      line: "Pages already laid out for a kind of work",
      icon: <Template />,
      drill: true,
      picture: "wall",
      run: () => go("template"),
    },
    ...(notion
      ? [
          {
            id: "notion",
            group: "Import from",
            name: "Notion",
            line: "Choose which pages come across",
            icon: <NotionMark />,
            picture: "notion" as const,
            drill: true,
            run: () => (room ? go("notion") : onWall()),
          },
        ]
      : []),
  ];

  const choices: Row[] = PROJECT_TEMPLATES.map((t) => ({
    id: t.id,
    group: "Templates",
    name: t.name,
    line: t.description,
    icon: <Template />,
    template: t,
    drill: true,
    run: () => {
      setTemplate({ id: t.id, name: t.name });
      go("details");
    },
  }));

  const q = query.trim().toLowerCase();
  const rows = (page === "root" ? root : page === "create" ? create : choices).filter(
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
  const slug = slugOf(here);
  const [shown, setShown] = useState(currentProject);
  useEffect(() => {
    const t = setTimeout(() => {
      setShown(currentProject);
      if (currentProject) router.prefetch(projectPath(slug, currentProject._id));
    }, 110);
    return () => clearTimeout(t);
  }, [currentProject, router, slug]);

  // Resting on the Notion row is the cue to fetch what choosing it will need.
  const onNotionRow = current?.picture === "notion";
  useEffect(() => {
    if (onNotionRow) void loadNotionImport();
  }, [onNotionRow]);

  const onKeyDown = (e: KeyboardEvent) => {
    // The form page has fields; arrows and Enter are theirs. Escape still backs
    // out one page rather than closing the palette.
    const prior = back[page];
    if (listless) {
      if (e.key === "Escape" && prior) {
        e.preventDefault();
        e.nativeEvent.stopImmediatePropagation();
        go(prior);
      } else if (e.key === "ArrowDown" && e.target instanceof HTMLInputElement) {
        // From the search field into what it found: the tree keeps one row in
        // the tab order, and that is the one to land on.
        const row = e.currentTarget.querySelector<HTMLElement>(
          '[role="treeitem"][tabindex="0"], [role="option"]',
        );
        if (!row) return;
        e.preventDefault();
        row.focus();
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
      prior &&
      (e.key === "Escape" || ((e.key === "Backspace" || e.key === "ArrowLeft") && !query))
    ) {
      // Escape backs out of the second page before it closes the palette. The
      // dialog hears Escape on `document`, which is where React listens too, so
      // stopping propagation is not enough to keep it from closing.
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      go(prior);
    }
  };

  // The trail to here. Every crumb but the last is a way back to its page.
  const trail: { label: string; to: Page }[] =
    page === "root"
      ? []
      : [
          { label: "New project", to: "root" },
          ...(page === "template" || (page === "details" && template)
            ? [{ label: "From template", to: "create" as Page }]
            : []),
          ...(page === "details" || sourcePage
            ? [
                template
                  ? { label: "Project details", to: "template" as Page }
                  : { label: "Blank project", to: "create" as Page },
              ]
            : []),
          ...(page === "notion" ? [{ label: "Import from Notion", to: "create" as Page }] : []),
          ...(page === "sourceGithub" ? [{ label: "GitHub", to: "details" as Page }] : []),
          ...(page === "sourceNotion" ? [{ label: "Notion", to: "details" as Page }] : []),
        ];

  return (
    <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="nt-pal-field">
        {trail.map((crumb, i) => (
          <Fragment key={crumb.label}>
            {i > 0 && (
              <ChevronRight width={14} height={14} className="nt-pal-crumb-sep" aria-hidden="true" />
            )}
            <button type="button" className="nt-pal-crumb" onClick={() => go(crumb.to)}>
              {crumb.label}
            </button>
          </Fragment>
        ))}
        {!fielded ? (
          <span className="flex-1" />
        ) : page === "notion" || sourcePage ? (
          <input
            autoFocus
            type="search"
            aria-label={page === "sourceGithub" ? "Search repositories" : "Search Notion pages"}
            placeholder={
              page === "sourceGithub" ? repoPlaceholder(githubDoor) : "Search your Notion pages…"
            }
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : (
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="nt-pal-list"
            aria-activedescendant={current ? `nt-pal-${current.id}` : undefined}
            aria-label={
              page === "root" ? "Search projects" : page === "create" ? "How to start" : "Choose a template"
            }
            placeholder={
              page === "root"
                ? "Open a project, or start one…"
                : page === "create"
                  ? "How do you want to start?"
                  : "Choose a template…"
            }
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

      {page === "notion" ? (
        <NotionImportBody
          frame="palette"
          close={onDone}
          back={() => go("create")}
          search={query}
          onSearchable={setNotionSearch}
        />
      ) : page === "sourceGithub" ? (
        <GitHubSourcePage
          door={githubDoor}
          chosen={draft.sources.repos}
          search={query}
          onChoose={(repos) => {
            draft.setSources({ ...draft.sources, repos });
            go("details");
          }}
          onBack={() => go("details")}
        />
      ) : page === "sourceNotion" ? (
        <NotionSourcePage
          chosen={draft.sources.pages}
          search={query}
          onChoose={(pages) => {
            draft.setSources({ ...draft.sources, pages });
            go("details");
          }}
          onBack={() => go("details")}
        />
      ) : page === "details" ? (
        <DetailsForm
          template={template}
          draft={draft}
          onDoor={(door) => go(door === "github" ? "sourceGithub" : "sourceNotion")}
          onBack={() => go(template ? "template" : "create")}
        />
      ) : (
        <>
          <div className="nt-pal-panes">
            <div
              ref={list}
              id="nt-pal-list"
              role="listbox"
              aria-label={page === "root" ? "Projects" : page === "create" ? "Ways to start" : "Templates"}
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
              ) : current?.picture === "wall" ? (
                <TemplateWall />
              ) : current?.picture === "blank" ? (
                <BlankStart />
              ) : current?.picture === "notion" ? (
                <NotionPort />
              ) : current?.picture === "pro" ? (
                <ProLift />
              ) : current?.template ? (
                <TemplatePreview key={current.id} template={current.template} />
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
            {page !== "root" && (
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
 * What a template makes: one of its pages on top, drawn as it will look, and
 * the sidebar it opens with below. Resting on a file shows that page.
 *
 * Pointer only — the pane is a preview and hidden from assistive tech, like
 * the project preview it sits in place of; what it describes is reached by
 * choosing the template.
 */
function TemplatePreview({ template }: { template: ProjectTemplate }) {
  const first = template.rows.flatMap((row) => (row.kind === "page" ? [row] : row.pages))[0];
  const [shown, setShown] = useState(first);

  const file = (page: typeof first, nested: boolean) => (
    <li
      key={page.title}
      className={`nt-pal-file${nested ? " is-nested" : ""}`}
      data-on={page === shown}
      onPointerEnter={() => setShown(page)}
    >
      <FileDoc width={14} height={14} />
      <span>{page.title}</span>
    </li>
  );

  return (
    <div className="nt-pal-card nt-pal-tpl">
      <div className="nt-pal-sheet" key={shown.title}>
        <BlocksThumb blocks={pagePicture(shown)} />
      </div>
      <ul className="nt-pal-files">
        {template.rows.map((row) =>
          row.kind === "page" ? (
            file(row, false)
          ) : (
            <li key={row.title}>
              <div className="nt-pal-file is-folder">
                <Folder width={14} height={14} />
                <span>{row.title}</span>
              </div>
              <ul>{row.pages.map((page) => file(page, true))}</ul>
            </li>
          )
        )}
      </ul>
    </div>
  );
}

/**
 * The project's details, on the palette's last page. What it makes — blank, or
 * a template — is decided on the pages before it.
 */
function DetailsForm({
  template,
  draft,
  onDoor,
  onBack,
}: {
  template: { id: string; name: string } | null;
  draft: ReturnType<typeof useNewProjectDraft>;
  /** GitHub and Notion open as pages of the palette; files stay a file dialog. */
  onDoor: (door: "github" | "notion") => void;
  onBack: () => void;
}) {
  const {
    title, setTitle, description, setDescription, sources, setSources,
    workspace, setWorkspace, busy, failure, named, submit,
  } = draft;
  // Where it can go: your own projects, and every workspace you make things
  // in. Only asked of someone who has one — for everyone else the form is
  // exactly what it always was.
  const seats = useQuery(api.workspaces.listMine);
  const places = seats?.filter((w) => w.role !== "guest") ?? [];
  const chosen = workspace && places.find((w) => w.workspaceId === workspace.workspaceId);
  // Who sees it, remembered across a trip to My Nootles and back — and so
  // what the Visibility row goes on showing while it folds shut.
  const [visibility, setVisibility] = useState(workspace?.visibility ?? "workspace");
  const place = chosen?.name ?? "the workspace";
  // What each answer means, the chosen one's said under the switch and the
  // other's in its hint: who can open the project is the one thing here that
  // can't be guessed.
  const seen = {
    workspace: `Everyone in ${place} can find it and edit it`,
    private: `Only you and ${place}’s owners and admins can open it`,
  };

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

      {/* The rest reads as one group, keys down the left and answers down the
          right: where it lives, when there is a choice, and then what the
          assistant is told. */}
      <div className="nt-pal-fields">
        {places.length > 0 && (
          <div className="nt-pal-fld">
            <span id="nt-pal-in-key" className="nt-pal-key">
              Where
            </span>
            <div className="min-w-0">
              <Menu
                label="Where the project goes"
                side="bottom"
                align="start"
                layer="modal"
                trigger={(t) => (
                  <button
                    {...t}
                    type="button"
                    id="nt-pal-in"
                    aria-labelledby="nt-pal-in-key nt-pal-in"
                    className="nt-row -ml-2 max-w-full gap-1.5 px-2 text-[15px] text-foreground"
                  >
                    <span className="truncate">{chosen ? chosen.name : "My Nootles"}</span>
                    <ChevronsUpDown width={14} height={14} className="shrink-0 text-muted" />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem
                      onClick={() => {
                        setWorkspace(undefined);
                        close();
                      }}
                    >
                      My Nootles
                      <Check
                        width={14}
                        height={14}
                        aria-hidden="true"
                        className={`nt-menu-check${chosen ? "" : " is-on"}`}
                      />
                    </MenuItem>
                    {places.map((w) => (
                      <MenuItem
                        key={w.workspaceId}
                        onClick={() => {
                          setWorkspace({
                            workspaceId: w.workspaceId,
                            slug: w.slug,
                            visibility,
                          });
                          close();
                        }}
                      >
                        <span className="min-w-0 truncate">{w.name}</span>
                        <Check
                          width={14}
                          height={14}
                          aria-hidden="true"
                          className={`nt-menu-check${
                            chosen?.workspaceId === w.workspaceId ? " is-on" : ""
                          }`}
                        />
                      </MenuItem>
                    ))}
                  </>
                )}
              </Menu>
              {/* Moving a project between them is not something Nootles does,
                  so the choice is said to be for good before it is made — and
                  so is what a member gives up by making one in a workspace:
                  its owners and admins manage it, not whoever made it. */}
              <p className="text-[12px] text-muted text-pretty">
                {chosen?.role === "member"
                  ? `A project can’t be moved after it’s made, and only ${chosen.name}’s owners and admins can rename or delete it.`
                  : "A project can’t be moved after it’s made."}
              </p>
            </div>
          </div>
        )}
        {/* Two short words, since the workspace is named just above; who
            exactly the chosen one means is said under it, and the other's in
            its hint. Folded shut, not unmounted, while the project is going
            into My Nootles. */}
        {places.length > 0 && (
          <div className="nt-pal-fold" data-open={!!chosen} inert={!chosen}>
            <div className="nt-pal-fld">
              <span className="nt-pal-key">Visibility</span>
              <div className="min-w-0 pt-0.5">
                <Segmented
                  label="Visibility"
                  segments={[
                    { id: "workspace", label: "Workspace", hint: seen.workspace },
                    { id: "private", label: "Private", hint: seen.private },
                  ]}
                  value={visibility}
                  chosenSaidBelow
                  onChange={(next) => {
                    setVisibility(next);
                    if (workspace) setWorkspace({ ...workspace, visibility: next });
                  }}
                />
                <p aria-live="polite" className="mt-1.5 text-[12px] text-muted text-pretty">
                  {seen[visibility]}.
                </p>
              </div>
            </div>
          </div>
        )}
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
        {/* Not a <label>: it holds its own buttons and pickers. */}
        <div className="nt-pal-fld">
          <span className="nt-pal-key">Context</span>
          <div className="min-w-0">
            <DraftSources value={sources} onChange={setSources} onDoor={onDoor} />
          </div>
        </div>
      </div>

      <div className="nt-pal-foot">
        {failure ? (
          <span role="alert" className="text-danger">
            {failure}
          </span>
        ) : (
          <span>
            <kbd className="nt-kbd">↵</kbd>
            {template ? `Create from ${template.name}` : "Create"}
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
