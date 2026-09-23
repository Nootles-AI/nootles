"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useConvex, useConvexAuth, useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { findTemplate } from "@/app/lib/templates";
import { track } from "@/app/lib/telemetry";
import { pages, when } from "@/app/lib/projectMeta";
import { projectPath } from "@/app/lib/containerPaths";
import { ACCOUNT, rememberScreen, seenScreen } from "@/app/lib/projectsCache";
import { checkContextFile, storeContextFile } from "@/app/lib/contextFiles";
import { repoRef } from "./context/ContextSources";
import { BoardView, GridView, ListView, Plus, Search } from "./Icons";
import { AccountMenu } from "./AccountMenu";
import { PlanWall } from "./billing/PlanWall";
import { isQuotaError, usePlan } from "@/app/lib/usePlan";
import { useResumeIntent } from "@/app/lib/billing/useResumeIntent";
import { ConfirmDeleteDialog } from "./ConfirmDelete";
import { CreateProject } from "./CreateProject";
import { ContextMenu } from "./ContextMenu";
import { Feedback } from "./feedback/Feedback";
import { FixedToast } from "./feedback/FixedToast";
import { wallOf, type NewProject } from "./newProjectDraft";
import { useNotionAvailable } from "./notion/NotionAvailable";
import { ProjectPalette, useModKey, type Page as PalettePage } from "./ProjectPalette";
import { ProjectsBoard } from "./ProjectsBoard";
import { savedView, Skeletons, VIEW_KEY, VIEWS, type View } from "./ProjectsLoading";
import {
  describeOutcome,
  useNotionOutcome,
  type OutcomeLine,
} from "@/app/lib/notion/outcome";
import { PagePreview } from "./PagePreview";
import {
  manages,
  NameField,
  OpenProject,
  PrivateMark,
  RowMenu,
  ProjectActions,
  roleLabel,
  sameProjectProps,
  type Project,
  type SharedProject,
} from "./projectParts";
import { useStandIn } from "./StandIn";
import { AccessRequests } from "./share/AccessRequests";
import { slugOf, useContainer, type WorkspaceContainer } from "./workspaces/ContainerContext";
import { ContainerSwitcher } from "./workspaces/ContainerSwitcher";
import { InviteButton } from "./workspaces/Invite";
import { MembersPile } from "./workspaces/MembersPile";
import { UnpaidLine } from "./workspaces/UnpaidLine";
import { useEvenSides } from "./workspaces/useEvenSides";

/** A list item's place in its list, which is what staggers its entrance. */
const nth = (i: number) => ({ "--i": i }) as React.CSSProperties;

/** A workspace's home has no "Shared with me": what was shared there is on its list. */
const NONE: SharedProject[] = [];

/**
 * Who else a workspace project's deletion takes it from — whoever it is shown
 * to, in the words its lock and its Visibility switch use — along with what it
 * held.
 */
const lostBy = (workspace: WorkspaceContainer, project: Project) =>
  `${
    project.visibility === "private"
      ? `Its maker and ${workspace.name}’s owners and admins lose`
      : `Everyone in ${workspace.name} loses`
  } it, and its diagrams and history go with it.`;

/**
 * A home's projects: your own at `/`, or one workspace's at `/w/<slug>` —
 * whichever container this is rendered in (`useContainer`). The same screen
 * either way, so the two can never drift apart; what differs is whose
 * projects it lists, what it is called, where a new project goes, and — in a
 * workspace — the people in it.
 */
