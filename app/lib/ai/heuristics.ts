import { AI, normalizeLanguage } from "./aiConfig";
import type { AnyBlock } from "./projection";

/**
 * Tier 0 of the suggestion pipeline: local, synchronous, free.
 *
 * Runs on every editor change and proposes at most one action. ~90% of pauses
 * end here with `null` and never touch the network. Everything it proposes is
 * anchored to the cursor block — a proposal's targets ALWAYS include the block
 * being edited — so a suggestion aimed at an unrelated part of the document is
 * impossible by construction rather than by asking a model nicely.
 *
 * Pure: no editor, no React, no I/O. Easy to exercise over fixtures.
 */

export type ProposalKind =
  | "code" // prose introduces code the user hasn't written → insert a block
  | "formatCode" // the text IS code → convert it to a code block
  | "formatMath" // the text is equations → convert to a reactive math block
  | "reformat" // list / checklist / heading
  | "diagram"; // the text describes a flow

export type ReformatTarget =
  | "bulletListItem"
  | "checkListItem"
  | "heading"
  | "codeBlock"
  | "mathBlock";

export type Proposal = {
  kind: ProposalKind;
  /** Chip caption, e.g. "Insert code block". */
  label: string;
  confidence: number;
  /** The cursor block — insertion anchor. */
  anchorBlockId: string;
  /** Reformat targets; always contains `anchorBlockId`. Empty for pure inserts. */
  blockIds: string[];
  language?: string;
  intent?: string;
  to?: ReformatTarget;
  headingLevel?: number;
  /** Text the gate sees. */
  nearbyText: string;
  /** Human phrasing of the proposal for the gate prompt. */
  gateProposal: string;
};

export type FlatBlock = { id: string; type: string; text: string };

export type HeuristicInput = {
  blocks: FlatBlock[];
  cursorBlockId: string;
};

const PROSE_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "quote",
]);

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

function blockText(block: AnyBlock): string {
  if (block.type === "codeBlock") return String(block.props?.code ?? "");
  if (block.type === "mathBlock") return String(block.props?.source ?? "");
  if (!Array.isArray(block.content)) return "";
  return (block.content as Array<Record<string, unknown>>)
    .map((i) => {
      if (i.type === "text") return String(i.text ?? "");
      if (i.type === "math") {
        return String((i.props as { latex?: string } | undefined)?.latex ?? "");
      }
      return "";
    })
    .join("");
}

