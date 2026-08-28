/**
 * The workspace history spine — one linear timeline over every undoable
 * surface in the workspace.
 *
 * Each surface keeps its own inversion machinery (the Yjs UndoManager for the
 * document, the SceneStore's snapshots for a diagram, prior-value writes for
 * the sidebar) and registers here as an {@link UndoDomain}. What the spine
 * owns is ORDER: every entry a domain records also pushes a token here, so ⌘Z
 * walks back through diagram edits, prose, panel toggles and sidebar renames
 * in the order they happened, wherever the keyboard focus sits.
 *
 * ## The ledger invariant
 *
 * A domain's tokens appear on the spine in the same order as the entries on
 * its own stack — so "undo your newest" is always the right inverse for the
 * spine's newest token of that domain. Everything else follows from keeping
 * the two ledgers the same length: a domain that trims its oldest entry
 * tombstones its oldest token, one that resets (a collaborator's merge)
 * drops all of them, and a domain whose executor silently consumed extra
 * entries (Yjs pops no-op stack items in the same call) reports how many so
 * the spine can drop the same count.
 *
 * ## Death, not holes
 *
 * A token whose entry can no longer be honoured — its store was reset, its
 * page deleted, its domain never came back — is tombstoned and stepped OVER,
 * so the timeline never breaks in the middle: the walk simply continues to
 * the next thing that can still be undone. The one exception is "blocked"
 * (a live pointer gesture holds the domain's bracket): that stops the walk
 * without spending anything, because stepping around an edit the user is
 * mid-way through making would revert something they can see.
 *
 * ## Focus is history too
 *
 * Entries come in two kinds. An `edit` clears the redo side, as every editor
 * does. A `focus` entry — a selection, a claimed card, an entered diagram —
 * is a stop on the timeline (Figma's model) but does NOT clear redo:
 * clicking around after an undo must not throw the redo away.
 */

/** What a domain's executor did with one step request. */
export type DomainStep =
  | "blocked"
  /**
   * `consumed` entries came off the domain's stack (0 means the stack was
   * unexpectedly empty — the token is stale). `redoable` says whether the
   * step landed an inverse entry on the domain's opposite stack.
   */
  | { consumed: number; redoable: boolean };

export interface UndoDomain {
  /** Undo this domain's newest entry. */
  undo(): DomainStep | Promise<DomainStep>;
  /** Redo this domain's most recently undone entry. */
  redo(): DomainStep | Promise<DomainStep>;
}

export type TokenKind = "edit" | "focus";

interface Token {
  domain: string;
  kind: TokenKind;
  /** Where this entry lives — the page to travel to before stepping. */
  pageId: string | null;
  dead?: boolean;
}

interface Registration {
  domain: UndoDomain;
  pageId: string | null;
}

/** How long a summoned domain gets to mount before its token is given up on. */
const SUMMON_MS = 5000;

export interface SpineNavigator {
  /** The page the user is looking at right now. */
  currentPage(): string | null;
  /** Bring this page onto the surface, so the step is visible where it lands. */
  openPage(pageId: string): void;
}

export class WorkspaceHistory {
  private past: Token[] = [];
  private future: Token[] = [];
  private domains = new Map<string, Registration>();
  private waiters = new Map<string, Set<(domain: UndoDomain) => void>>();
  private navigator: SpineNavigator | null = null;
  private listeners = new Set<() => void>();
  /** One step at a time — a held ⌘Z queues nothing and skips nothing. */
  private stepping = false;

  // -- Wiring ---------------------------------------------------------------

  setNavigator = (navigator: SpineNavigator | null): void => {
    this.navigator = navigator;
  };

  /**
   * A domain comes online. Its tokens may already be on the spine from an
   * earlier mount — registration revives them rather than starting over.
   */
  register = (
    id: string,
    domain: UndoDomain,
    pageId: string | null = null,
  ): (() => void) => {
    this.domains.set(id, { domain, pageId });
    const waiting = this.waiters.get(id);
    if (waiting) {
      this.waiters.delete(id);
      for (const wake of waiting) wake(domain);
    }
    return () => {
      if (this.domains.get(id)?.domain === domain) this.domains.delete(id);
    };
  };

  // -- Recording ------------------------------------------------------------

  /** A domain pushed an entry; the spine gets the matching token. */
  record = (domainId: string, kind: TokenKind): void => {
    const pageId = this.domains.get(domainId)?.pageId ?? null;
    this.past.push({ domain: domainId, kind, pageId });
    // An edit invalidates everything undone before it; a focus change is not
    // an edit and keeps the way back forward.
    if (kind === "edit") this.future = [];
    this.notify();
  };

