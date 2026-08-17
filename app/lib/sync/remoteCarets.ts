import type { Awareness } from "y-protocols/awareness";

/**
 * The caret another person is holding: a 2px bar in their colour flying their
 * name as a flag, in the grammar the canvas already paints for its label
 * carets (`.nt-copresence-caret`), down to the `--copresence` custom property
 * — so one person looks like one person on both surfaces.
 *
 * BlockNote builds a cursor element once per remote client and caches it for
 * the life of the editor, which leaves two things for this layer to own.
 * Identity that arrives late — a Clerk profile hydrating a moment after the
 * caret does — has to be painted onto the element already on screen, or the
 * peer stays whatever they were called on first sight. And the flag has to
 * furl and unfurl: BlockNote's own reveal watches `updated` awareness clients
 * only, so it never fires for someone who has just walked in, which is the
 * one moment the name is genuinely news.
 */

type CollabUser = { name: string; color: string };

/** How long an unfurled flag dwells before folding back to its nub. */
const DWELL_MS = 2000;
/** The only colour shape y-prosemirror and the palette both speak. */
const HEX = /^#[0-9a-fA-F]{6}$/;

export type RemoteCarets = {
  render: (user: CollabUser) => HTMLElement;
  attach: () => () => void;
};

export function createRemoteCarets(awareness: Awareness): RemoteCarets {
  const byClient = new Map<number, HTMLElement>();
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const pointed = new Set<HTMLElement>();

  // Every write here invalidates the caret's style, and a moving peer comes
  // through several times a second; only a real change is worth one.
  const paint = (caret: HTMLElement, user: Partial<CollabUser>) => {
    // Anything but `#rrggbb` computes to nothing and would leave an invisible
    // caret wearing invisible text — a peer on an older build, or a
    // hand-written awareness state, must not be able to erase themselves.
    // Declining the write lets the CSS fall back to plain ink.
    const color = user.color && HEX.test(user.color) ? user.color : null;
    if (color && caret.style.getPropertyValue("--copresence") !== color) {
      caret.style.setProperty("--copresence", color);
    }
    // The heartbeat and the facepile land on the same word for a nameless
    // peer; a blank flag would just look broken.
    const label = user.name?.trim() || "Someone";
    const name = caret.querySelector(".nt-remote-caret-name");
    if (name && name.textContent !== label) name.textContent = label;
  };

  const hold = (caret: HTMLElement) => {
    const running = timers.get(caret);
    if (running) clearTimeout(running);
    timers.delete(caret);
    if (!caret.hasAttribute("data-active")) caret.setAttribute("data-active", "");
  };

  /**
   * Unfurl, then furl again once they go still — unless the pointer is
   * resting on the bar, in which case the person is mid-question and the next
   * heartbeat must not take the answer away.
   */
  const unfurl = (caret: HTMLElement) => {
    hold(caret);
    if (pointed.has(caret)) return;
    timers.set(
      caret,
      setTimeout(() => {
        timers.delete(caret);
        caret.removeAttribute("data-active");
      }, DWELL_MS),
    );
  };

  /**
   * y-prosemirror hands the builder the very object held in the awareness
   * state, so identity recovers the client id BlockNote's `renderCursor`
   * never passes on. A caret we fail to place simply stops re-inking.
   */
  const clientIdOf = (user: CollabUser): number | null => {
    for (const [clientId, state] of awareness.getStates()) {
      if ((state as { user?: unknown }).user === user) return clientId;
    }
    return null;
  };

  const render = (user: CollabUser): HTMLElement => {
    const caret = document.createElement("span");
    caret.className = "nt-remote-caret";
    // A caret is something you watch, not something that interrupts the
    // reading: the name must not land in the middle of the spoken sentence.
    caret.setAttribute("aria-hidden", "true");

    const bar = document.createElement("span");
    bar.className = "nt-remote-caret-bar";
    const name = document.createElement("span");
    name.className = "nt-remote-caret-name";
    bar.append(name);
    // Word joiners on both sides: the widget must not open a line-break
    // opportunity inside a word someone else is typing.
    caret.append("\u2060", bar, "\u2060");
    paint(caret, user);

    caret.addEventListener("pointerenter", () => {
      pointed.add(caret);
      hold(caret);
    });
    caret.addEventListener("pointerleave", () => {
      pointed.delete(caret);
      unfurl(caret);
    });

    const clientId = clientIdOf(user);
    if (clientId !== null) byClient.set(clientId, caret);
    // Next frame, so arriving reads as the flag unrolling rather than as a
    // name that was always there. A caret the editor never mounted, or tore
    // down inside the frame, has nothing to announce.
    requestAnimationFrame(() => {
      if (caret.isConnected) unfurl(caret);
    });
    return caret;
  };

  const onChange = ({
    added,
    updated,
    removed,
  }: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    const states = awareness.getStates();
    for (const clientId of [...added, ...updated]) {
      const caret = byClient.get(clientId);
      if (!caret) continue;
      const user = states.get(clientId)?.user as Partial<CollabUser> | undefined;
      if (user) paint(caret, user);
      unfurl(caret);
    }
    // Their caret comes down with their awareness state, but the element
    // stays in BlockNote's per-client cache, so the mapping stays too: a peer
    // whose row went stale on a bad connection is the same peer when it
    // returns, and must re-ink and unfurl again rather than come back mute.
    for (const clientId of removed) {
      const caret = byClient.get(clientId);
      if (!caret) continue;
      pointed.delete(caret);
      const running = timers.get(caret);
      if (running) clearTimeout(running);
      timers.delete(caret);
      caret.removeAttribute("data-active");
    }
  };

  const attach = () => {
    awareness.on("change", onChange);
    return () => {
      awareness.off("change", onChange);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pointed.clear();
      byClient.clear();
    };
  };

  return { render, attach };
}
