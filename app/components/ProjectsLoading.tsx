"use client";

import { useState } from "react";
import { AccountMenu } from "./AccountMenu";
import "./workspaces/workspaces.css";

/**
 * The projects screen before it has anything to show: the view it was left
 * in, and the shape that view takes while its projects are on their way.
 */

export type View = "grid" | "list" | "board";
export const VIEWS: View[] = ["grid", "list", "board"];
export const VIEW_KEY = "nt:projectsView";

/** The view this browser left the screen in. */
export function savedView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY) as View | null;
    return saved && VIEWS.includes(saved) ? saved : "grid";
  } catch {
    return "grid";
  }
}

/**
 * Loading takes the shape of the view it is loading into, so content swaps in
 * without the page rearranging under the cursor.
 */
export function Skeletons({ view }: { view: View }) {
  // The board has no resting shape to hold: frames land on it as they arrive.
  if (view === "board") return null;
  if (view === "list") {
    return (
      <ul aria-busy="true" aria-label="Loading projects">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="nt-list-row">
            <span
              className="nt-skeleton ml-2 h-4 flex-1"
              style={{ maxWidth: `${[52, 38, 61, 45][i]}%`, animationDelay: `${i * 110}ms` }}
            />
            <span className="nt-skeleton nt-col-pages h-3" />
            <span className="nt-skeleton nt-col-when h-3" />
            <span className="nt-col-actions" />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="nt-grid" aria-busy="true" aria-label="Loading projects">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i}>
          <div className="nt-card">
            <span className="nt-card-well">
              <span
                className="nt-skeleton block aspect-[4/3] rounded-b-none"
                style={{ animationDelay: `${i * 90}ms` }}
              />
            </span>
            <div className="nt-card-foot">
              <span className="nt-skeleton h-3.5 flex-1" style={{ maxWidth: "60%" }} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * A workspace's home before its address has said which workspace it is — a
 * first visit to it from this browser, with nothing remembered to draw
 * (`ContainerRoute`). The screen's own frame, its title still to come and its
 * cards on their way, so arriving somewhere new never passes through a blank
 * page. Only ever drawn in the browser: the view is read from its storage.
 */
export function HomeLoading() {
  const [view] = useState(savedView);
  return (
    <main
      className="mx-auto w-full px-6 py-12 sm:px-8 sm:py-16"
      style={{ maxWidth: "76rem" }}
      aria-busy="true"
    >
      <header className="nt-front-head nt-ws-head">
        <div className="nt-tools">
          <span className="nt-tools-me">
            <AccountMenu align="start" />
          </span>
        </div>
        <h1 className="nt-front-title">
          <span className="nt-skeleton inline-block h-6 w-44 align-middle" />
        </h1>
        <div className="nt-front-new" />
      </header>
      <div className="mt-8">
        <Skeletons view={view} />
      </div>
    </main>
  );
}
