import { describe, expect, it, vi } from "vitest";
import { FocusDomain } from "./focusDomain";
import { WorkspaceHistory, type DomainStep, type UndoDomain } from "./spine";

/**
 * A domain over a list of numbers — enough machinery to prove the ledger
 * invariant without any real surface behind it.
 */
class FakeDomain implements UndoDomain {
  log: string[] = [];
  past: number[] = [];
  future: number[] = [];
  blockedNow = false;
  /** Entries that silently no-op when undone — Yjs's overwritten stack items. */
  noop = new Set<number>();

  constructor(
    private spine: WorkspaceHistory,
    private id: string,
    /** Shared across domains, to read the order steps landed in. */
    private trail: string[] = [],
  ) {}

  edit(n: number): void {
    this.past.push(n);
    this.future = [];
    this.spine.record(this.id, "edit");
  }

  undo(): DomainStep {
    if (this.blockedNow) return "blocked";
    // Mirror Yjs: pop until an entry performs a visible change, in ONE call.
    let consumed = 0;
    while (this.past.length > 0) {
      const n = this.past.pop()!;
      consumed++;
      if (!this.noop.has(n)) {
        this.future.push(n);
        this.note(`undo:${n}`);
        return { consumed, redoable: true };
      }
    }
    return { consumed, redoable: false };
  }

  redo(): DomainStep {
    if (this.blockedNow) return "blocked";
    const n = this.future.pop();
    if (n === undefined) return { consumed: 0, redoable: false };
    this.past.push(n);
    this.note(`redo:${n}`);
    return { consumed: 1, redoable: true };
  }

  private note(step: string): void {
    this.log.push(step);
    this.trail.push(`${this.id}:${step}`);
  }
}

function workspace() {
  const spine = new WorkspaceHistory();
  const trail: string[] = [];
  const a = new FakeDomain(spine, "a", trail);
  const b = new FakeDomain(spine, "b", trail);
  spine.register("a", a);
  spine.register("b", b);
  return { spine, trail, a, b };
}

describe("interleaved order", () => {
  it("walks back through domains in the order they were touched", async () => {
    const { spine, a, b } = workspace();
    a.edit(1);
    b.edit(2);
    a.edit(3);
    await spine.undo();
    await spine.undo();
    await spine.undo();
    expect(a.log).toEqual(["undo:3", "undo:1"]);
    expect(b.log).toEqual(["undo:2"]);
  });

  it("redoes forward in the same order", async () => {
    const { spine, a, b } = workspace();
    a.edit(1);
    b.edit(2);
    await spine.undo();
    await spine.undo();
    await spine.redo();
    await spine.redo();
    expect(a.log).toEqual(["undo:1", "redo:1"]);
    expect(b.log).toEqual(["undo:2", "redo:2"]);
  });

  it("a new edit clears the redo side", async () => {
    const { spine, a, b } = workspace();
    a.edit(1);
    await spine.undo();
    expect(spine.canRedo()).toBe(true);
    b.edit(2);
    expect(spine.canRedo()).toBe(false);
    await spine.redo();
    expect(a.log).toEqual(["undo:1"]);
  });
});

describe("the ledger under domain loss", () => {
  it("steps over a dropped domain's tokens without breaking the line", async () => {
    const { spine, a, b } = workspace();
    a.edit(1);
    b.edit(2);
    a.edit(3);
    spine.drop("b"); // b's history was reset by a collaborator
    await spine.undo();
    await spine.undo();
    expect(a.log).toEqual(["undo:3", "undo:1"]);
    expect(b.log).toEqual([]);
    expect(spine.canUndo()).toBe(false);
  });

  it("tombstones a stale token when the domain's stack is emptier than the ledger", async () => {
    const { spine, a, b } = workspace();
    a.edit(1);
    b.edit(2);
    b.past = []; // b lost its state without telling the spine
    await spine.undo(); // b's token dies; the walk continues into a
    expect(a.log).toEqual(["undo:1"]);
  });

  it("trims the oldest token when a domain's bounded stack overflows", async () => {
    const { spine, trail, a, b } = workspace();
    a.edit(1);
    b.edit(2);
    a.edit(3);
    a.past.shift(); // the domain trimmed entry 1...
    spine.trim("a"); // ...and says so
    await spine.undo();
    await spine.undo();
    await spine.undo();
    expect(trail).toEqual(["a:undo:3", "b:undo:2"]);
    expect(spine.canUndo()).toBe(false);
  });
});

