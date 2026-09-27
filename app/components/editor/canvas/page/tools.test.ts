import { describe, expect, it } from "vitest";
import { createPageTools } from "./tools";

describe("createPageTools", () => {
  it("starts on Move, unlocked", () => {
    const tools = createPageTools();
    expect(tools.snapshot()).toEqual({ tool: "move", locked: false });
  });

  it("settles back to Move after one use", () => {
    const tools = createPageTools();
    tools.set("rect");
    tools.settle();
    expect(tools.get()).toBe("move");
  });

  it("keeps a locked tool through a settle", () => {
    const tools = createPageTools();
    tools.lock("rect");
    tools.settle();
    expect(tools.snapshot()).toEqual({ tool: "rect", locked: true });
  });

  it("lets the lock go on any pick, the same tool included", () => {
    const tools = createPageTools();
    tools.lock("ellipse");
    tools.set("ellipse");
    expect(tools.locked()).toBe(false);
    tools.lock("ellipse");
    tools.set("move");
    expect(tools.snapshot()).toEqual({ tool: "move", locked: false });
  });

  it("never locks Move", () => {
    const tools = createPageTools();
    tools.lock("move");
    expect(tools.locked()).toBe(false);
    tools.lock("pen");
    tools.lock("move");
    expect(tools.snapshot()).toEqual({ tool: "pen", locked: true });
  });

  it("is never locked while on Move", () => {
    const tools = createPageTools();
    const seen: boolean[] = [];
    tools.subscribe(() => seen.push(tools.get() !== "move" || !tools.locked()));
    tools.lock("connector");
    tools.settle();
    tools.set("move");
    tools.lock("diamond");
    tools.set("move");
    expect(seen.every(Boolean)).toBe(true);
    expect(tools.locked()).toBe(false);
  });

  it("the connector settles like every other tool", () => {
    const tools = createPageTools();
    tools.set("connector");
    tools.settle();
    expect(tools.get()).toBe("move");
  });

  it("notifies once per change and keeps the snapshot while nothing changes", () => {
    const tools = createPageTools();
    let calls = 0;
    tools.subscribe(() => calls++);
    tools.set("rect");
    const held = tools.snapshot();
    tools.set("rect");
    tools.settle();
    tools.settle();
    expect(calls).toBe(2);
    expect(tools.snapshot()).not.toBe(held);
    tools.set("move");
    expect(calls).toBe(2);
  });
});
