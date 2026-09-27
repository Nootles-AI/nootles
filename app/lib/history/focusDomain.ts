import type { DomainStep, UndoDomain, WorkspaceHistory } from "./spine";

/**
 * A focus domain: active/selected state as history, Figma-style.
 *
 * Entries hold whole before/after descriptors rather than deltas — focus is
 * small and absolute, and applying a descriptor must work from any state the
 * surface has drifted to since. Consecutive focus changes collapse into one
 * entry while the newest is still the spine's global top, alone, so clicking
 * through five cards on the way somewhere costs one step back, not five — a
 * batch that records nothing else folds the same way when it closes.
 *
 * The descriptor owns its own geography: `apply` navigates to whatever page
 * the state lives on, so the domain registers with no page of its own.
 */
export class FocusDomain<T> implements UndoDomain {
  private past: { before: T; after: T }[] = [];
  private future: { before: T; after: T }[] = [];
  /** True while apply() runs, so restoring focus never re-records it. */
  applying = false;

  constructor(
    private spine: WorkspaceHistory,
    private id: string,
    private apply: (state: T) => void,
  ) {}

  record(before: T, after: T): void {
    if (this.applying) return;
    const newest = this.past[this.past.length - 1];
    if (newest && this.spine.foldsInto(this.id)) {
      newest.after = after;
      return;
    }
    this.past.push({ before, after });
    this.spine.record(this.id, "focus");
  }

  fold(): boolean {
    if (this.past.length < 2) return false;
    const newer = this.past.pop()!;
    this.past[this.past.length - 1].after = newer.after;
    return true;
  }

  undo(): DomainStep {
    const entry = this.past.pop();
    if (!entry) return { consumed: 0, redoable: false };
    this.future.push(entry);
    this.run(entry.before);
    return { consumed: 1, redoable: true };
  }

  redo(): DomainStep {
    const entry = this.future.pop();
    if (!entry) return { consumed: 0, redoable: false };
    this.past.push(entry);
    this.run(entry.after);
    return { consumed: 1, redoable: true };
  }

  private run(state: T): void {
    this.applying = true;
    try {
      this.apply(state);
    } finally {
      // The surface reacts to apply() asynchronously (React state); hold the
      // guard to the end of the task so the echo of our own restore — the
      // shell re-announcing the focus we just set — is not recorded as new.
      queueMicrotask(() => {
        this.applying = false;
      });
    }
  }
}
