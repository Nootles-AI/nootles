import type { CSSProperties } from "react";
import { Brandmark } from "./Brand";
import { Check, FileDoc } from "./Icons";
import { NotionMark } from "./NotionMark";

/**
 * Importing from Notion, pictured: Notion's page picker on top, a Nootles
 * sidebar below, and the chosen pages crossing from one to the other.
 *
 * The top card is drawn as Notion draws itself — its warm grey, its system
 * type, emoji for page icons, its blue checkbox — because it is a picture of
 * the screen where you choose what an app may read, and that screen is theirs.
 * The blue stops at the card's edge; everything of ours stays in our own ink.
 * Three of five are chosen, since choosing is the point: "You choose which
 * pages Nootles can see."
 *
 * One nine-second loop, all of it delays on shared keyframes: a tick, a pulse
 * down the wire, a row arriving — three times — then a rest, then again.
 *
 * Decorative, and marked so: the row it sits beside says what it is.
 */
const PAGES = [
  { icon: "🧭", title: "Product principles", take: 0 },
  { icon: "🗒️", title: "Weekly notes", take: null },
  { icon: "🎙️", title: "Interview synthesis", take: 1 },
  { icon: "✅", title: "Launch checklist", take: 2 },
  { icon: "📚", title: "Reading list", take: null },
];

const at = (n: number) => ({ "--n": n }) as CSSProperties;

export function NotionPort() {
  const taken = PAGES.filter((p) => p.take !== null);
  return (
    <div className="nt-port" aria-hidden="true">
      <div className="nt-port-notion">
        <p className="nt-port-notion-head">
          <NotionMark width={14} height={14} />
          Select pages
        </p>
        {PAGES.map((page) => (
          <div
            key={page.title}
            className={`nt-port-nrow${page.take === null ? "" : " is-taken"}`}
            style={page.take === null ? undefined : at(page.take)}
          >
            <span className="nt-port-box">
              <Check width={10} height={10} strokeWidth={3.2} />
            </span>
            <span className="nt-port-emoji">{page.icon}</span>
            {page.title}
          </div>
        ))}
      </div>

      <svg className="nt-port-wire" width="60" height="80" viewBox="0 0 60 80" fill="none">
        <path d="M14 0v44q0 14 14 14h32" />
        {[0, 1, 2].map((n) => (
          <path key={n} d="M14 0v44q0 14 14 14h32" pathLength={100} className="nt-port-pulse" style={at(n)} />
        ))}
      </svg>

      <div className="nt-port-ours">
        <p className="nt-port-ours-head">
          <Brandmark width={11} height={14} />
          Notion import
        </p>
        <p className="nt-port-label">Pages</p>
        {taken.map((page) => (
          <div key={page.title} className="nt-port-orow" style={at(page.take!)}>
            <FileDoc width={14} height={14} />
            {page.title}
          </div>
        ))}
      </div>
    </div>
  );
}
