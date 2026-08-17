"use client";

import { useQuery } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";

/** A row this old is somebody gone; matches the provider's judgement. */
const STALE_MS = 30_000;
const SHOWN = 4;

/**
 * Who else is on this document, as overlapping portraits — Google-Docs
 * grammar, in the quiet register. Photos, not monograms: the documented
 * exception (see AccountMenu) decided 2026-08 with the sharing work, because
 * a face answers "who is that caret" faster than an initial ever will.
 * Anonymous sessions fall back to a colored monogram dot.
 *
 * Renders nothing when you are alone, which is most of the time — a
 * single-user surface should not carry multiplayer chrome.
 */
type Row = {
  sessionId: string;
  userId: string | null;
  updatedAt: number;
  user: { name: string; color: string; imageUrl?: string };
};

/** Coarse enough that heartbeat-driven re-renders keep it honest. */
function others(rows: Row[], selfId: string | undefined): Row[] {
  const now = Date.now();
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (now - row.updatedAt > STALE_MS) return false;
    if (row.userId && row.userId === selfId) return false;
    const key = row.userId ?? row.sessionId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function Facepile({ docId }: { docId: string | null }) {
  const { user } = useUser();
  const rows = useQuery(api.presence.list, docId ? { docId } : "skip");
  if (!rows) return null;
  const here = others(rows, user?.id);
  if (here.length === 0) return null;

  return (
    <div className="nt-facepile" aria-label="Also here">
      {here.slice(0, SHOWN).map((row) => (
        <span
          key={row.userId ?? row.sessionId}
          className="nt-face"
          title={row.user.name}
          style={{ borderColor: row.user.color }}
        >
          {row.user.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={row.user.imageUrl} alt={row.user.name} />
          ) : (
            <span aria-hidden style={{ color: row.user.color }}>
              {row.user.name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </span>
      ))}
      {here.length > SHOWN && (
        <span className="nt-face is-count" aria-label={`${here.length - SHOWN} more`}>
          +{here.length - SHOWN}
        </span>
      )}
    </div>
  );
}