describe("multi-consume (Yjs pops no-op items in one call)", () => {
  it("drops the same count of tokens the executor consumed", async () => {
    const { spine, a, b } = workspace();
    b.edit(0);
    a.edit(1);
    a.edit(2);
    a.edit(3);
    a.noop.add(3);
    a.noop.add(2); // undoing once will silently consume 3 and 2, then land on 1
    await spine.undo();
    expect(a.log).toEqual(["undo:1"]);
    expect(a.past).toEqual([]);
    // Exactly one more live token — b's — remains.
    await spine.undo();
    expect(b.log).toEqual(["undo:0"]);
    expect(spine.canUndo()).toBe(false);
  });

  it("keeps walking into the next domain when everything consumed was a no-op", async () => {
    const { spine, a, b } = workspace();
    b.edit(0);
    a.edit(1);
    a.noop.add(1);
    await spine.undo(); // a consumes its only entry invisibly; b answers
    expect(b.log).toEqual(["undo:0"]);
  });
});

describe("blocked domains", () => {
  it("stops the walk without spending anything", async () => {
    const { spine, a, b } = workspace();
    a.edit(1);
    b.edit(2);
    b.blockedNow = true; // a live gesture holds b's bracket
    await spine.undo();
    expect(a.log).toEqual([]);
    expect(b.log).toEqual([]);
    b.blockedNow = false;
    await spine.undo();
    expect(b.log).toEqual(["undo:2"]);
  });
});

describe("focus entries", () => {
  it("is a stop on the timeline but keeps redo alive", async () => {
    const { spine, a } = workspace();
    const seen: string[] = [];
    const focus = new FocusDomain<string>(spine, "focus", (s) => seen.push(s));
    spine.register("focus", focus);

    a.edit(1);
    await spine.undo();
    expect(spine.canRedo()).toBe(true);
    focus.record("none", "canvas"); // clicking into a diagram after an undo
    expect(spine.canRedo()).toBe(true); // ...must not throw the redo away
    await spine.undo(); // first the focus change comes back
    expect(seen).toEqual(["none"]);
    await spine.redo();
    expect(seen).toEqual(["none", "canvas"]);
  });

  it("collapses consecutive focus moves into one step", async () => {
    const { spine, a } = workspace();
    const seen: string[] = [];
    const focus = new FocusDomain<string>(spine, "focus", (s) => seen.push(s));
    spine.register("focus", focus);

    a.edit(1);
    focus.record("none", "card-1");
    focus.record("card-1", "card-2");
    focus.record("card-2", "card-3");
    await spine.undo(); // one step back over all three moves
    expect(seen).toEqual(["none"]);
    await spine.undo();
    expect(a.log).toEqual(["undo:1"]);
  });

  it("does not collapse across an intervening edit", async () => {
    const { spine, a } = workspace();
    const seen: string[] = [];
    const focus = new FocusDomain<string>(spine, "focus", (s) => seen.push(s));
    spine.register("focus", focus);

    focus.record("none", "card-1");
    a.edit(1);
    focus.record("card-1", "card-2");
    await spine.undo();
    expect(seen).toEqual(["card-1"]);
    await spine.undo();
    expect(a.log).toEqual(["undo:1"]);
    await spine.undo();
    expect(seen).toEqual(["card-1", "none"]);
  });
});

