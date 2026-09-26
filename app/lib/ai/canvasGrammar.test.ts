import { describe, expect, it } from "vitest";
import { CANVAS_GRAMMAR } from "./canvasGrammar";

/**
 * The grammar's sizing is built from the editor's own constants, so the model
 * is told the band the editor actually draws. These are the numbers it has to
 * see; a change to any of them should read as a change to what the model is
 * taught, not slip past it.
 */
describe("the grammar's size and placement", () => {
  const placement = CANVAS_GRAMMAR.slice(CANVAS_GRAMMAR.lastIndexOf("SIZE AND PLACEMENT"));

  it("states the column, the wide band and its range", () => {
    expect(placement).toContain("720 wide");
    expect(placement).toContain("1200 when it has the bare wide attribute");
    expect(placement).toContain("x = -240 … 960");
  });

  it("states the margin above, and the body type to match", () => {
    expect(placement).toContain("Leave 24px above the first shape");
    expect(placement).toContain("15px with a 1.7 line height (25.5px per line)");
  });

  it("tells the model the read's w is not its to write", () => {
    expect(placement).toMatch(/A read shows w and h on <nt-diagram>: w is the page's width, never yours to write/);
  });

  it("tells the model the height follows the content, and a larger h pins it", () => {
    expect(placement).toMatch(/height follows its content, growing and\nshrinking with it/);
    expect(placement).toMatch(/write a larger h only to\nadd room below the lowest shape/);
  });

  it("no longer teaches the old frame: no x=40 start, no w/h to set", () => {
    expect(placement).not.toContain("x=40");
    expect(placement).not.toMatch(/set w\/h/);
  });
});