export function ProjectsScreen() {
  const router = useRouter();
  const standIn = useStandIn();
  const container = useContainer();
  const workspace = container.kind === "workspace" ? container : null;
  const slug = slugOf(container);
  const home = workspace ? workspace.workspaceId : ACCOUNT;
  // A guest was let into projects, not into the workspace: nothing is made
  // there by them, and the server says so (`projects.create`).
  const canCreate = !standIn && workspace?.role !== "guest";
  /*
   * What this browser last saw stands in until the live lists arrive
   * (`projectsCache`) — and for a returning visitor this screen is up before
   * Convex has a token (`FirstRun`), so nothing here may ask as nobody: an
   * anonymous `listForScreen` answers "no projects", which is a wrong answer
   * rather than a missing one. Read once; the live lists replace it for good.
   */
  const { isAuthenticated: live } = useConvexAuth();
  const { userId } = useAuth();
  const [seen] = useState(() => (userId ? seenScreen(userId, home) : null));
  const liveMine = useQuery(api.projects.listForScreen, live && !workspace ? {} : "skip");
  const liveHere = useQuery(
    api.workspaces.projectsFor,
    live && workspace ? { workspaceId: workspace.workspaceId } : "skip",
  );
  const liveShared = useQuery(api.projects.sharedWithMe, live && !workspace ? {} : "skip");
  const liveProjects: Project[] | undefined = workspace ? liveHere : liveMine;
  const projects = liveProjects ?? seen?.projects;
  const shared = workspace ? NONE : (liveShared ?? seen?.shared);
  const liveOthers = workspace ? NONE : liveShared;
  useEffect(() => {
    if (userId && liveProjects && liveOthers) {
      rememberScreen(userId, home, liveProjects, liveOthers);
    }
  }, [userId, home, liveProjects, liveOthers]);
  const head = useRef<HTMLElement>(null);
  useEvenSides(head, !!workspace);
  const createProject = useMutation(api.projects.create);
  const convex = useConvex();
  const renameProject = useMutation(api.projects.rename);
  const removeProject = useMutation(api.projects.remove);

  // Read where it is first needed rather than restored in an effect, which
  // mounted the whole grid — every card and its reader — only to tear it down a
  // frame later for anyone who had left the screen in another view. Safe to
  // read during render because this never renders on the server or in the
  // hydration pass: `FirstRun` holds it back until there is an answer from
  // Convex or from this browser's storage, and neither exists before then.
  const [view, setView] = useState<View>(savedView);
  const [editingId, setEditingId] = useState<Id<"projects"> | null>(null);
  const [confirming, setConfirming] = useState<Project | null>(null);
  const [ctx, setCtx] = useState<{ project: Project; x: number; y: number } | null>(
    null,
  );
  // Back from Notion's consent screen, which the palette's import page sent
  // them to: a grant reopens the palette on the page they left, and anything
  // else is said in the notice line. Initial state rather than an effect — the
  // outcome is known before the first render and is not derived from anything
  // that changes.
  const notion = useNotionOutcome();
  // The palette, and the page it opens on: search opens it at the root, each of
  // the header's ways to start opens it on that way's page.
  const [finding, setFinding] = useState<PalettePage | null>(
    notion.outcome === "connected" ? "notion" : null,
  );
  const mod = useModKey();
  // Absent, not disabled, on a deployment without the integration: a door
  // that opens onto "set this env var" is not a door.
  const notionAvailable = useNotionAvailable();
  // The plan's wall, and — when it met a Create button — the project that was
  // being made, so paying (or a code) makes it exactly as it was written.
  const [walled, setWalled] = useState<{ project?: NewProject } | null>(null);
  const [notice, setNotice] = useState<OutcomeLine | null>(
    notion.outcome && notion.outcome !== "connected"
      ? describeOutcome(notion.outcome, notion.reason)
      : null,
  );
  const setFailure = useCallback((text: string) => setNotice({ text, problem: true }), []);
  const { room } = usePlan();

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Storage refused: the view just does not outlive the visit.
    }
  }, [view]);

  /**
   * Making a project happens in the palette, whichever door was used — the
   * header, its menu, the empty state, a shortcut, coming back from the wall.
   * None of them stops at the plan's limit: someone out of projects still
   * writes the whole project, and meets the wall at its Create button, with
   * what they wrote kept for the way back (`create`). The import alone is
   * asked first, since what it makes is decided on Notion's side.
   */
  const hasRoom = room("projects");
  // An import started on a workspace's home lands in that workspace, whose
  // projects never count against your own plan.
  const start = useCallback(
    (page: PalettePage) =>
      page === "notion" && !hasRoom && !workspace ? setWalled({}) : setFinding(page),
    [hasRoom, workspace],
  );
  const importable = notionAvailable === true;

  // ⌘K from anywhere on the screen, a rename field included — it is a chord, so
  // it cannot be mistaken for typing. N starts a project, and being a bare key
  // it stands down wherever one could be typing. ⌘N is accepted too, but a
  // browser tab keeps that for "new window" and never delivers it, so N is the
  // one the button advertises. Neither while another dialog is up: the palette
  // would open over a form that is in the middle of being filled in.
  const busy = walled !== null || confirming !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || e.altKey) return;
      // The dialogs this screen does not hold itself (New workspace, Invite)
      // are known by where the key was pressed.
      if (!finding && e.target instanceof Element && e.target.closest("[role='dialog']")) return;
      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (key === "k" && mod) {
        e.preventDefault();
        setFinding((f) => (f ? null : "root"));
      } else if (key === "n" && canCreate && !finding) {
        const typing = (e.target as HTMLElement).closest("input, textarea, [contenteditable]");
        if (!mod && typing) return;
        e.preventDefault();
        start("create");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, finding, canCreate, start]);

  // Stable so the memoized cards and rows sit out this screen's re-renders —
  // every one of them carries a live PagePreview, and a rename keystroke was
  // re-rendering the lot.
  const open = useCallback(
    (id: Id<"projects">) => router.push(projectPath(slug, id)),
    [router, slug],
  );
  const startRename = useCallback((p: Project) => setEditingId(p._id), []);
  const cancelRename = useCallback(() => setEditingId(null), []);
  const askDelete = useCallback((p: Project) => setConfirming(p), []);
  const askContext = useCallback(
    (project: Project, x: number, y: number) => setCtx({ project, x, y }),
    [],
  );

  /**
   * An empty name is not a rename, and silently restoring the old one looks
   * like the keystroke was lost. It says so instead, and keeps the field open.
   */
  const commitRename = useCallback(
    (id: Id<"projects">, name: string) => {
      const title = name.trim();
      if (!title) {
        setFailure("A project needs a name.");
        return;
      }
      setEditingId(null);
      renameProject({ projectId: id, title }).catch(() =>
        setFailure("That rename didn’t save."),
      );
    },
    [renameProject, setFailure],
  );

  const openCreate = useCallback(() => setFinding("create"), []);

  /** Makes it, and opens it. The plan is the server's to enforce. */
  const make = async (project: NewProject) => {
    // A template's pages become documents here, in the browser, at the moment
    // one is used — the builder brings the editor with it, so it is not part of
    // this screen's bundle.
    const template = project.template ? findTemplate(project.template) : undefined;
    const seed = template
      ? (await import("@/app/lib/templates/seed")).seedOf(template)
      : undefined;
    const { repos, files, pages } = project.sources;
    // Its sources are attached as it is made, not added to it after: a
    // member's workspace project is its admins' to add to once it exists. So
    // the files go up first — every one checked before any bytes move, so a
    // refusal is said on the form with nothing left behind.
    files.forEach(checkContextFile);
    const stored = await Promise.all(files.map((file) => storeContextFile(convex, file)));
    const id = await createProject({
      title: project.title,
      ...(project.description ? { description: project.description } : {}),
      ...(repos.length ? { repos: repos.map(repoRef) } : {}),
      ...(pages.length ? { pages } : {}),
      ...(stored.length ? { files: stored } : {}),
      ...(seed ? { seed } : {}),
      ...(project.workspace
        ? {
            workspaceId: project.workspace.workspaceId,
            visibility: project.workspace.visibility,
          }
        : {}),
    });
    track("project_created", {});
    // Straight to its own address, not through `/p/`'s redirect to it.
    router.push(projectPath(project.workspace?.slug ?? null, id));
  };

  /**
   * The Create button. Out of projects, nothing is made and nothing is lost:
   * the wall comes up over the form, which is handed back as it was, and the
   * project rides along to be made on the way back. The server has the last
   * word either way — a refusal it sends is the same wall. A workspace's
   * projects are the workspace's, and never count against your own.
   */
  const create = async (project: NewProject): Promise<boolean> => {
    if (!project.workspace && !hasRoom) {
      setWalled({ project });
      return false;
    }
    try {
      await make(project);
      return true;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      setWalled({ project });
      return false;
    }
  };

  // Paid for mid-thought and came back: the project they were making is made,
  // as they wrote it, and opened — the wall was a pause in making it, not a
  // detour to retrace. Without one (a wall met some other way), the palette
  // opens where making one starts. Straight to the server rather than through
  // `create`: the plan on this screen may not have caught up with the payment.
  useResumeIntent("newProject", live, (intent) => {
    if (!intent.project) return openCreate();
    // A chosen file is bytes this tab held, and the trip out came back as
    // JSON without them.
    const project = { ...intent.project, sources: { ...intent.project.sources, files: [] } };
    make(project).catch((error: unknown) => {
      if (isQuotaError(error)) setWalled({ project });
      else setFailure("Couldn’t create that project.");
    });
  });

  const confirmRemove = () => {
    if (!confirming) return;
    const doomed = confirming;
    setConfirming(null);
    removeProject({ projectId: doomed._id }).catch(() =>
      setFailure(`Couldn’t delete “${doomed.title || "Untitled project"}”.`),
    );
  };

  return (
    <main
      className="mx-auto w-full px-6 py-12 sm:px-8 sm:py-16"
      style={{ maxWidth: "76rem" }}
    >
      {/* Three parts on one line: what you look and move with on the left, whose
          place this is in the middle, and the one thing that makes something
          new alone on the right — the filled control has a side to itself, so
          nothing competes with it for "start here". */}
      {/* On the board the header lies over the canvas rather than above it, so
          it is lifted onto its own layer — see `.nt-board-host`. */}
      <header
        ref={head}
        className={`nt-front-head${workspace ? " nt-ws-head" : ""}${view === "board" ? " nt-board-host" : ""}`}
      >
        <div className="nt-tools">
          {/* Held at its size while the account loads: it is first in the row
              now, and a circle arriving late would push everything after it. */}
          <span className="nt-tools-me">
            <AccountMenu align="start" />
          </span>

          <div
            className="nt-mode is-slide"
            role="group"
            aria-label="View"
            data-at={VIEWS.indexOf(view)}
          >
            <button
              onClick={() => setView("grid")}
              aria-pressed={view === "grid"}
              aria-label="Grid view"
              className={`nt-mode-btn is-icon${view === "grid" ? " is-on" : ""}`}
            >
              <GridView width={14} height={14} />
            </button>
            <button
              onClick={() => setView("list")}
              aria-pressed={view === "list"}
              aria-label="List view"
              className={`nt-mode-btn is-icon${view === "list" ? " is-on" : ""}`}
            >
              <ListView width={14} height={14} />
            </button>
            <button
              onClick={() => setView("board")}
              aria-pressed={view === "board"}
              aria-label="Board view"
              className={`nt-mode-btn is-icon${view === "board" ? " is-on" : ""}`}
            >
              <BoardView width={14} height={14} />
            </button>
          </div>

          {/* A button dressed as a field: search here is the palette, and this
              is both the way in and where its shortcut is written down. */}
          <button onClick={() => setFinding("root")} className="nt-find" aria-label="Search projects">
            <Search width={14} height={14} />
            <span>Search projects</span>
            <kbd className="nt-kbd">{mod}K</kbd>
          </button>
        </div>

        <ContainerSwitcher onProblem={setFailure} />

        <div className={`nt-front-new${workspace ? " items-center gap-2" : ""}`}>
          {/* In a workspace, who is in it comes first — and, for whoever may
              let someone in, the way to. */}
          {workspace && <MembersPile workspace={workspace} />}
          {workspace && !standIn && (workspace.role === "owner" || workspace.role === "admin") && (
            <InviteButton workspace={workspace} />
          )}
          {/* Nothing here belongs to a project, so no project's role gates
              it — only whether anything may be made here at all: not by an
              operator standing in, nor by a workspace's guest, each of whom
              would be offered a button the server is about to refuse. */}
          {/* The button never disappears when the free projects are gone — it
              opens the wall instead. An affordance that vanishes reads as a
              bug; one that explains itself reads as a limit. */}
          {/* One filled control with the rarer doors inside it: a blank project
              is one click, and importing is a part of creating rather than a
              second button competing with it. */}
          {canCreate && (
            <CreateProject
              notion={importable}
              onNew={() => start("create")}
              onBlank={() => start("details")}
              onTemplate={() => start("template")}
              onNotion={() => start("notion")}
            />
          )}
        </div>
      </header>

      {workspace && (
        <UnpaidLine workspace={workspace} className={view === "board" ? "nt-board-host" : ""} />
      )}

      {/* One place for anything worth a sentence — a mutation that failed, a
          connection that was cancelled — rather than either happening in
          silence. Only a problem wears danger ink. */}
      {notice && (
        <p
          role={notice.problem ? "alert" : "status"}
          className={`mt-3 text-[13px] ${notice.problem ? "text-danger" : "text-muted"}${
            view === "board" ? " nt-board-host" : ""
          }`}
        >
          {notice.text}
        </p>
      )}

      <div className="mt-8">
        {projects === undefined ? (
          <Skeletons view={view} />
        ) : projects.length === 0 ? (
          <Empty workspace={workspace} onCreate={canCreate ? () => start("create") : null} />
        ) : view === "board" ? (
          <ProjectsBoard
            projects={projects}
            shared={shared ?? []}
            editingId={editingId}
            onOpen={open}
            onRename={startRename}
            onCommit={commitRename}
            onCancel={cancelRename}
            onDelete={askDelete}
            onContext={askContext}
          />
        ) : view === "grid" ? (
          <>
          <div
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({ project: projects[0], x: e.clientX, y: e.clientY });
            }}
          >
            <Lead
              project={projects[0]}
              editing={editingId === projects[0]._id}
              onOpen={open}
              onRename={startRename}
              onCommit={commitRename}
              onCancel={cancelRename}
              onDelete={askDelete}
            />
          </div>
          <ul className="nt-grid">
            {projects.slice(1).map((p, i) => (
              <li
                key={p._id}
                style={nth(i)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtx({ project: p, x: e.clientX, y: e.clientY });
                }}
              >
                <Card
                  project={p}
                  editing={editingId === p._id}
                  onOpen={open}
                  onRename={startRename}
                  onCommit={commitRename}
                  onCancel={cancelRename}
                  onDelete={askDelete}
                />
              </li>
            ))}
          </ul>
          </>
        ) : (
          <div>
            <div className="nt-list-head" aria-hidden="true">
              <span className="flex-1">Name</span>
              <span className="nt-col-pages">Pages</span>
              <span className="nt-col-when">Edited</span>
              <span className="nt-col-actions" />
            </div>
            <ul className="mt-1">
              {projects.map((p, i) => (
                <li
                  key={p._id}
                  style={nth(i)}
                  className="nt-list-row group"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtx({ project: p, x: e.clientX, y: e.clientY });
                  }}
                >
                  <Row
                    project={p}
                    editing={editingId === p._id}
                    onOpen={open}
                    onRename={startRename}
                    onCommit={commitRename}
                    onCancel={cancelRename}
                    onDelete={askDelete}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* What other people have opened to this account — always after "mine",
          never mixed in: whose project it is is the fact that orders the page.
          Absent entirely until the first claim, so the front door of a
          one-person account never mentions a feature it isn't using. */}
      {view !== "board" && shared && shared.length > 0 && (
        <section className="mt-12" aria-labelledby="shared-with-me">
          {/* The same voice as PAGES and LAYERS — the mono label is how this
              app says "a section of items", and it leaves the project names
              as the only things at reading weight. Flush in grid view, where
              its inset would misalign it with the card borders below. */}
          <h2
            id="shared-with-me"
            className={`nt-section-label${view === "grid" ? " pl-0" : ""}`}
          >
            <span>Shared with me</span>
          </h2>
          {view === "grid" ? (
            <ul className="nt-grid mt-2">
              {shared.map((p, i) => (
                <li key={p._id} style={nth(i)}>
                  <SharedCard project={p} />
                </li>
              ))}
            </ul>
          ) : (
            <ul className="mt-1">
              {shared.map((p, i) => (
                <li key={p._id} style={nth(i)} className="nt-list-row">
                  <SharedRow project={p} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          label={`Actions for ${ctx.project.title || "Untitled project"}`}
          onClose={() => setCtx(null)}
        >
          <ProjectActions
            close={() => setCtx(null)}
            manage={manages(ctx.project)}
            onOpen={() => open(ctx.project._id)}
            onRename={() => startRename(ctx.project)}
            onDelete={() => setConfirming(ctx.project)}
          />
        </ContextMenu>
      )}

      {/* Held until the account is live, like everything below that asks
          Convex something: asked for a beat early, it opens a beat later. */}
      {finding && live && (
        <ProjectPalette
          start={finding}
          projects={projects ?? []}
          shared={shared ?? []}
          canCreate={canCreate}
          room={hasRoom}
          notion={importable}
          onOpen={open}
          onWall={() => setWalled({})}
          onCreate={create}
          onClose={() => setFinding(null)}
        />
      )}

      {walled && (
        <PlanWall
          meter="projects"
          workspaceId={wallOf(walled.project)}
          intent={{ kind: "newProject", project: walled.project }}
          // Dismissed, it closes onto the palette still holding the form.
          onClose={() => setWalled(null)}
          onResume={() => {
            const { project } = walled;
            setWalled(null);
            if (!project) return openCreate();
            // Granted in place — a code — so the palette is still up over the
            // form; the project is made and opened from it.
            make(project).catch(() => setFailure("Couldn’t create that project."));
          }}
        />
      )}

      {confirming && (
        <ConfirmDeleteDialog
          title={confirming.title || "Untitled project"}
          what={`“${confirming.title || "Untitled project"}” and its ${pages(
            confirming.pageCount,
          )}`}
          consequence={workspace ? lostBy(workspace, confirming) : undefined}
          onCancel={() => setConfirming(null)}
          onConfirm={confirmRemove}
        />
      )}

      {/* The front door is where someone lands, so it is where news of a fix
          should reach them — and something worth reporting is as likely to be
          here as inside a project. Filed without a project, which `submit`
          already allows. */}
      {live && <Feedback />}
      {live && <FixedToast />}
      {/* Same reasoning: someone asking to edit should reach the owner here
          too, not only inside whichever project they happen to open. */}
      {live && <AccessRequests />}
    </main>
  );
}

/**
 * The project touched last, wide enough to say what it is. Everything a card
 * does it does too — open, rename in place, the ⋯ menu — so being first in the
 * list costs a project none of its verbs.
 */
const Lead = memo(function Lead({
  project,
  editing,
  onOpen,
  onRename,
  onCommit,
  onCancel,
  onDelete,
}: {
  project: Project;
  editing: boolean;
  onOpen: (id: Id<"projects">) => void;
  onRename: (project: Project) => void;
  onCommit: (id: Id<"projects">, name: string) => void;
  onCancel: () => void;
  onDelete: (project: Project) => void;
}) {
  return (
    <div className="nt-lead">
      <span className="nt-lead-well">
        <PagePreview docId={project.firstPageDocId} />
      </span>
      <div className="nt-lead-text">
        {editing ? (
          <NameField
            initial={project.title}
            onCommit={(text) => onCommit(project._id, text)}
            onCancel={onCancel}
            className="nt-lead-name relative block w-full"
          />
        ) : (
          <div className="nt-card-title">
            <OpenProject id={project._id} className="nt-lead-name nt-card-link">
              {project.title || "Untitled project"}
            </OpenProject>
            {project.visibility === "private" && <PrivateMark size={16} />}
          </div>
        )}
        {project.description && <p className="nt-lead-line">{project.description}</p>}
        <p className="nt-card-meta">
          <span>{pages(project.pageCount)}</span>
          <span aria-hidden="true">·</span>
          <span>edited {when(project.updatedAt)}</span>
        </p>
      </div>
      <RowMenu
        project={project}
        onOpen={() => onOpen(project._id)}
        onRename={() => onRename(project)}
        onDelete={() => onDelete(project)}
      />
    </div>
  );
}, sameProjectProps);

/** Memoized for the same reason `SharedCard` is: a live PagePreview each. */
const Card = memo(function Card({
  project,
  editing,
  onOpen,
  onRename,
  onCommit,
  onCancel,
  onDelete,
}: {
  project: Project;
  editing: boolean;
  onOpen: (id: Id<"projects">) => void;
  onRename: (project: Project) => void;
  onCommit: (id: Id<"projects">, name: string) => void;
  onCancel: () => void;
  onDelete: (project: Project) => void;
}) {
  const name = project.title || "Untitled project";
  const open = () => onOpen(project._id);
  return (
    <div className="nt-card group">
      <span className="nt-card-well">
        <PagePreview docId={project.firstPageDocId} />
      </span>

      <div className="nt-card-foot">
        <div className="min-w-0 flex-1">
          {editing ? (
            <NameField
              initial={project.title}
              onCommit={(text) => onCommit(project._id, text)}
              onCancel={onCancel}
              className="nt-card-name block w-full"
            />
          ) : (
            /* The chin opens the project the way the thumbnail does: a card
               that says "23 pages · 2d ago" under a picture of the page reads
               as one target, and half of it used to be dead. */
            <div className="nt-card-title">
              <OpenProject id={project._id} className="nt-card-name nt-card-link">
                {name}
              </OpenProject>
              {project.visibility === "private" && <PrivateMark />}
            </div>
          )}
          <p className="nt-card-meta">
            <span>{pages(project.pageCount)}</span>
            <span aria-hidden="true">·</span>
            <span>{when(project.updatedAt)}</span>
          </p>
        </div>
        <RowMenu
          project={project}
          onOpen={open}
          onRename={() => onRename(project)}
          onDelete={() => onDelete(project)}
          className="is-sm"
        />
      </div>
    </div>
  );
}, sameProjectProps);

const Row = memo(function Row({
  project,
  editing,
  onOpen,
  onRename,
  onCommit,
  onCancel,
  onDelete,
}: {
  project: Project;
  editing: boolean;
  onOpen: (id: Id<"projects">) => void;
  onRename: (project: Project) => void;
  onCommit: (id: Id<"projects">, name: string) => void;
  onCancel: () => void;
  onDelete: (project: Project) => void;
}) {
  const name = project.title || "Untitled project";
  const open = () => onOpen(project._id);
  return (
    <>
      {editing ? (
        <NameField
          initial={project.title}
          onCommit={(text) => onCommit(project._id, text)}
          onCancel={onCancel}
          className="nt-row-edit is-selected min-w-0 flex-1 font-medium"
        />
      ) : (
        /* Same reach as the card's chin: the name's hit area covers the whole
           row, so the pages and edited columns are not dead space. */
        <OpenProject
          id={project._id}
          className="nt-row nt-row-open min-w-0 flex-1 font-medium"
        >
          {project.visibility === "private" ? (
            <>
              <span className="nt-row-label flex-initial">{name}</span>
              <PrivateMark />
            </>
          ) : (
            <span className="nt-row-label">{name}</span>
          )}
        </OpenProject>
      )}
      {/* Held in the layout while renaming rather than unmounted, so the row
          does not change shape as the field opens. */}
      <span className="nt-meta nt-col-pages" aria-hidden={editing}>
        {editing ? "" : project.pageCount}
      </span>
      <span className="nt-meta nt-col-when" aria-hidden={editing}>
        {editing ? "" : when(project.updatedAt)}
      </span>
      <span className="nt-col-actions">
        <RowMenu
          project={project}
          onOpen={open}
          onRename={() => onRename(project)}
          onDelete={() => onDelete(project)}
          className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
        />
      </span>
    </>
  );
}, sameProjectProps);

/**
 * A project someone else shared: the same card, none of the owner's verbs — no
 * rename, no delete, no ⋯ menu. Opening it is the whole affordance.
 *
 * The meta spends its one line on whose project it is and what you are to it —
 * the date is dropped, because two facts fit an ordinary name and three
 * truncate it. Only the unbounded name gives way; the role always survives.
 * No name recorded means the by-clause is simply absent — under this section's
 * heading, "shared" would say nothing.
 *
 * Memoized (row too): these carry live PagePreviews, and this screen re-renders
 * on every rename keystroke. Holds because the query result is referentially
 * stable between server updates.
 */
const SharedCard = memo(function SharedCard({
  project,
}: {
  project: SharedProject;
}) {
  const name = project.title || "Untitled project";
  return (
    <div className="nt-card">
      <span className="nt-card-well">
        <PagePreview docId={project.firstPageDocId} />
      </span>
      <div className="nt-card-foot">
        <div className="min-w-0 flex-1">
          <OpenProject id={project._id} className="nt-card-name nt-card-link">
            {name}
          </OpenProject>
          <p className="nt-card-meta">
            {project.ownerName && (
              <>
                <span className="truncate">by {project.ownerName}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="shrink-0">{roleLabel(project)}</span>
          </p>
        </div>
      </div>
    </div>
  );
});

const SharedRow = memo(function SharedRow({
  project,
}: {
  project: SharedProject;
}) {
  const name = project.title || "Untitled project";
  return (
    <>
      {/* The label gives up its grow so the attribution reads as the name's
          subtitle rather than a far-right column. Only the unbounded owner
          name truncates — the role rides in its own span so "can edit" is
          never what falls off the end. Below sm the fixed columns leave the
          name no room to share, so the attribution stands down entirely. */}
      <OpenProject
        id={project._id}
        className="nt-row nt-row-open min-w-0 flex-1 font-medium"
      >
        <span className="nt-row-label flex-initial">{name}</span>
        <span className="hidden min-w-0 items-center gap-2 font-normal text-muted sm:flex">
          {project.ownerName && (
            <>
              <span className="truncate">by {project.ownerName}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="shrink-0">{roleLabel(project)}</span>
        </span>
      </OpenProject>
      <span className="nt-meta nt-col-pages">{project.pageCount}</span>
      <span className="nt-meta nt-col-when">{when(project.updatedAt)}</span>
      <span className="nt-col-actions" />
    </>
  );
});

/**
 * Teaches what a project is — or, in a workspace, what a workspace is — and
 * offers the one action worth taking, to whoever may take it.
 */
function Empty({
  workspace,
  onCreate,
}: {
  workspace: WorkspaceContainer | null;
  onCreate: (() => void) | null;
}) {
  return (
    <div className="rounded-lg bg-surface px-6 py-16 text-center">
      <p className="text-sm font-medium">
        {workspace ? `No projects in ${workspace.name} yet` : "No projects yet"}
      </p>
      <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-muted">
        {!workspace
          ? "A project holds a set of pages — prose, diagrams and maths in one place. The first one arrives with a blank page ready to go."
          : workspace.role === "guest"
            ? `Projects in ${workspace.name} that are shared with you will be here.`
            : `A workspace is where a team keeps its projects together. Everyone in ${workspace.name} can open what’s made here, unless it’s made private.`}
      </p>
      {onCreate && (
        <button
          onClick={onCreate}
          className="nt-row mx-auto mt-5 gap-1.5 bg-background px-3 font-medium"
        >
          <Plus width={14} height={14} />
          New project
        </button>
      )}
    </div>
  );
}