describe("summoning across pages", () => {
  it("navigates to the token's page and waits for the domain to mount", async () => {
    const spine = new WorkspaceHistory();
    let current: string | null = "page-1";
    const opened: string[] = [];
    spine.setNavigator({
      currentPage: () => current,
      openPage: (id) => {
        opened.push(id);
        current = id;
      },
    });

    const a = new FakeDomain(spine, "a");
    const un = spine.register("a", a, "page-2");
    a.edit(1);
    un(); // the page was left; its domains unmounted

    const walked = spine.undo();
    // The navigator was asked for page-2; the domain mounts a beat later.
    expect(opened).toEqual(["page-2"]);
    spine.register("a", a, "page-2");
    await walked;
    expect(a.log).toEqual(["undo:1"]);
  });

  it("gives up on a domain that never comes back and keeps walking", async () => {
    const spine = new WorkspaceHistory();
    const b = new FakeDomain(spine, "b");
    spine.register("b", b);
    b.edit(0);

    const a = new FakeDomain(spine, "a");
    const un = spine.register("a", a);
    a.edit(1);
    un();

    await spine.undo(); // a is gone with no page to summon it on; b answers
    expect(b.log).toEqual(["undo:0"]);
  });

  it("waits for a domain on this page only once the part before it has stepped", async () => {
    // A diagram's open bracket closing into the step that takes its block
    // out: the text's undo brings the block back, and the diagram's domain
    // with it, which is only then there to take its own part.
    const spine = new WorkspaceHistory();
    spine.setNavigator({ currentPage: () => "page-1", openPage: () => {} });
    const trail: string[] = [];
    const diagram = new FakeDomain(spine, "diagram", trail);
    let unmount = spine.register("diagram", diagram, "page-1");
    const text = new FakeDomain(spine, "text", trail);
    const textUndo = text.undo.bind(text);
    text.undo = () => {
      const step = textUndo();
      queueMicrotask(() => (unmount = spine.register("diagram", diagram, "page-1")));
      return step;
    };
    spine.register("text", text, "page-1");
    spine.batch(() => {
      diagram.edit(1);
      text.edit(2);
    });
    unmount();

    await spine.undo();
    expect(trail).toEqual(["text:undo:2", "diagram:undo:1"]);
    await spine.redo();
    expect(trail.slice(2)).toEqual(["diagram:redo:1", "text:redo:2"]);
  });
});

/** A domain that reports a live gesture up front, as the canvas does. */
class GestureDomain extends FakeDomain {
  blocked(): boolean {
    return this.blockedNow;
  }
}

/**
 * A domain holding a run open on an idle timer — the canvas's typing run. As
 * with the store's open bracket, it reads as blocked until settled, and its
 * own step settles it too.
 */
class HeldDomain extends FakeDomain {
  /** The open run's edits, closing into one entry; `[]` has changed nothing. */
  held: number[] | null = null;

  blocked(): boolean {
    return this.held !== null;
  }

  settle(): void {
    const run = this.held;
    if (run === null) return;
    this.held = null;
    if (run.length > 0) this.edit(run[run.length - 1]);
  }

  undo(): DomainStep {
    this.settle();
    return super.undo();
  }

  redo(): DomainStep {
    this.settle();
    return super.redo();
  }
}

function heldWorkspace() {
  const spine = new WorkspaceHistory();
  const trail: string[] = [];
  const a = new HeldDomain(spine, "a", trail);
  const b = new FakeDomain(spine, "b", trail);
  spine.register("a", a);
  spine.register("b", b);
  return { spine, trail, a, b };
}

function gestureWorkspace() {
  const spine = new WorkspaceHistory();
  const trail: string[] = [];
  const a = new GestureDomain(spine, "a", trail);
  const b = new GestureDomain(spine, "b", trail);
  const c = new GestureDomain(spine, "c", trail);
  for (const [id, domain] of [["a", a], ["b", b], ["c", c]] as const) spine.register(id, domain);
  return { spine, trail, a, b, c };
}

