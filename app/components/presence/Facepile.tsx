"use client";

import {
  Component,
  useEffect,
  useReducer,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import { useUser } from "@clerk/nextjs";
import * as Sentry from "@sentry/nextjs";
import { api } from "@/convex/_generated/api";
import { peekProvider } from "@/app/lib/sync/YConvexProvider";
import { useMediaQuery } from "@/app/lib/useMediaQuery";

/** A row this old is somebody gone; matches the provider's judgement. */
const STALE_MS = 30_000;
const SHOWN = 4;
/** On a phone the pile shares a 390px header with a centred title. */
const NARROW = "(max-width: 639px)";
const SHOWN_NARROW = 2;
/** A tooltip is a list, not a roster; past this it says "and N more". */
const NAMED = 12;

/**
 * Who else is on this document, as overlapping portraits — Google-Docs
 * grammar, in the quiet register. Photos, not monograms: the documented
 * exception (see AccountMenu) decided 2026-08 with the sharing work, because
 * a face answers "who is that caret" faster than an initial ever will.
 * Anonymous sessions fall back to a colored monogram dot.
 *
 * Renders nothing when you are alone, which is most of the time — a
 * single-user surface should not carry multiplayer chrome. "You" is judged
 * two ways: by userId when signed in, and by the live provider's sessionId
 * either way, so a guest never appears to themself.
 */
type Row = {
  sessionId: string;
  userId: string | null;
  updatedAt: number;
  user: { name: string; color: string; imageUrl?: string };
};

/** Coarse enough that heartbeat-driven re-renders keep it honest. */
function others(
  rows: Row[],
  selfUser: string | undefined,
  selfSession: string | undefined,
): Row[] {
  const now = Date.now();
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (now - row.updatedAt > STALE_MS) return false;
    if (row.userId && row.userId === selfUser) return false;
    if (selfSession && row.sessionId === selfSession) return false;
    const key = row.userId ?? row.sessionId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The heartbeat's own fallback, for rows that arrive with a blank name. */
const displayName = (name: string) => name.trim() || "Someone";

const graphemes = new Intl.Segmenter();

/** First grapheme, not first code point — a flag or 🦊 survives intact. */
function monogram(name: string): string {
  for (const g of graphemes.segment(name)) return g.segment.toUpperCase();
  return "?";
}

/**
 * The face renders at 24px, but Clerk proxies the original OAuth photo —
 * hundreds of kilobytes for a spot this size. Its image API resizes on a
 * `width` param (ignored, harmlessly, on generated default avatars); foreign
 * URLs pass through untouched. 96 covers 3× displays with headroom.
 */
function avatarSrc(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "img.clerk.com") u.searchParams.set("width", "96");
    return u.toString();
  } catch {
    return url;
  }
}

function Face({ user }: { user: Row["user"] }) {
  // Remembering which URL failed (not a boolean) lets a repaired avatar
  // recover without a remount.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const photo = user.imageUrl && user.imageUrl !== brokenUrl ? user.imageUrl : null;
  const name = displayName(user.name);
  return (
    <span
      className="nt-face"
      role="img"
      aria-label={name}
      title={name}
      style={{ "--face-color": user.color } as CSSProperties}
    >
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarSrc(photo)}
          alt=""
          width={24}
          height={24}
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setBrokenUrl(photo)}
        />
      ) : (
        <span aria-hidden>{monogram(name)}</span>
      )}
    </span>
  );
}

/**
 * Presence is best-effort by definition (convex/presence.ts), so its chrome
 * fails silent: an auth blip or a just-revoked link makes `checkRead` throw
 * out of `useQuery`, and without this the ornament would take the whole
 * header down with it. Keyed on docId by the caller, so switching docs
 * retries.
 */
class Quietly extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    Sentry.captureException(error, { tags: { feature: "presence-facepile" } });
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function Facepile({ docId }: { docId: string | null }) {
  return (
    <Quietly key={docId ?? ""}>
      <Pile docId={docId} />
    </Quietly>
  );
}

function Pile({ docId }: { docId: string | null }) {
  const { user } = useUser();
  const rows = useQuery(api.presence.list, docId ? { docId } : "skip");
  const cap = useMediaQuery(NARROW) ? SHOWN_NARROW : SHOWN;
  // Staleness is judged on our clock at render time, so a silent departure
  // (closed laptop) needs a nudge: re-render when the next row would cross
  // STALE_MS, or the last face would linger until the server cron sweeps.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!rows?.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const now = Date.now();
      const waits = rows
        .map((row) => row.updatedAt + STALE_MS - now)
        .filter((ms) => ms > 0);
      if (waits.length === 0) return;
      timer = setTimeout(() => {
        bump();
        arm();
      }, Math.min(...waits) + 50);
    };
    arm();
    return () => clearTimeout(timer);
  }, [rows]);
  if (!docId || !rows) return null;
  const here = others(rows, user?.id, peekProvider(docId)?.sessionId);
  if (here.length === 0) return null;

  // "+1" would occupy the very slot the next face fits in; show the face.
  const shown = here.length <= cap + 1 ? here : here.slice(0, cap);
  const rest = here.slice(shown.length);
  const restNames = rest.slice(0, NAMED).map((r) => displayName(r.user.name));
  if (rest.length > NAMED) restNames.push(`and ${rest.length - NAMED} more`);

  return (
    <div className="nt-facepile" role="group" aria-label="Also here">
      {shown.map((row) => (
        <Face key={row.userId ?? row.sessionId} user={row.user} />
      ))}
      {rest.length > 0 && (
        <span
          className="nt-face is-count"
          role="img"
          aria-label={`${rest.length} more: ${restNames.join(", ")}`}
          title={restNames.join("\n")}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}
