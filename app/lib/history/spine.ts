/**
 * The workspace history spine — one linear timeline over every undoable
 * surface in the workspace.
 *
 * Each surface keeps its own inversion machinery (the Yjs UndoManager for the
 * document, the SceneStore's snapshots for a diagram, prior-value writes for
 * the sidebar) and registers here as an {@link UndoDomain}. What the spine
 * owns is ORDER: every entry a domain records also lands here as a part of a
 * token, so ⌘Z walks back through diagram edits, prose, panel toggles and
 * sidebar renames in the order they happened, wherever the keyboard focus
 * sits.
 *
 * ## The ledger invariant
 *
 * A domain's parts appear on the spine in the same order as the entries on
 * its own stack — so "undo your newest" is always the right inverse for the
 * spine's newest part of that domain. Everything else follows from keeping
 * the two ledgers the same length: a domain that trims its oldest entry
 * loses its oldest part, one that resets (a collaborator's merge) loses all
 * of them, and a domain whose executor silently consumed extra entries (Yjs
 * pops no-op stack items in the same call) reports how many so the spine
 * can strip the same count.
 *
 * ## One step, several domains
 *
 * A token is usually one part; {@link WorkspaceHistory.batch} makes one of
 * several, so a click that clears one diagram and selects in another, or a
 * delete across three diagrams, is one step. Undo takes its parts back
 * newest-first and redo replays them oldest-first. Before any part moves,
 * every domain in the step settles what it holds open on a timer — an entry
 * that settling records is newer than the step, so the press takes it
 * instead — and then every domain that can say so up front is asked whether
 * it is blocked. The ledger stays per domain: losing or consuming
 * entries strips that domain's parts from the tokens it shares, and a token
 * dies only when its last part goes.
 *
 * ## Death, not holes
 *
 * A token whose entries can no longer be honoured — its store was reset, its
 * page deleted, its domain never came back — is tombstoned and stepped OVER,
 * so the timeline never breaks in the middle: the walk simply continues to
 * the next thing that can still be undone. The one exception is "blocked"
 * (a live pointer gesture holds the domain's bracket): that stops the walk
 * without spending anything, because stepping around an edit the user is
 * mid-way through making would revert something they can see. A domain that
 * can only refuse by trying may do so part-way through a step of several:
 * the parts already stepped stay spent, and the rest wait for the next press.
 *
 * ## Focus is history too
 *
 * Entries come in two kinds. An `edit` clears the redo side, as every editor
 * does. A `focus` entry — a selection, a claimed card, an entered diagram —
 * is a stop on the timeline (Figma's model) but does NOT clear redo:
 * clicking around after an undo must not throw the redo away. A step with
 * any edit among its parts is an edit.
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
  /**
   * Close now whatever is held open only by an idle timer (a panel's typing
   * run, a nudge run), recording it as its timer would have. Asked of every
   * domain in a step before the step is weighed, so a held run is never
   * mistaken for a live gesture, and one that recorded is stepped first.
   */
  settle?(): void;
  /**
   * Whether a step would refuse right now, asked of each of a step's domains
   * once they have settled and before any moves. One without this can only
   * refuse by trying, which may stop a step of several part-way.
   */
  blocked?(): boolean;
  /**
   * Merge your two newest entries into one, answering whether you did. Asked
   * when a batch closes holding only a focus stop of yours right after
   * another — the fold a plain record would have made on its own.
   */
  fold?(): boolean;
}

export type TokenKind = "edit" | "focus";

/** One domain's entry within a step. */
interface Part {
  domain: string;
  /** Where this entry lives — the page to travel to before stepping. */
  pageId: string | null;
}

/**
 * One step on the timeline. Its parts are a small stack of their own: the
 * walk steps them from the end, and the inverse lists them in the order they
 * stepped, so a compound undoes newest-first and redoes oldest-first. A
 * token with no parts left is a tombstone.
 */
interface Token {
  parts: Part[];
  kind: TokenKind;
}

const live = (token: Token | null | undefined): boolean => (token?.parts.length ?? 0) > 0;

