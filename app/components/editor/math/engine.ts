import type { ComputeEngine } from "@cortex-js/compute-engine";

export type LineResult = {
  name: string | null;
  valueLatex: string | null;
  error: string | null;
  empty: boolean;
};

/**
 * Evaluate a list of math lines (each in LaTeX) as a reactive variable sheet.
 *
 * - `a = 3` assigns a variable; a bare `2 + 2` is an expression.
 * - Dependencies between lines are resolved via a topological order, so a
 *   variable can be used before it's defined further down.
 * - Circular references are detected and flagged rather than looping.
 *
 * A fresh ComputeEngine is used per call so no stale assignments leak between
 * recomputes. The class is passed in (lazy-loaded by the caller) to keep the
 * heavy compute-engine module out of the initial bundle.
 */
export function evaluateLines(
  CEClass: typeof ComputeEngine,
  latexLines: string[],
): LineResult[] {
  const ce = new CEClass();
  const n = latexLines.length;

  // `ops` lives on the function subtype, not the base Expression the parser
  // returns, so read it through a minimal shape.
  type Operand = { symbol: string | null; latex: string };
  const opsOf = (e: unknown): readonly Operand[] | undefined =>
    (e as { ops?: readonly Operand[] }).ops;

  type Parsed = { name: string | null; rhsLatex: string | null; empty: boolean };
  const parsed: Parsed[] = latexLines.map((latex) => {
    if (!latex.trim()) return { name: null, rhsLatex: null, empty: true };
    const box = ce.parse(latex);
    const ops = opsOf(box);
    if (box.operator === "Equal" && ops && ops.length === 2 && ops[0].symbol) {
      return { name: ops[0].symbol, rhsLatex: ops[1].latex, empty: false };
    }
    return { name: null, rhsLatex: latex, empty: false };
  });

  // name -> first line index that defines it
  const definedBy = new Map<string, number>();
  parsed.forEach((p, i) => {
    if (p.name && !definedBy.has(p.name)) definedBy.set(p.name, i);
  });

  // Line i depends on the lines that define the free variables of its rhs.
  const deps: number[][] = parsed.map((p) => {
    if (!p.rhsLatex) return [];
    return [...ce.parse(p.rhsLatex).unknowns]
      .map((name) => definedBy.get(name))
      .filter((j): j is number => j !== undefined);
  });

  // DFS topological order + cycle marking.
  const state = new Array(n).fill(0); // 0 unvisited, 1 visiting, 2 done
  const order: number[] = [];
  const inCycle = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const onStack = new Set<number>();

  const visit = (i: number) => {
    state[i] = 1;
    stack.push(i);
    onStack.add(i);
    for (const j of deps[i]) {
      if (onStack.has(j)) {
        for (let k = stack.indexOf(j); k < stack.length; k++) {
          inCycle[stack[k]] = true;
        }
      } else if (state[j] === 0) {
        visit(j);
      }
    }
    stack.pop();
    onStack.delete(i);
    state[i] = 2;
    order.push(i);
  };
  for (let i = 0; i < n; i++) if (state[i] === 0) visit(i);

  const results: LineResult[] = latexLines.map(() => ({
    name: null,
    valueLatex: null,
    error: null,
    empty: false,
  }));

  for (const i of order) {
    const p = parsed[i];
    results[i].name = p.name;
    if (p.empty) {
      results[i].empty = true;
      continue;
    }
    if (inCycle[i]) {
      results[i].error = "circular reference";
      continue;
    }
    try {
      const box = ce.parse(p.rhsLatex!);
      if (!box.isValid) {
        results[i].error = "invalid";
        continue;
      }
      const value = box.N();
      if (!value.isValid || value.unknowns.length > 0) {
        results[i].error = "undefined";
        continue;
      }
      // A definition whose right-hand side is already the literal value
      // (`a = 3`) needs no echoed result; a computed one (`c = a + b`) does.
      const trivialDefinition = p.name !== null && value.latex === box.latex;
      results[i].valueLatex = trivialDefinition ? null : value.latex;
      if (p.name) ce.assign(p.name, value);
    } catch {
      results[i].error = "error";
    }
  }

  return results;
}
