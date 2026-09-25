import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelWaiting,
  focusCodeBlock,
  holdKey,
  registerCodeBlock,
  type CodeCaret,
} from "./focusRequests";

/** A page root holding exactly the given hosts. */
const page = (...hosts: object[]) => ({
  contains: (h: unknown) => hosts.includes(h as object),
});

const cleanups: (() => void)[] = [];
function mount(id: string, host: object) {
  const focus = vi.fn<(at: CodeCaret, typed: string) => void>();
  cleanups.push(registerCodeBlock(id, host, focus));
  return focus;
}

afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  vi.useRealTimers();
});

describe("code block focus requests", () => {
  it("reaches an editor that is already mounted", () => {
    const host = {};
    const focus = mount("a", host);
    focusCodeBlock(page(host), "a", "end");
    expect(focus).toHaveBeenCalledWith("end", "");
  });

  it("waits for an editor that has not mounted yet, and is taken once", () => {
    const host = {};
    focusCodeBlock(page(host), "b", "start");
    expect(mount("b", host)).toHaveBeenCalledWith("start", "");
    expect(mount("b", host)).not.toHaveBeenCalled();
  });

  it("only answers inside the page that asked", () => {
    const here = {};
    const there = {};
    const elsewhere = mount("c", there);
    const mine = mount("c", here);
    focusCodeBlock(page(here), "c", "start");
    expect(mine).toHaveBeenCalledOnce();
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it("drops a request nobody claimed in time", () => {
    vi.useFakeTimers();
    const host = {};
    focusCodeBlock(page(host), "d", "start");
    vi.advanceTimersByTime(60_000);
    expect(mount("d", host)).not.toHaveBeenCalled();
  });

  it("stops answering once unmounted", () => {
    const host = {};
    const focus = vi.fn();
    registerCodeBlock("e", host, focus)();
    focusCodeBlock(page(host), "e", "start");
    expect(focus).not.toHaveBeenCalled();
  });

  it("keeps what is typed while it waits, for the editor to take", () => {
    const host = {};
    const scope = page(host);
    focusCodeBlock(scope, "f", "start");
    for (const key of ["a", "b", "x", "Backspace", "Enter", "c"]) {
      expect(holdKey(scope, press(key))).toBe(true);
    }
    expect(holdKey(scope, press("Shift"))).toBe(false);
    expect(mount("f", host)).toHaveBeenCalledWith("start", "ab\nc");
  });

  it("holds nothing when no request is waiting", () => {
    expect(holdKey(page({}), press("a"))).toBe(false);
  });

  it("ends the wait on any other key, which the page keeps", () => {
    const host = {};
    const scope = page(host);
    focusCodeBlock(scope, "g", "end");
    expect(holdKey(scope, press("ArrowUp"))).toBe(false);
    expect(holdKey(scope, press("a"))).toBe(false);
    expect(mount("g", host)).not.toHaveBeenCalled();
  });

  it("leaves shortcuts to the page, and ends the wait", () => {
    const host = {};
    const scope = page(host);
    focusCodeBlock(scope, "h", "end");
    expect(holdKey(scope, press("z", { metaKey: true }))).toBe(false);
    expect(mount("h", host)).not.toHaveBeenCalled();
  });

  it("is dropped when the page is left some other way", () => {
    const host = {};
    const scope = page(host);
    focusCodeBlock(scope, "i", "end");
    cancelWaiting(scope);
    expect(mount("i", host)).not.toHaveBeenCalled();
  });

  it("stays alive while someone types into it", () => {
    vi.useFakeTimers();
    const host = {};
    const scope = page(host);
    focusCodeBlock(scope, "j", "start");
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(4000);
      expect(holdKey(scope, press("k"))).toBe(true);
    }
    expect(mount("j", host)).toHaveBeenCalledWith("start", "kkkkk");
  });

  it("passes the caret on when the editor holding it is replaced", () => {
    const first = {};
    const second = {};
    const scope = page(first, second);
    const dispose = registerCodeBlock("k", first, vi.fn(), () => 3);
    focusCodeBlock(scope, "k", "start");
    dispose();
    expect(mount("k", second)).toHaveBeenCalledWith(3, "");
  });

  it("passes it on to a replacement that mounted first", () => {
    const first = {};
    const second = {};
    const dispose = registerCodeBlock("l", first, vi.fn(), () => "end");
    focusCodeBlock(page(first, second), "l", "start");
    const replacement = mount("l", second);
    expect(replacement).not.toHaveBeenCalled();
    dispose();
    expect(replacement).toHaveBeenCalledWith("end", "");
  });

  it("keeps the caret where it went when the editor was left, not replaced", () => {
    const first = {};
    const second = {};
    const dispose = registerCodeBlock("m", first, vi.fn(), () => null);
    focusCodeBlock(page(first, second), "m", "start");
    dispose();
    expect(mount("m", second)).not.toHaveBeenCalled();
  });

  it("passes nothing on once the editor has held the caret a while", () => {
    vi.useFakeTimers();
    const first = {};
    const second = {};
    const dispose = registerCodeBlock("n", first, vi.fn(), () => 2);
    focusCodeBlock(page(first, second), "n", "start");
    vi.advanceTimersByTime(5000);
    dispose();
    expect(mount("n", second)).not.toHaveBeenCalled();
  });
});

function press(key: string, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}) {
  return { key, metaKey: false, ctrlKey: false, isComposing: false, ...mods };
}
