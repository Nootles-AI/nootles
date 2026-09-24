"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { useQuery } from "convex/react";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ProjectRole } from "@/convex/roles";
import { projectPath } from "@/app/lib/containerPaths";
import { Editable } from "./Editable";
import { Lock, MoreHorizontal } from "./Icons";
import { Menu, MenuItem } from "./Menu";
import { useStandIn } from "./StandIn";
import { Tooltip } from "./Tooltip";
import { slugOf, useContainer } from "./workspaces/ContainerContext";

/**
 * What every view of the projects screen is made of — the link that opens a
 * project, its ⋯ menu, the rename field — written once so the grid, the list
 * and the board cannot drift apart.
 */

/**
 * A project a home lists: one of yours, or one of a workspace's — which also
 * says what you are in it, since there not everything listed is yours to
 * rename or delete.
 */
export type Project = NonNullable<
  ReturnType<typeof useQuery<typeof api.projects.listForScreen>>
>[number] & { role?: ProjectRole };
export type SharedProject = NonNullable<
  ReturnType<typeof useQuery<typeof api.projects.sharedWithMe>>
>[number];

/** Your standing in someone else's project, in the words Docs taught. */
/**
 * `memo`'s comparison for anything that draws one of the owner's projects.
 *
 * By what is drawn rather than by identity, because identity is not stable
 * across the one moment it matters: the screen paints from what this browser
 * last saw (`projectsCache`) and the live list then arrives as all new objects.
 * Nearly always the same projects — and every card was redrawing to say so.
 */
export function sameProjectProps<P extends { project: Project }>(prev: P, next: P) {
  for (const key in next) {
    if (key !== "project" && prev[key] !== next[key]) return false;
  }
  const a = prev.project;
  const b = next.project;
  return (
    a === b ||
    (a._id === b._id &&
      a.title === b.title &&
      a.description === b.description &&
      a.pageCount === b.pageCount &&
      a.updatedAt === b.updatedAt &&
      a.firstPageDocId === b.firstPageDocId &&
      a.visibility === b.visibility &&
      a.role === b.role)
  );
}

/** Whether the rename and delete verbs are yours: always on your own home. */
export const manages = (p: Project) => p.role === undefined || p.role === "owner";

/**
 * What a private workspace project wears wherever it is listed: right after
 * its name, in every view. Raised over the stretched link (`nt-private`) so
 * its tooltip can be found. The tooltip is a label, not the sentence the
 * Visibility switch says it in — it names who can open it, which is also who
 * it is shown to, so it cannot say "hidden".
 */
export function PrivateMark({ size = 12 }: { size?: number }) {
  return (
    <Tooltip label="Private to its maker, owners and admins" className="nt-private">
      <Lock width={size} height={size} role="img" aria-label="Private" />
    </Tooltip>
  );
}

export const roleLabel = (p: Pick<SharedProject, "role">) =>
  p.role === "editor" ? "can edit" : p.role === "commenter" ? "can comment" : "view only";

/**
 * The link that opens a project, in both views.
 *
 * A real anchor, so ⌘-click opens a project in its own tab — and so its hit
 * area can be stretched over the whole card or row (`nt-card-link`,
 * `nt-row-open`) without nesting the ⋯ menu inside it.
 *
 * The hover fetches the workspace route ahead of the click. That route carries
 * the editor, which is the heaviest bundle in the app, and paying for it while
 * the cursor is still travelling is most of what makes opening a project feel
 * immediate. Link's own prefetch is off because it fires on VIEWPORT entry:
 * a shelf of sixty cards would open sixty requests to warm sixty routes nobody
 * asked for. Hovering one is the closest thing to intent there is.
 */
export function OpenProject({
  id,
  className,
  children,
}: {
  id: Id<"projects">;
  className: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const container = useContainer();
  const href = projectPath(slugOf(container), id);
  return (
    <Link
      href={href}
      prefetch={false}
      onPointerEnter={() => router.prefetch(href)}
      className={className}
    >
      {children}
    </Link>
  );
}

/** The actions every view offers, so the two never drift apart. */
export function RowMenu({
  project,
  onOpen,
  onRename,
  onExport,
  onDelete,
  className,
}: {
  project: Project;
  onOpen: () => void;
  onRename: () => void;
  onExport: () => void;
  onDelete: () => void;
  className?: string;
}) {
  const name = project.title || "Untitled project";
  return (
    <Menu
      label={`Actions for ${name}`}
      side="bottom"
      align="end"
      trigger={(t) => (
        <button
          {...t}
          aria-label={`Actions for ${name}`}
          className={`nt-icon-btn ${className ?? ""}`}
        >
          <MoreHorizontal />
        </button>
      )}
    >
      {(close) => (
        <ProjectActions
          close={close}
          manage={manages(project)}
          onOpen={onOpen}
          onRename={onRename}
          onExport={project.workspaceId ? undefined : onExport}
          onDelete={onDelete}
        />
      )}
    </Menu>
  );
}

/**
 * The things an owner can do to a project, written once so the ⋯ menu and the
 * right-click menu cannot drift apart.
 *
 * Rename and delete both close with `restoreFocus: false`, because both hand
 * focus to something of their own — the rename field, the confirm dialog — and
 * a menu that insists on taking focus back afterwards undoes them.
 */
export function ProjectActions({
  close,
  manage,
  onOpen,
  onRename,
  onExport,
  onDelete,
}: {
  close: (opts?: { restoreFocus?: boolean }) => void;
  /** Whether the project is the caller's to rename and delete (`manages`). */
  manage: boolean;
  onOpen: () => void;
  onRename: () => void;
  /**
   * Downloads the project's comment activity (its audit log) as CSV. Absent
   * for a workspace project, whose activity is its workspace's log, read and
   * exported in the workspace's Audit settings.
   */
  onExport?: () => void;
  onDelete: () => void;
}) {
  // An operator standing in keeps Open — looking is the whole point — and
  // loses the two verbs the server would refuse, as does anyone the project
  // is not theirs to manage.
  const standIn = useStandIn();
  return (
    <>
      <MenuItem
        onClick={() => {
          onOpen();
          close();
        }}
      >
        Open
      </MenuItem>
      {!standIn && manage && (
        <>
          <MenuItem
            onClick={() => {
              onRename();
              close({ restoreFocus: false });
            }}
          >
            Rename
          </MenuItem>
          {onExport && (
            <MenuItem
              onClick={() => {
                onExport();
                close();
              }}
            >
              Export comment activity
            </MenuItem>
          )}
          <div className="nt-menu-sep" />
          <MenuItem
            danger
            onClick={() => {
              onDelete();
              close({ restoreFocus: false });
            }}
          >
            Delete…
          </MenuItem>
        </>
      )}
    </>
  );
}

/**
 * The rename field, identical in both views so the interaction is one thing.
 *
 * It owns the draft. Held one level up it was screen state, and every keystroke
 * re-rendered every other card on the screen — thumbnails, maths and diagrams
 * included — to type into this one.
 */
export function NameField({
  initial,
  onCommit,
  onCancel,
  className,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  className: string;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <Editable
      autoFocus
      value={draft}
      label="Project name"
      onInput={setDraft}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(draft);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className={className}
    />
  );
}