describe("compound steps", () => {
  it("makes one step of three domains' entries", async () => {
    const { spine, a, b, c } = gestureWorkspace();
    spine.batch(() => {
      a.edit(1);
      b.edit(2);
      c.edit(3);
    });
    await spine.undo();
    expect([a.log, b.log, c.log]).toEqual([["undo:1"], ["undo:2"], ["undo:3"]]);
    expect(spine.canUndo()).toBe(false);
    await spine.redo();
    expect([a.log, b.log, c.log]).toEqual([
      ["undo:1", "redo:1"],
      ["undo:2", "redo:2"],
      ["undo:3", "redo:3"],
    ]);
    expect(spine.canRedo()).toBe(false);
  });

  it("undoes newest-first and redoes oldest-first", async () => {
    const { spine, trail, a, b, c } = gestureWorkspace();
    spine.batch(() => {
      a.edit(1);
      b.edit(2);
      c.edit(3);
    });
    await spine.undo();
    expect(trail).toEqual(["c:undo:3", "b:undo:2", "a:undo:1"]);
    trail.length = 0;
    await spine.redo();
    expect(trail).toEqual(["a:redo:1", "b:redo:2", "c:redo:3"]);
    trail.length = 0;
    await spine.undo(); // the replayed step keeps its order
    expect(trail).toEqual(["c:undo:3", "b:undo:2", "a:undo:1"]);
  });

  it("spends nothing when any domain of the step is blocked, in either direction", async () => {
    const { spine, trail, a, b } = gestureWorkspace();
    spine.batch(() => {
      a.edit(1);
      b.edit(2);
    });
    spine.batch(() => {
      a.edit(3);
      b.edit(4);
    });
    await spine.undo();
    trail.length = 0;

    a.blockedNow = true; // stepped last in the undo, first in the redo
    await spine.undo();
    await spine.redo();
    expect(trail).toEqual([]);
    expect([a.past, b.past]).toEqual([[1], [2]]);
    expect([a.future, b.future]).toEqual([[3], [4]]);
    expect(spine.canUndo()).toBe(true);
    expect(spine.canRedo()).toBe(true);

    a.blockedNow = false;
    await spine.redo();
    expect(trail).toEqual(["a:redo:3", "b:redo:4"]);
    await spine.undo();
    await spine.undo();
    expect([a.past, b.past]).toEqual([[], []]);
  });

  it("lets a lone part settle a held run and step it, keeping the way back", async () => {
    const { spine, trail, a } = heldWorkspace();
    a.edit(1);
    a.held = [2]; // a typing run the idle timer has not closed yet
    await spine.undo();
    expect(trail).toEqual(["a:undo:2"]);
    await spine.undo();
    await spine.redo();
    await spine.redo();
    expect(trail).toEqual(["a:undo:2", "a:undo:1", "a:redo:1", "a:redo:2"]);
  });

  it("redoes nothing past a settled run, which is an edit", async () => {
    const { spine, trail, a, b } = heldWorkspace();
    a.edit(1);
    b.edit(2);
    await spine.undo();
    await spine.undo();
    a.held = [3];
    await spine.redo(); // settling the run clears the redo side mid-walk
    expect(trail).toEqual(["b:undo:2", "a:undo:1"]);
    expect(spine.canRedo()).toBe(false);
    await spine.undo();
    expect(trail).toEqual(["b:undo:2", "a:undo:1", "a:undo:3"]);
  });

  it("settles an idle run before asking, so a step of several goes in one press", async () => {
    const { spine, trail, a, b } = heldWorkspace();
    spine.batch(() => {
      a.edit(1);
      b.edit(2);
    });
    a.held = []; // a panel's typing run, open on its timer, nothing typed yet
    await spine.undo();
    expect(a.held).toBeNull();
    expect(trail).toEqual(["b:undo:2", "a:undo:1"]);
    expect(spine.canUndo()).toBe(false);
  });

  it("re-reads the top when settling records: the run first, then the step of several", async () => {
    const { spine, trail, a, b } = heldWorkspace();
    spine.batch(() => {
      a.edit(1);
      b.edit(2);
    });
    a.held = [3];
    await spine.undo(); // the run closes as a step of its own, newer than the batch
    expect(trail).toEqual(["a:undo:3"]);
    expect(b.past).toEqual([2]);
    await spine.undo();
    expect(trail).toEqual(["a:undo:3", "b:undo:2", "a:undo:1"]);
    expect(spine.canUndo()).toBe(false);
    await spine.redo();
    expect(trail).toEqual(["a:undo:3", "b:undo:2", "a:undo:1", "a:redo:1", "b:redo:2"]);
  });

  it("still refuses a step of several while a live gesture holds a bracket", async () => {
    const spine = new WorkspaceHistory();
    const trail: string[] = [];
    const a = new HeldDomain(spine, "a", trail);
    const b = new GestureDomain(spine, "b", trail);
    spine.register("a", a);
    spine.register("b", b);
    spine.batch(() => {
      a.edit(1);
      b.edit(2);
    });
    a.held = [];
    b.blockedNow = true; // a drag in hand: settling leaves it open
    await spine.undo();
    expect(a.held).toBeNull();
    expect(trail).toEqual([]);
    expect([a.past, b.past]).toEqual([[1], [2]]);
  });

  it("keeps what stepped when a domain can only refuse by trying", async () => {
    const { spine, trail, a, b } = workspace();
    spine.batch(() => {
      a.edit(1);
      b.edit(2);
    });
    a.blockedNow = true; // no blocked(): b steps before a refuses
    await spine.undo();
    expect(trail).toEqual(["b:undo:2"]);
    expect(spine.canUndo()).toBe(true);
    expect(spine.canRedo()).toBe(true);

    a.blockedNow = false;
    await spine.undo(); // the rest of the step, on the next press
    await spine.redo();
    await spine.redo();
    expect(trail).toEqual(["b:undo:2", "a:undo:1", "a:redo:1", "b:redo:2"]);
  });

  it("redoes only the domains that stepped", async () => {
    const { spine, trail, a, b, c } = gestureWorkspace();
    spine.batch(() => {
      a.edit(1);
      b.edit(2);
      c.edit(3);
    });
    b.noop.add(2); // a collaborator overwrote it: consumed, nothing to redo
    await spine.undo();
    expect(trail).toEqual(["c:undo:3", "a:undo:1"]);
    const redo = vi.spyOn(b, "redo");
    await spine.redo();
    expect(redo).not.toHaveBeenCalled();
    expect(trail).toEqual(["c:undo:3", "a:undo:1", "a:redo:1", "c:redo:3"]);
  });

  it("drops one domain's parts and keeps the survivors' ledger", async () => {
    const { spine, a, b } = gestureWorkspace();
    b.edit(0);
    spine.batch(() => {
      a.edit(1);
      b.edit(2);
    });
    a.past = []; // a collaborator's merge reset a...
    spine.drop("a"); // ...and it says so
    await spine.undo();
    expect(b.log).toEqual(["undo:2"]);
    await spine.undo();
    expect(b.log).toEqual(["undo:2", "undo:0"]);
    expect(a.log).toEqual([]);
    expect(spine.canUndo()).toBe(false);
  });

  it("trims a domain's oldest part out of a step it shares", async () => {
    const { spine, trail, a, b } = gestureWorkspace();
    spine.batch(() => {
      a.edit(1);
      b.edit(2);
    });
    b.edit(3);
    b.past.shift(); // b's bounded stack dropped entry 2...
    spine.trim("b"); // ...which leaves a alone in the shared step
    await spine.undo();
    expect(trail).toEqual(["b:undo:3"]); // b's newest steps alone
    expect(spine.canUndo()).toBe(true);
    await spine.undo();
    expect(trail).toEqual(["b:undo:3", "a:undo:1"]);
    expect(spine.canUndo()).toBe(false);
  });

  it("strips extra consumed entries from the domain's older steps", async () => {
    const { spine, trail, a, b } = gestureWorkspace();
    a.edit(0);
    b.edit(5);
    a.edit(1);
    spine.batch(() => {
      a.edit(2);
      b.edit(3);
    });
    a.noop.add(2); // undoing a consumes 2 and 1 in one call
    await spine.undo();
    expect(trail).toEqual(["b:undo:3", "a:undo:1"]);
    await spine.undo(); // a's step for 1 died with it: b's older step is next, not a's
    expect(trail).toEqual(["b:undo:3", "a:undo:1", "b:undo:5"]);
    await spine.undo();
    expect(trail).toEqual(["b:undo:3", "a:undo:1", "b:undo:5", "a:undo:0"]);
    expect(spine.canUndo()).toBe(false);
  });

  it("flattens nested batches into the outermost", async () => {
    const { spine, a, b, c } = gestureWorkspace();
    const result = spine.batch(() => {
      a.edit(1);
      return spine.batch(() => {
        b.edit(2);
        spine.batch(() => c.edit(3));
        return "inner";
      });
    });
    expect(result).toBe("inner");
    a.edit(4); // after the batch: a step of its own
    await spine.undo();
    expect(a.log).toEqual(["undo:4"]);
    await spine.undo();
    expect([a.log, b.log, c.log]).toEqual([["undo:4", "undo:1"], ["undo:2"], ["undo:3"]]);
    expect(spine.canUndo()).toBe(false);
  });

  it("makes a one-record batch the same as a plain token", async () => {
    const { spine, a } = gestureWorkspace();
    const seen: string[] = [];
    const focus = new FocusDomain<string>(spine, "focus", (s) => seen.push(s));
    spine.register("focus", focus);

    spine.batch(() => a.edit(1));
    spine.batch(() => focus.record("none", "card-1"));
    spine.batch(() => focus.record("card-1", "card-2")); // folds in when it closes alone
    focus.record("card-2", "card-3"); // as does a plain record after it
    await spine.undo();
    expect(seen).toEqual(["none"]);
    await spine.undo();
    expect(a.log).toEqual(["undo:1"]);
    expect(spine.canUndo()).toBe(false);
  });

  it("records nothing for a batch with no records", async () => {
    const { spine, a } = gestureWorkspace();
    a.edit(1);
    await spine.undo();
    expect(spine.batch(() => 42)).toBe(42);
    expect(spine.canUndo()).toBe(false);
    expect(spine.canRedo()).toBe(true);
  });

  it("closes the batch when its body throws, keeping what it recorded", async () => {
    const { spine, a, b } = gestureWorkspace();
    expect(() =>
      spine.batch(() => {
        a.edit(1);
        throw new Error("mid-gesture failure");
      }),
    ).toThrow("mid-gesture failure");
    b.edit(2); // outside: its own step
    await spine.undo();
    expect(b.log).toEqual(["undo:2"]);
    expect(a.log).toEqual([]);
    await spine.undo();
    expect(a.log).toEqual(["undo:1"]);
  });

  it("is an edit if any part is, and a focus stop otherwise", async () => {
    const { spine, a } = gestureWorkspace();
    const seen: string[] = [];
    const focus = new FocusDomain<string>(spine, "focus", (s) => seen.push(s));
    spine.register("focus", focus);

    a.edit(1);
    await spine.undo();
    spine.batch(() => focus.record("none", "canvas"));
    expect(spine.canRedo()).toBe(true);
    spine.batch(() => {
      focus.record("canvas", "card-1");
      a.edit(2);
    });
    expect(spine.canRedo()).toBe(false);
  });

  it("keeps a focus move inside a batch in that step", async () => {
    const { spine, a } = gestureWorkspace();
    const seen: string[] = [];
    const focus = new FocusDomain<string>(spine, "focus", (s) => seen.push(s));
    spine.register("focus", focus);

    focus.record("none", "card-1");
    spine.batch(() => {
      focus.record("card-1", "canvas"); // first in the batch: no folding into card-1's stop
      a.edit(1);
    });
    focus.record("canvas", "card-2"); // nor into a step it shares with a
    await spine.undo();
    expect(seen).toEqual(["canvas"]);
    await spine.undo();
    expect(a.log).toEqual(["undo:1"]);
    expect(seen).toEqual(["canvas", "card-1"]);
    await spine.undo();
    expect(seen).toEqual(["canvas", "card-1", "none"]);
  });
});
