"use client";

import { useCallback, useEffect, useState } from "react";
import type { MediaSource } from "./link";

/**
 * One thing plays at a time.
 *
 * A page can hold a dozen songs, and two playing at once is noise rather than
 * music — so starting one stops the rest. The players are other people's
 * iframes, but none of them needs a script for this: measured 2026-08, every
 * provider but Apple answers plain postMessage, both to say it has started and
 * to be told to stop.
 *
 *   spotify     volunteers {type:"playback_update"|"playback_started"};
 *               obeys {command:"pause"}. No handshake at all.
 *   youtube     needs `enablejsapi=1` on the src and a {event:"listening"}
 *               handshake, then reports playerState 1 for playing; obeys
 *               {func:"pauseVideo"}.
 *   soundcloud  answers addEventListener with {method:"play"}; obeys
 *               {method:"pause"}.
 *   vimeo       the same shape, reporting {event:"play"}.
 *   apple       says nothing and takes no orders. The only sign one may be
 *               playing is that the user put focus in it, and the only way to
 *               silence it is to reload the frame — so that is what it gets,
 *               and only if it was ever touched.
 *
 * Deliberately not a React context: playback is a property of the page, not of
 * a subtree, and a block that mounts inside a review overlay or a thumbnail
 * still belongs to the same one-at-a-time rule.
 */

export type PlayerKind = MediaSource["kind"] | "file";

type Entry = {
  kind: PlayerKind;
  el: HTMLIFrameElement | HTMLMediaElement;
  /** Apple's only tell: focus went in here, so it might be making noise. */
  touched: boolean;
  /**
   * What this player was last known to be doing. Load-bearing: a player
   * REPEATS its state — Spotify posts an update about once a second while it
   * runs — so only the EDGE into playing may claim the stage. Read as a level
   * instead, the first thing to play would re-claim every second and nothing
   * else could ever hold it. (Measured: it did exactly that.)
   */
  playing: boolean;
};

const players = new Set<Entry>();

function isFrame(entry: Entry): entry is Entry & { el: HTMLIFrameElement } {
  return entry.el.tagName === "IFRAME";
}

function post(entry: Entry, message: unknown) {
  if (!isFrame(entry)) return;
  const { contentWindow, src } = entry.el;
  if (!contentWindow || !src) return;
  try {
    contentWindow.postMessage(message, new URL(src).origin);
  } catch {
    // A frame torn down mid-message. Nothing to stop.
  }
}

/** Stop this one, by whatever means it understands. */
function silence(entry: Entry) {
  entry.playing = false;
  if (!isFrame(entry)) {
    (entry.el as HTMLMediaElement).pause();
    return;
  }
  switch (entry.kind) {
    case "spotify":
      post(entry, { command: "pause" });
      break;
    case "youtube":
      post(entry, JSON.stringify({ event: "command", func: "pauseVideo", args: [] }));
      break;
    case "soundcloud":
    case "vimeo":
      post(entry, JSON.stringify({ method: "pause" }));
      break;
    case "apple": {
      // No API. Reloading is the only lever, and it costs the listener their
      // place in the song — so it is spent only on a frame they have touched,
      // which is the only one that can be playing.
      if (!entry.touched) return;
      entry.touched = false;
      const { el } = entry;
      const src = el.src;
      el.src = src;
      break;
    }
  }
}

/** This one just started: everything else goes quiet. */
function claim(who: Entry) {
  who.playing = true;
  for (const other of players) {
    if (other !== who) silence(other);
  }
}

