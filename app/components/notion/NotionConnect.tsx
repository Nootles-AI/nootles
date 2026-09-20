"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { Brandmark } from "@/app/components/Brand";
import { NotionMark } from "@/app/components/NotionMark";

/**
 * Not connected yet: the two marks, what passes between them, and the one
 * button that starts it.
 *
 * The picture is the whole explanation. Notion's mark on the left, ours on the
 * right, and pages crossing from one to the other along a line that fades at
 * both ends — each page leaves Notion, travels, and is taken in, and our mark
 * answers every arrival with the smallest of nods. It is the import in one
 * glance, before a word of it is read.
 *
 * Under it, the sentence the dialog has always said, and the three things that
 * are about to happen in the order they happen — the first of which is the
 * button. The line under the button is the fact people most need before leaving
 * for another site: Notion, not this list, is where pages are chosen.
 */
const turn = (n: number) => ({ "--n": n }) as CSSProperties;

export function NotionConnect({
  titleId,
  stale,
  blocker,
  href,
}: {
  titleId: string;
  /** There was a connection and Notion has since withdrawn it. */
  stale: boolean;
  /** Why this deployment cannot hold a connection, when it cannot. */
  blocker: string | null;
  href: string;
}) {
  // The one thing to do here takes the keyboard on arrival. By effect: React
  // only honours `autoFocus` on form controls, and this is a link.
  const go = useRef<HTMLAnchorElement>(null);
  useEffect(() => go.current?.focus({ preventScroll: true }), []);

  return (
    <div className="nt-nc">
      <div className="nt-nc-art" aria-hidden="true">
        <span className="nt-nc-tile">
          <NotionMark width={30} height={30} />
        </span>
        <span className="nt-nc-track">
          {[0, 1, 2].map((n) => (
            <i key={n} className="nt-nc-page" style={turn(n)} />
          ))}
        </span>
        <span className="nt-nc-tile is-ours">
          <Brandmark width={24} height={30} />
        </span>
      </div>

      <h2 id={titleId} className="nt-nc-title">
        {stale ? "Reconnect your Notion" : "Bring your pages across from Notion"}
      </h2>
      <p className="nt-nc-note">
        {stale
          ? "Nootles no longer has access to this Notion account. Reconnecting takes a moment."
          : "Connect a Notion account to bring pages across. You choose which pages Nootles can see."}
      </p>

      <ol className="nt-nc-steps">
        <li data-on="true">Connect</li>
        <li>Choose pages</li>
        <li>Import</li>
      </ol>

      {/* No button to a connection this deployment cannot keep: the sentence
          says what is missing instead. */}
      {blocker ? (
        <p className="nt-note nt-nc-blocker">{blocker}</p>
      ) : (
        <>
          <a ref={go} href={href} className="nt-nc-go">
            <NotionMark width={16} height={16} />
            {stale ? "Reconnect Notion" : "Connect Notion"}
          </a>
          <p className="nt-nc-fine">Opens Notion, which asks which pages to share.</p>
        </>
      )}
    </div>
  );
}
