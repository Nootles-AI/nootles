import { describe, expect, it } from "vitest";
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
        this.log.push(`undo:${n}`);
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
    this.log.push(`redo:${n}`);
    return { consumed: 1, redoable: true };
  }
}

function workspace() {
  const spine = new WorkspaceHistory();
  const a = new FakeDomain(spine, "a");
  const b = new FakeDomain(spine, "b");
  spine.register("a", a);
  spine.register("b", b);
  return { spine, a, b };
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
    const { spine, a } = workspace();
    a.edit(1);
    a.edit(2);
    a.past.shift(); // the domain trimmed entry 1...
    spine.trim("a"); // ...and says so
    await spine.undo();
    await spine.undo();
    expect(a.log).toEqual(["undo:2"]);
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
});
