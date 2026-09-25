import { afterEach, describe, expect, it, vi } from "vitest";
import { focusCodeBlock, registerCodeBlock, type CodeCaret } from "./focusRequests";

/** A page root holding exactly the given hosts. */
const page = (...hosts: object[]) => ({
  contains: (h: unknown) => hosts.includes(h as object),
});

const cleanups: (() => void)[] = [];
function mount(id: string, host: object) {
  const focus = vi.fn<(at: CodeCaret) => void>();
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
    expect(focus).toHaveBeenCalledWith("end");
  });

  it("waits for an editor that has not mounted yet, and is taken once", () => {
    const host = {};
    focusCodeBlock(page(host), "b", "start");
    expect(mount("b", host)).toHaveBeenCalledWith("start");
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
});
