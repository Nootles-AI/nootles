import type { DomainStep, UndoDomain, WorkspaceHistory } from "./spine";

/**
 * A domain over invertible operations: each entry carries its own way back
 * and forward, captured at record time — a rename holds the prior title, a
 * delete holds the restore. The shape for surfaces whose truth lives behind
 * a mutation rather than in an undo-managed store: the page title, the
 * sidebar tree.
 *
 * Steps may be async (a mutation round trip); the spine awaits them, and a
 * step that throws leaves the entry spent — better a tombstoned step than a
 * timeline wedged on a failing network call.
 */
export interface HistoryEntry {
  /** May return a promise — awaited before the step counts. The value itself
   *  is ignored, so a mutation's own return rides through unwrapped. */
  undo(): unknown;
  redo(): unknown;
}

export class EntryDomain implements UndoDomain {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  constructor(
    private spine: WorkspaceHistory,
    private id: string,
  ) {}

  record(entry: HistoryEntry): void {
    this.past.push(entry);
    this.future = [];
    this.spine.record(this.id, "edit");
  }

  async undo(): Promise<DomainStep> {
    const entry = this.past.pop();
    if (!entry) return { consumed: 0, redoable: false };
    try {
      await entry.undo();
    } catch {
      return { consumed: 1, redoable: false };
    }
    this.future.push(entry);
    return { consumed: 1, redoable: true };
  }

  async redo(): Promise<DomainStep> {
    const entry = this.future.pop();
    if (!entry) return { consumed: 0, redoable: false };
    try {
      await entry.redo();
    } catch {
      return { consumed: 1, redoable: false };
    }
    this.past.push(entry);
    return { consumed: 1, redoable: true };
  }
}