function parse(data: unknown): Record<string, unknown> | null {
  const body =
    typeof data === "string"
      ? (() => {
          try {
            return JSON.parse(data);
          } catch {
            return null;
          }
        })()
      : data;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

/**
 * What this message says the player is doing — or null when it says nothing
 * about that, which is most of them: a position tick, a quality change, a
 * caption list.
 */
function playState(kind: PlayerKind, data: unknown): boolean | null {
  const body = parse(data);
  if (!body) return null;
  const info = body.info as { playerState?: number } | undefined;
  const payload = body.payload as { isPaused?: boolean } | undefined;
  switch (kind) {
    case "spotify":
      if (body.type === "playback_started") return true;
      if (body.type === "playback_update" && typeof payload?.isPaused === "boolean") {
        return !payload.isPaused;
      }
      return null;
    case "youtube":
      // 1 playing, 2 paused, 0 ended, -1 unstarted. 3 is buffering, which is
      // on the way to playing and not an answer yet.
      switch (info?.playerState) {
        case 1:
          return true;
        case 0:
        case 2:
        case -1:
          return false;
        default:
          return null;
      }
    case "soundcloud":
      if (body.method === "play") return true;
      if (body.method === "pause" || body.method === "finish") return false;
      return null;
    case "vimeo":
      if (body.event === "play") return true;
      if (body.event === "pause" || body.event === "ended") return false;
      return null;
    default:
      return null;
  }
}

/** What a provider must be told before it will report anything. */
function handshake(entry: Entry) {
  switch (entry.kind) {
    case "youtube":
      post(entry, JSON.stringify({ event: "listening", id: 1, channel: "widget" }));
      break;
    case "soundcloud":
    case "vimeo":
      post(entry, JSON.stringify({ method: "addEventListener", value: "play" }));
      break;
    default:
      break;
  }
}

let listening = false;

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;

  window.addEventListener("message", (event) => {
    for (const entry of players) {
      if (isFrame(entry) && entry.el.contentWindow === event.source) {
        const state = playState(entry.kind, event.data);
        if (state === null) return;
        // Only the edge into playing takes the stage; the repeats that follow
        // are the same player still going, not a new one starting.
        if (state && !entry.playing) claim(entry);
        else entry.playing = state;
        return;
      }
    }
  });

  // Focus is the one thing a parent learns for free about a cross-origin
  // frame, and for Apple it is the only thing. Read after the blur settles,
  // because activeElement is still the old element while it is dispatching.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      const active = document.activeElement;
      for (const entry of players) {
        if (entry.el === active) {
          entry.touched = true;
          if (entry.kind === "apple") claim(entry);
          return;
        }
      }
    }, 0);
  });
}

/**
 * The src to actually load. YouTube reports nothing and refuses commands
 * without this flag; every other provider plays the same either way.
 */
export function playableSrc(kind: PlayerKind, src: string): string {
  if (kind !== "youtube") return src;
  return `${src}${src.includes("?") ? "&" : "?"}enablejsapi=1`;
}

/**
 * Register this block's player. The returned ref goes on the iframe, or on the
 * audio or video element for an uploaded file — a callback ref rather than an
 * object one, both because it fits all three element types and because the
 * registration wants the moment the element arrives, not the render after it.
 */
export function usePlayer(kind: PlayerKind | null, src: string) {
  const [el, setEl] = useState<HTMLIFrameElement | HTMLMediaElement | null>(null);

  useEffect(() => {
    if (!el || !kind) return;
    listen();

    const entry: Entry = { kind, el, touched: false, playing: false };
    players.add(entry);

    // A native element says so itself; nothing else to arrange.
    const onPlay = () => claim(entry);
    const onPause = () => {
      entry.playing = false;
    };
    if (el.tagName !== "IFRAME") {
      el.addEventListener("play", onPlay);
      el.addEventListener("pause", onPause);
    }

    // A frame may already be loaded by the time this runs, and a handshake
    // sent before the player is ready is simply not heard — so it is offered
    // now, at load, and a few times after, until the frame starts answering.
    let tries = 0;
    const knock = () => {
      handshake(entry);
      if (++tries < 4) timer = window.setTimeout(knock, 500);
    };
    let timer = window.setTimeout(knock, 0);
    el.addEventListener("load", knock);

    return () => {
      players.delete(entry);
      window.clearTimeout(timer);
      el.removeEventListener("load", knock);
      if (el.tagName !== "IFRAME") {
        el.removeEventListener("play", onPlay);
        el.removeEventListener("pause", onPause);
      }
    };
  }, [el, kind, src]);

  return useCallback((node: HTMLIFrameElement | HTMLMediaElement | null) => {
    setEl(node);
  }, []);
}