/** A focus stop that is this domain's alone — what a new stop may fold into. */
const lone = (token: Token | undefined, domainId: string): boolean =>
  token?.kind === "focus" && token.parts.length === 1 && token.parts[0].domain === domainId;

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
  private batching = false;
  /** The token the open batch is filling, from its first record on. */
  private open: Token | null = null;

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

  /**
   * Everything `fn` records becomes one step. Synchronous by design: domains
   * record at commit time, so a gesture across diagrams wraps its commits,
   * never the gesture itself. Nested batches join the outermost.
   */
  batch = <T>(fn: () => T): T => {
    if (this.batching) return fn();
    this.batching = true;
    try {
      return fn();
    } finally {
      this.batching = false;
      const token = this.open;
      this.open = null;
      if (token) this.close(token);
    }
  };

  /**
   * A batch that recorded one focus stop is a plain record after all, so it
   * folds as one would have — into the stop before it, when that is the same
   * domain's alone. Only at close is it known that nothing else joined.
   */
  private close(token: Token): void {
    const id = token.parts[0]?.domain;
    const at = this.past.lastIndexOf(token);
    if (!id || at < 0 || !lone(token, id) || !lone(this.newest(at), id)) return;
    if (this.domains.get(id)?.domain.fold?.()) {
      this.past.splice(at, 1);
      this.notify();
    }
  }

  /** A domain pushed an entry; the spine gets the matching part. */
  record = (domainId: string, kind: TokenKind): void => {
    const part = { domain: domainId, pageId: this.domains.get(domainId)?.pageId ?? null };
    if (this.open) {
      this.open.parts.push(part);
      if (kind === "edit") this.open.kind = "edit";
    } else {
      const token: Token = { parts: [part], kind };
      this.past.push(token);
      if (this.batching) this.open = token;
    }
    // An edit invalidates everything undone before it; a focus change is not
    // an edit and keeps the way back forward.
    if (kind === "edit") this.future = [];
    this.notify();
  };

  /** The domain's OLDEST entry fell off its bounded stack. */
  trim = (domainId: string): void => {
    for (const token of this.past) {
      const at = token.parts.findIndex((part) => part.domain === domainId);
      if (at >= 0) {
        token.parts.splice(at, 1);
        break;
      }
    }
    this.notify();
  };

  /** The domain reset (a collaborator's merge): every part of its dies. */
  drop = (domainId: string): void => {
    let changed = false;
    for (const stack of [this.past, this.future]) {
      for (const token of stack) {
        const kept = token.parts.filter((part) => part.domain !== domainId);
        if (kept.length < token.parts.length) {
          token.parts = kept;
          changed = true;
        }
      }
    }
    if (changed) this.notify();
  };

  /** The domain's newest `count` parts die — a fork merge discarding the
   *  entries pushed while it was open. */
  dropNewest = (domainId: string, count: number): void => {
    this.shed(this.past, domainId, count);
    this.notify();
  };

  // -- Reading --------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  canUndo = (): boolean => this.past.some(live);

  /** True while a step is being walked: what changes then is history's doing. */
  walking = (): boolean => this.stepping;

  canRedo = (): boolean => this.future.some(live);

  /**
   * Whether a focus stop this domain records now should fold into its newest
   * instead of pushing: true while the newest step is a focus stop of the
   * domain's alone. Inside a batch only the batch's own step counts, so
   * nothing recorded in one folds into an older step.
   */
  foldsInto = (domainId: string): boolean => {
    if (this.batching && !live(this.open)) return false;
    return lone(this.newest(this.past.length), domainId);
  };

  /** The newest live token below index `before` of the undo side. */
  private newest(before: number): Token | undefined {
    for (let i = before - 1; i >= 0; i--) if (live(this.past[i])) return this.past[i];
    return undefined;
  }

  // -- Stepping -------------------------------------------------------------

  undo = (): Promise<void> => this.walk("undo");

  redo = (): Promise<void> => this.walk("redo");

  private async walk(direction: "undo" | "redo"): Promise<void> {
    if (this.stepping) return;
    this.stepping = true;
    // Read at every use, never held: settling an idle-held bracket records an
    // edit, and that replaces the redo side mid-walk.
    const from = () => (direction === "undo" ? this.past : this.future);
    const to = () => (direction === "undo" ? this.future : this.past);
    try {
      for (;;) {
        // Tombstones on top are swept as they are found, never stepped.
        const stack = from();
        while (stack.length > 0 && !live(stack[stack.length - 1])) stack.pop();
        const token = stack[stack.length - 1];
        if (!token) return;

        const domains = await this.gather(token);
        for (const domain of domains.values()) domain.settle?.();
        // A run that settling recorded is newer than this step, so the press
        // is its to take — and on the redo side, that edit ended the redo.
        if (from().at(-1) !== token) continue;
        if ([...domains.values()].some((domain) => domain.blocked?.())) return;

        const stepped: Part[] = [];
        let refused = false;
        while (live(token)) {
          const part = token.parts[token.parts.length - 1];
          const domain = domains.get(part.domain);
          if (!domain) {
            // It never came back: this part dies, the rest still step.
            token.parts.pop();
            continue;
          }
          const step = await (direction === "undo" ? domain.undo() : domain.redo());
          if (step === "blocked") {
            refused = true;
            break;
          }
          const at = token.parts.lastIndexOf(part);
          if (at >= 0) token.parts.splice(at, 1);
          // Zero consumed: the domain's stack is emptier than the ledger says
          // — a stale part from state the domain lost without telling us.
          if (step.consumed === 0) continue;
          // Entries consumed past this one are the domain's next-newest
          // parts, wherever other domains' parts sit between them.
          this.shed(from(), part.domain, step.consumed - 1);
          if (step.redoable) stepped.push(part);
        }
        if (stepped.length > 0) to().push({ parts: stepped, kind: token.kind });
        // A refusal ends the press where it stands, keeping whatever already
        // stepped. Consuming entries that performed nothing visible is not an
        // answer to the keypress; keep walking until something was.
        if (refused || stepped.length > 0) return;
      }
    } finally {
      this.stepping = false;
      this.notify();
    }
  }

  /** Strips `domain`'s newest `count` parts from `stack`, in walk order. */
  private shed(stack: Token[], domain: string, count: number): void {
    for (let i = stack.length - 1; i >= 0 && count > 0; i--) {
      const parts = stack[i].parts;
      for (let j = parts.length - 1; j >= 0 && count > 0; j--) {
        if (parts[j].domain === domain) {
          parts.splice(j, 1);
          count--;
        }
      }
    }
  }

  /** Every domain a token spans, summoned once each in walk order; one
   *  that never comes back is missing from the map. */
  private async gather(token: Token): Promise<Map<string, UndoDomain>> {
    const found = new Map<string, UndoDomain>();
    const asked = new Set<string>();
    for (let i = token.parts.length - 1; i >= 0; i--) {
      const { domain: id, pageId } = token.parts[i];
      if (asked.has(id)) continue;
      asked.add(id);
      const domain = await this.summon(id, pageId);
      if (domain) found.set(id, domain);
    }
    return found;
  }

  /**
   * The domain for this part, travelling to its page when it lives on one
   * the user is not looking at — undo navigates to the site of the change.
   */
  private async summon(id: string, pageId: string | null): Promise<UndoDomain | null> {
    const away =
      pageId !== null &&
      this.navigator !== null &&
      this.navigator.currentPage() !== pageId;
    const held = this.domains.get(id);
    if (held && !away) return held.domain;
    if (pageId === null || !this.navigator) return held?.domain ?? null;

    this.navigator.openPage(pageId);
    if (held) return held.domain;
    return new Promise((resolve) => {
      const wake = (domain: UndoDomain) => {
        clearTimeout(timer);
        resolve(domain);
      };
      const timer = setTimeout(() => {
        this.waiters.get(id)?.delete(wake);
        resolve(null);
      }, SUMMON_MS);
      const set = this.waiters.get(id) ?? new Set();
      set.add(wake);
      this.waiters.set(id, set);
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