/** Document-order flat view of the block tree (children inlined after parents). */
export function flattenBlocks(blocks: AnyBlock[]): FlatBlock[] {
  const out: FlatBlock[] = [];
  const walk = (bs: AnyBlock[]) => {
    for (const b of bs) {
      out.push({ id: b.id, type: b.type, text: blockText(b) });
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const LANGUAGE_HINTS: Array<[RegExp, string]> = [
  [/\b(python|py)\b/i, "python"],
  [/\btypescript|\bts\b/i, "typescript"],
  [/\b(javascript|js|node)\b/i, "javascript"],
  [/\bsql\b/i, "sql"],
  [/\bjava\b/i, "java"],
  [/\brust\b/i, "rust"],
  [/\bgo(lang)?\b/i, "go"],
  [/\bhtml\b/i, "html"],
  [/\bcss\b/i, "css"],
  [/\b(bash|shell|sh)\b/i, "bash"],
  [/\bc\+\+|\bcpp\b/i, "cpp"],
  [/\bc#|\bcsharp\b/i, "csharp"],
];

function languageFromMention(text: string): string | undefined {
  for (const [re, lang] of LANGUAGE_HINTS) if (re.test(text)) return lang;
  return undefined;
}

function languageFromCode(text: string): string {
  if (/\b(def|elif)\s|\bprint\s*\(|\bimport\s+\w+$|range\s*\(/m.test(text)) {
    return "python";
  }
  if (/\bSELECT\b[\s\S]*\bFROM\b/i.test(text)) return "sql";
  if (/#include|\bprintf\s*\(|\bint\s+main\s*\(/.test(text)) return "cpp";
  if (/\bfn\s+\w+|let\s+mut\b|println!/.test(text)) return "rust";
  if (/\bpackage\s+main\b|\bfunc\s+\w+|fmt\./.test(text)) return "go";
  if (/\bpublic\s+(static\s+)?(class|void)\b|System\.out\./.test(text)) {
    return "java";
  }
  if (/^\s*<\/?[a-z][\w-]*(\s|>|\/)/m.test(text)) return "html";
  if (/:\s*(string|number|boolean)\b|\binterface\s+\w+|\btype\s+\w+\s*=/.test(text)) {
    return "typescript";
  }
  if (/\b(const|let|var|function)\b|=>|console\.log/.test(text)) return "javascript";
  return "text";
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Strong indicators the text is literally source code. */
const CODE_PATTERNS: RegExp[] = [
  /^\s*(def|class|fn|func)\s+\w+\s*[（(]/m,
  /^\s*(function|const|let|var)\s+\w+\s*[=(]/m,
  /^\s*(import|from|#include|using|package)\s+\S/m,
  /^\s*for\s*\(|^\s*for\s+\w+\s+in\s+/m,
  /^\s*(while|if|switch|elif)\s*\(/m,
  /\bSELECT\b[\s\S]*\bFROM\b/i,
  /^\s*(public|private|protected|static)\s+\w+/m,
  /^\s*<\/?[a-z][\w-]*(\s|>|\/)/m,
  /\bconsole\.log\s*\(|\bprint\s*\(|\bprintf\s*\(|System\.out\./,
  /^\s*[\w.[\]]+\s*=\s*[^=].*;\s*$/m,
  /[{};]\s*$/m,
  /=>|::|->/,
];

const TASK_VERBS =
  /^(buy|walk|finish|call|send|write|fix|add|review|update|check|email|book|clean|pay|ship|test|plan|schedule|draft|refactor|deploy|merge|file|order|renew|cancel|submit|prepare|install|set ?up|follow ?up|ping|read|watch|learn|build|create|remove|delete|rename|migrate|ask|confirm|print)\b/i;

const CODE_NOUNS =
  /\b(function|method|loop|snippet|example|code|script|query|class|component|algorithm|implementation)\b/i;

/**
 * Words that mean "I want a picture, not code". These must win over CODE_NOUNS:
 * "the diagram for the for-loop" contains `loop`, and without this it would be
 * routed to the code branch.
 */
const DIAGRAM_NOUNS =
  /\b(diagram|flow ?chart|chart|graph|architecture|sequence|state machine)\b/i;

const EQUATION = /(^|\s)[a-zA-Z]\w*\s*=\s*[^=]/;
const LATEX = /\\(frac|sum|int|sqrt|alpha|beta|pi|theta|cdot|times|leq|geq|neq)\b/;
const MATH_GLYPH = /[∑∫√≈≠≤≥±×÷π]/;

function isCodeish(text: string): number {
  let score = 0;
  for (const re of CODE_PATTERNS) if (re.test(text)) score++;
  return score;
}

function looksMathy(text: string): boolean {
  if (LATEX.test(text) || MATH_GLYPH.test(text)) return true;
  return EQUATION.test(text) && /[+\-*/^]|\d/.test(text);
}

function endsSentence(text: string): boolean {
  return /[.!?]$/.test(text.trim());
}

/** Maximal run of consecutive blocks around the cursor satisfying `ok`. */
function runAround(
  blocks: FlatBlock[],
  cursorIdx: number,
  ok: (b: FlatBlock) => boolean,
): FlatBlock[] {
  if (!ok(blocks[cursorIdx])) return [];
  let start = cursorIdx;
  let end = cursorIdx;
  while (start - 1 >= 0 && ok(blocks[start - 1])) start--;
  while (end + 1 < blocks.length && ok(blocks[end + 1])) end++;
  return blocks.slice(start, end + 1);
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

export function propose(input: HeuristicInput): Proposal | null {
  const { blocks, cursorBlockId } = input;
  const idx = blocks.findIndex((b) => b.id === cursorBlockId);
  if (idx === -1) return null;

  const cur = blocks[idx];
  const text = cur.text.trim();
  // Only ever act from a prose block with something in it.
  if (!PROSE_TYPES.has(cur.type) || text.length < 3) return null;

  const H = AI.heuristics;
  const candidates: Proposal[] = [];
  // What already follows the cursor block. If the thing we'd propose is already
  // sitting right there, the suggestion is satisfied — don't offer it again.
  const next = blocks[idx + 1];
  const followedBy = (type: string) => next?.type === type;

  // 1. The line already IS code → offer to format it.
  const codeScore = isCodeish(cur.text);
  if (codeScore >= 2 || (codeScore === 1 && /[{};]\s*$|^\s*(def|function|const|import)\s/m.test(cur.text))) {
    const run = runAround(blocks, idx, (b) => b.type === "paragraph" && isCodeish(b.text) >= 1);
    const targets = run.length ? run : [cur];
    const language = normalizeLanguage(
      languageFromCode(targets.map((b) => b.text).join("\n")),
    );
    candidates.push({
      kind: "formatCode",
      label: "Format as code",
      confidence: 0.9,
      anchorBlockId: cur.id,
      blockIds: targets.map((b) => b.id),
      language,
      to: "codeBlock",
      nearbyText: targets.map((b) => b.text).join("\n"),
      gateProposal: `format this text as a ${language} code block`,
    });
  }

  // 2. Prose introduces code that isn't written yet. Naming a language counts
  // as strongly as a code noun does — "…the same logic written in TypeScript:"
  // is plainly a code intro, but matches no noun in the list. Asking for a
  // *diagram* of something code-shaped is not a request for code.
  const mentionedLanguage = languageFromMention(text);
  if (
    text.endsWith(":") &&
    (CODE_NOUNS.test(text) || mentionedLanguage !== undefined) &&
    !DIAGRAM_NOUNS.test(text) &&
    !followedBy("codeBlock")
  ) {
    const language = normalizeLanguage(mentionedLanguage);
    candidates.push({
      kind: "code",
      label: "Insert code block",
      confidence: 0.8,
      anchorBlockId: cur.id,
      blockIds: [],
      language,
      intent: text.replace(/:$/, ""),
      nearbyText: text,
      gateProposal: "insert a code block",
    });
  }

  // 3. Equations typed as prose → a reactive math block.
  if (looksMathy(cur.text) && !followedBy("mathBlock")) {
    const run = runAround(
      blocks,
      idx,
      (b) => b.type === "paragraph" && looksMathy(b.text),
    );
    const targets = run.length ? run : [cur];
    candidates.push({
      kind: "formatMath",
      label: "Format as math",
      confidence: 0.75,
      anchorBlockId: cur.id,
      blockIds: targets.map((b) => b.id),
      to: "mathBlock",
      nearbyText: targets.map((b) => b.text).join("\n"),
      gateProposal: "turn these equations into a math block",
    });
  }

  // 4. A run of short unpunctuated lines reads as a list.
  const listRun = runAround(blocks, idx, (b) => {
    const t = b.text.trim();
    return (
      b.type === "paragraph" &&
      t.length > 0 &&
      t.length <= H.listMaxItemChars &&
      !endsSentence(t) &&
      !t.endsWith(":") &&
      isCodeish(b.text) === 0
    );
  });
  if (listRun.length >= H.listMinItems) {
    const tasks = listRun.filter((b) => TASK_VERBS.test(b.text.trim())).length;
    const asChecklist = tasks * 2 >= listRun.length;
    candidates.push({
      kind: "reformat",
      label: asChecklist ? "Format as checklist" : "Format as list",
      confidence: 0.75,
      anchorBlockId: cur.id,
      blockIds: listRun.map((b) => b.id),
      to: asChecklist ? "checkListItem" : "bulletListItem",
      nearbyText: listRun.map((b) => b.text).join(" / "),
      gateProposal: asChecklist
        ? "format these lines as a checklist"
        : "format these lines as a bulleted list",
    });
  }

  // 5. A short unpunctuated line above a real paragraph reads as a heading.
  if (
    cur.type === "paragraph" &&
    text.length <= H.headingMaxChars &&
    text.split(/\s+/).length <= H.headingMaxWords &&
    !/[.!?,;:]$/.test(text) &&
    listRun.length < H.listMinItems &&
    next &&
    next.type === "paragraph" &&
    next.text.trim().length >= H.headingNextMinChars
  ) {
    candidates.push({
      kind: "reformat",
      label: "Make a heading",
      confidence: 0.6,
      anchorBlockId: cur.id,
      blockIds: [cur.id],
      to: "heading",
      headingLevel: 2,
      nearbyText: text,
      gateProposal: "turn this line into a heading",
    });
  }

  // 6a. An explicit ask ("here's the diagram for X:") — no flow markers needed.
  if (DIAGRAM_NOUNS.test(text) && text.endsWith(":") && !followedBy("canvas")) {
    candidates.push({
      kind: "diagram",
      label: "Add diagram",
      confidence: 0.85,
      anchorBlockId: cur.id,
      blockIds: [],
      nearbyText: text,
      gateProposal: "insert a diagram",
    });
  }

  // 6b. A described process reads better as a diagram.
  if (text.length >= H.diagramMinChars && !followedBy("canvas")) {
    let flow = 0;
    if (/\bthen\b/i.test(text)) flow++;
    if (/→|->/.test(text)) flow++;
    if (/\bflow\b\s*:|\bpipeline\b|\bworkflow\b/i.test(text)) flow++;
    if (/\bfirst\b[\s\S]*\b(next|after|finally)\b/i.test(text)) flow++;
    if (/\bstep\s*\d/i.test(text)) flow++;
    if (
      /\b(submits?|validates?|saves?|sends?|returns?|processes|fetches|receives?)\b/i.test(
        text,
      ) &&
      (text.match(/,/g)?.length ?? 0) >= 2
    ) {
      flow++;
    }
    if (flow >= 2) {
      candidates.push({
        kind: "diagram",
        label: "Add diagram",
        confidence: 0.7,
        anchorBlockId: cur.id,
        blockIds: [],
        nearbyText: text,
        gateProposal: "insert a diagram of this process",
      });
    }
  }

  const best = candidates
    .filter((c) => c.confidence >= H.minConfidence)
    .sort((a, b) => b.confidence - a.confidence)[0];
  return best ?? null;
}
