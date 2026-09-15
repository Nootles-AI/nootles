import { afterEach, describe, expect, it, vi } from "vitest";
import { createSurfaceModes, shouldExitOnKeyDown, type SurfaceMode, type SurfaceModeContext } from "./surfaceMode";

/** A context nothing here reads the fields of — every enter/exit test
 *  exercises the registry's own bookkeeping, not a mode's use of the context.
 *  This package's vitest environment (edge-runtime) has no real DOM, so the
 *  registry's document-listener wiring is guarded (`typeof document`) and
 *  simply never arms here — proven end to end instead by the browser harness
 *  (`tests/canvas-color-pick.browser.mjs`, case `pick-cancel-escape`). */
const ctx = (): SurfaceModeContext => ({}) as unknown as SurfaceModeContext;

function mode(id: string, over: Partial<SurfaceMode> = {}): SurfaceMode {
  return { id, ...over };
}

describe("createSurfaceModes", () => {
  it("starts with nothing active", () => {
    const modes = createSurfaceModes(ctx);
    expect(modes.get()).toBeNull();
  });

  it("enter makes the mode active and notifies once", () => {
    const modes = createSurfaceModes(ctx);
    const listener = vi.fn();
    modes.subscribe(listener);
    const a = mode("color-pick");
    modes.enter(a);
    expect(modes.get()).toBe(a);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('enter replaces and exits the previous mode with "replaced"', () => {
    const modes = createSurfaceModes(ctx);
    const exitA = vi.fn();
    const a = mode("color-pick", { onExit: exitA });
    const b = mode("zoom");
    modes.enter(a);
    modes.enter(b);
    expect(exitA).toHaveBeenCalledWith("replaced");
    expect(modes.get()).toBe(b);
  });

  it("release is idempotent and ignores a superseded mode", () => {
    const modes = createSurfaceModes(ctx);
    const exitA = vi.fn();
    const a = mode("color-pick", { onExit: exitA });
    const release = modes.enter(a);
    release();
    expect(exitA).toHaveBeenCalledTimes(1);
    expect(exitA).toHaveBeenCalledWith("released");
    // A second call to the same release is a no-op — no second onExit.
    release();
    expect(exitA).toHaveBeenCalledTimes(1);

    // A release captured before a second mode entered must not tear the
    // second one down.
    const exitB = vi.fn();
    const b = mode("zoom", { onExit: exitB });
    const releaseA2 = modes.enter(a);
    modes.enter(b);
    releaseA2();
    expect(exitB).not.toHaveBeenCalled();
    expect(modes.get()).toBe(b);
  });

  it("exit(unmounted) calls onExit once and clears the slot", () => {
    const modes = createSurfaceModes(ctx);
    const onExit = vi.fn();
    modes.enter(mode("color-pick", { onExit }));
    modes.exit("unmounted");
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith("unmounted");
    expect(modes.get()).toBeNull();
    // Exiting again with nothing active is a no-op.
    modes.exit("unmounted");
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("subscribe fires once per enter/exit and can unsubscribe", () => {
    const modes = createSurfaceModes(ctx);
    const listener = vi.fn();
    const off = modes.subscribe(listener);
    modes.enter(mode("color-pick"));
    modes.exit();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    modes.enter(mode("zoom"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("shouldExitOnKeyDown", () => {
  it("escape exits a mode that does not consume it", () => {
    const m = mode("color-pick");
    expect(shouldExitOnKeyDown(m, { key: "Escape" } as KeyboardEvent, ctx())).toBe(true);
  });

  it("escape does not exit a mode that consumes it", () => {
    const onKeyDown = vi.fn(() => true);
    const m = mode("color-pick", { onKeyDown });
    expect(shouldExitOnKeyDown(m, { key: "Escape" } as KeyboardEvent, ctx())).toBe(false);
    expect(onKeyDown).toHaveBeenCalled();
  });

  it("a non-escape key never exits, consumed or not", () => {
    const m = mode("color-pick");
    expect(shouldExitOnKeyDown(m, { key: "a" } as KeyboardEvent, ctx())).toBe(false);
  });
});

describe("document wiring (stubbed — this environment has no real DOM)", () => {
  const originalDocument = (globalThis as { document?: unknown }).document;

  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDocument;
  });

  it("arms a capture-phase keydown listener on enter and removes it on exit", () => {
    const add = vi.fn();
    const remove = vi.fn();
    (globalThis as { document?: unknown }).document = { addEventListener: add, removeEventListener: remove };

    const modes = createSurfaceModes(ctx);
    modes.enter(mode("color-pick"));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith("keydown", expect.any(Function), true);

    modes.exit();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("keydown", add.mock.calls[0][1], true);
  });

  it("does not re-arm a second listener when one mode replaces another", () => {
    const add = vi.fn();
    const remove = vi.fn();
    (globalThis as { document?: unknown }).document = { addEventListener: add, removeEventListener: remove };

    const modes = createSurfaceModes(ctx);
    modes.enter(mode("color-pick"));
    modes.enter(mode("zoom"));
    // replaced -> exit (removes) -> enter (adds again): one of each per swap.
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