  /** The domain's OLDEST entry fell off its bounded stack. */
  trim = (domainId: string): void => {
    const oldest = this.past.find((t) => t.domain === domainId && !t.dead);
    if (oldest) oldest.dead = true;
    this.notify();
  };

  /** The domain reset (a collaborator's merge): every token of its dies. */
  drop = (domainId: string): void => {
    let changed = false;
    for (const stack of [this.past, this.future]) {
      for (const token of stack) {
        if (token.domain === domainId && !token.dead) {
          token.dead = true;
          changed = true;
        }
      }
    }
    if (changed) this.notify();
  };

  /** The domain's newest `count` live tokens die — a fork merge discarding
   *  the entries pushed while it was open. */
  dropNewest = (domainId: string, count: number): void => {
    for (let i = this.past.length - 1; i >= 0 && count > 0; i--) {
      const token = this.past[i];
      if (token.domain === domainId && !token.dead) {
        token.dead = true;
        count--;
      }
    }
    this.notify();
  };

  // -- Reading --------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  canUndo = (): boolean => this.past.some((t) => !t.dead);

  canRedo = (): boolean => this.future.some((t) => !t.dead);

  /** The newest live token — how a focus domain asks "am I on top?". */
  top = (): { domain: string; kind: TokenKind } | null => {
    for (let i = this.past.length - 1; i >= 0; i--) {
      const token = this.past[i];
      if (!token.dead) return { domain: token.domain, kind: token.kind };
    }
    return null;
  };

  // -- Stepping -------------------------------------------------------------

  undo = (): Promise<void> => this.walk("undo");

  redo = (): Promise<void> => this.walk("redo");

  private async walk(direction: "undo" | "redo"): Promise<void> {
    if (this.stepping) return;
    this.stepping = true;
    try {
      const from = direction === "undo" ? this.past : this.future;
      const to = direction === "undo" ? this.future : this.past;
      for (;;) {
        // Tombstones on top are swept as they are found, never stepped.
        let token = from[from.length - 1];
        while (token?.dead) {
          from.pop();
          token = from[from.length - 1];
        }
        if (!token) return;

        const domain = await this.summon(token);
        if (!domain) {
          token.dead = true;
          continue;
        }
        const step = await (direction === "undo" ? domain.undo() : domain.redo());
        if (step === "blocked") return;
        if (step.consumed === 0) {
          // The domain's stack is emptier than the ledger says — a stale
          // token from state the domain lost without telling us.
          token.dead = true;
          continue;
        }
        // The executor consumed its newest `consumed` entries; the matching
        // tokens are this domain's newest `consumed` live tokens, wherever
        // other domains' tokens sit between them.
        const kind = token.kind;
        let remaining = step.consumed;
        for (let i = from.length - 1; i >= 0 && remaining > 0; i--) {
          if (from[i].domain === token.domain && !from[i].dead) {
            from.splice(i, 1);
            remaining--;
          }
        }
        if (step.redoable) {
          to.push({ domain: token.domain, kind, pageId: token.pageId });
        }
        // Consuming entries that performed nothing visible is not an answer
        // to the keypress; keep walking until something was.
        if (step.redoable) return;
      }
    } finally {
      this.stepping = false;
      this.notify();
    }
  }

  /**
   * The domain for this token, travelling to its page when it lives on one
   * the user is not looking at — undo navigates to the site of the change.
   */
  private async summon(token: Token): Promise<UndoDomain | null> {
    const away =
      token.pageId !== null &&
      this.navigator !== null &&
      this.navigator.currentPage() !== token.pageId;
    const held = this.domains.get(token.domain);
    if (held && !away) return held.domain;
    if (token.pageId === null || !this.navigator) return held?.domain ?? null;

    this.navigator.openPage(token.pageId);
    if (held) return held.domain;
    return new Promise((resolve) => {
      const wake = (domain: UndoDomain) => {
        clearTimeout(timer);
        resolve(domain);
      };
      const timer = setTimeout(() => {
        this.waiters.get(token.domain)?.delete(wake);
        resolve(null);
      }, SUMMON_MS);
      const set = this.waiters.get(token.domain) ?? new Set();
      set.add(wake);
      this.waiters.set(token.domain, set);
    });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** One spine per project for the life of the tab, so the timeline survives
 *  page switches and workspace remounts. */
const spines = new Map<string, WorkspaceHistory>();

export function spineForProject(projectId: string): WorkspaceHistory {
  let spine = spines.get(projectId);
  if (!spine) {
    spine = new WorkspaceHistory();
    spines.set(projectId, spine);
  }
  return spine;
}
