"use client";

import Link from "next/link";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { when } from "@/app/lib/projectMeta";
import { projectPath, settingsPath } from "@/app/lib/containerPaths";
import { AccountMenu } from "../AccountMenu";
import { Settings } from "../Icons";
import { useContainer } from "./ContainerContext";

/** A list item's place in its list, which is what staggers its entrance. */
const nth = (i: number) => ({ "--i": i }) as React.CSSProperties;

/**
 * A workspace's projects: every one the caller can open there
 * (`workspaces.projectsFor`), in the projects screen's list.
 */
export function WorkspaceHome() {
  const container = useContainer();
  const { isAuthenticated } = useConvexAuth();
  const workspace = container.kind === "workspace" ? container : null;
  const projects = useQuery(
    api.workspaces.projectsFor,
    workspace && isAuthenticated ? { workspaceId: workspace.workspaceId } : "skip",
  );
  if (!workspace) return null;

  return (
    <main className="mx-auto w-full px-6 py-12 sm:px-8 sm:py-16" style={{ maxWidth: "76rem" }}>
      <header className="nt-front-head">
        <div className="nt-tools">
          <span className="nt-tools-me">
            <AccountMenu align="start" />
          </span>
        </div>
        <h1 className="nt-front-title">{workspace.name}</h1>
        <div className="nt-front-new">
          {workspace.role !== "guest" && (
            <Link
              href={settingsPath(workspace.slug)}
              className="nt-icon-btn"
              aria-label="Workspace settings"
              title="Workspace settings"
            >
              <Settings />
            </Link>
          )}
        </div>
      </header>

      <div className="mt-8">
        {projects === undefined ? (
          <div aria-busy="true" />
        ) : projects.length === 0 ? (
          <div className="rounded-lg bg-surface px-6 py-16 text-center">
            <p className="text-sm font-medium">No projects in {workspace.name} yet</p>
            <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-muted">
              A workspace is where a team keeps its projects together — everyone
              in it can find them here.
            </p>
          </div>
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
                <li key={p._id} style={nth(i)} className="nt-list-row group">
                  <Link
                    href={projectPath(workspace.slug, p._id)}
                    className="nt-row nt-row-open min-w-0 flex-1 font-medium"
                  >
                    <span className="nt-row-label">{p.title || "Untitled project"}</span>
                  </Link>
                  <span className="nt-meta nt-col-pages">{p.pageCount}</span>
                  <span className="nt-meta nt-col-when">{when(p.updatedAt)}</span>
                  <span className="nt-col-actions" />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
