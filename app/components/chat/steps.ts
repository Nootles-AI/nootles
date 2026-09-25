import {
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
} from "ai";
import type { AbMessage } from "@/app/lib/ai/chat/types";

/**
 * What the agent did, in words, and how a turn divides into the work and the
 * answer. Pure: the transcript draws it, and a test can read it.
 */

export type Part = AbMessage["parts"][number];
export type ToolPart = ToolUIPart | DynamicToolUIPart;

/**
 * The kinds of work a step is, each with its own glyph on the rail. Named for
 * what the reader sees happen, not for the tool behind it: five tools read,
 * and they all read the same way to someone watching.
 */
export type Family =
  | "search"
  | "web"
  | "read"
  | "graph"
  | "write"
  | "place"
  | "page"
  | "comment"
  | "draw"
  | "canvas"
  | "media"
  | "look"
  | "map"
  | "tool";

const FAMILY: Record<string, Family> = {
  search_context: "search",
  search_web: "web",
  read_context: "read",
  read_page: "read",
  read_open_page: "read",
  expand_context: "graph",
  write: "write",
  edit_page: "place",
  album_edit: "media",
  list_pages: "page",
  open_page: "page",
  create_page: "page",
  rename_page: "page",
  delete_page: "page",
  read_comments: "comment",
  create_comment: "comment",
  reply_comment: "comment",
  resolve_comment: "comment",
  draw: "draw",
  find_songs: "media",
  find_images: "media",
  find_places: "map",
  look_at: "look",
};

export function familyOf(tool: string): Family {
  return FAMILY[tool] ?? (CANVAS.has(tool) ? "canvas" : "tool");
}

const CANVAS = new Set([
  "get_geometry",
  "get_styles",
  "get_html",
  "write_nodes",
  "update_styles",
  "set_text",
  "rename",
  "duplicate",
  "move",
  "delete",
  "reorder",
  "group",
  "ungroup",
]);

/** Present tense while the tool runs, and what to say when it fails. */
const STEPS: Record<string, { doing: string; failed: string; done?: string }> = {
  list_pages: { doing: "Listing pages…", failed: "Couldn't list the pages" },
  read_page: { doing: "Reading…", failed: "Couldn't read that page" },
  open_page: { doing: "Opening…", failed: "Couldn't open that page" },
  read_open_page: { doing: "Reading…", failed: "Couldn't read the open page" },
  edit_page: { doing: "Writing…", failed: "Couldn't edit that page" },
  draw: { doing: "Drawing…", failed: "Couldn't draw that" },
  search_web: { doing: "Searching the web…", failed: "Couldn't search the web" },
  create_page: { doing: "Adding a page…", failed: "Couldn't add the page" },
  rename_page: { doing: "Retitling…", failed: "Couldn't retitle that page" },
  delete_page: { doing: "Deleting…", failed: "Couldn't delete that page" },
  search_context: { doing: "Searching the project…", failed: "Couldn't search the project" },
  read_context: { doing: "Reading…", failed: "Couldn't read that" },
  expand_context: { doing: "Following links…", failed: "Couldn't follow that" },
  write: { doing: "Drafting a section…", failed: "Couldn't draft that section" },
  album_edit: { doing: "Arranging the album…", failed: "Couldn't change the album", done: "Arranged the album" },
  find_songs: { doing: "Finding songs…", failed: "Couldn't find songs", done: "Found songs" },
  find_images: { doing: "Finding pictures…", failed: "Couldn't find pictures", done: "Found pictures" },
  find_places: { doing: "Finding places…", failed: "Couldn't find places", done: "Found places" },
  look_at: { doing: "Looking closely…", failed: "Couldn't look at those", done: "Looked closely" },
  read_comments: { doing: "Reading comments…", failed: "Couldn't read the comments", done: "Read the comments" },
  create_comment: { doing: "Commenting…", failed: "Couldn't add the comment", done: "Left a comment" },
  reply_comment: { doing: "Replying…", failed: "Couldn't reply", done: "Replied in a thread" },
  resolve_comment: { doing: "Resolving…", failed: "Couldn't resolve that thread", done: "Resolved a thread" },
  get_geometry: { doing: "Measuring the diagram…", failed: "Couldn't measure the diagram", done: "Measured the diagram" },
  get_styles: { doing: "Reading the styles…", failed: "Couldn't read the styles", done: "Read the diagram's styles" },
  get_html: { doing: "Exporting…", failed: "Couldn't export the diagram", done: "Exported the diagram" },
  write_nodes: { doing: "Drawing shapes…", failed: "Couldn't change those shapes", done: "Changed shapes" },
  update_styles: { doing: "Restyling…", failed: "Couldn't restyle those shapes", done: "Restyled shapes" },
  set_text: { doing: "Relabelling…", failed: "Couldn't relabel that", done: "Relabelled a shape" },
  rename: { doing: "Renaming…", failed: "Couldn't rename that", done: "Renamed a shape" },
  duplicate: { doing: "Duplicating…", failed: "Couldn't duplicate that", done: "Duplicated a shape" },
  move: { doing: "Moving…", failed: "Couldn't move that", done: "Moved shapes" },
  delete: { doing: "Deleting shapes…", failed: "Couldn't delete that", done: "Deleted shapes" },
  reorder: { doing: "Reordering…", failed: "Couldn't reorder that", done: "Reordered shapes" },
  group: { doing: "Grouping…", failed: "Couldn't group those", done: "Grouped shapes" },
  ungroup: { doing: "Ungrouping…", failed: "Couldn't ungroup that", done: "Ungrouped shapes" },
};

/**
 * States in which a step is still going, and its line therefore ends in "…".
 *
 * Named rather than derived from "not finished": `approval-requested` is a
 * question waiting on the user, which is not the agent working, and a spinner
 * against it would say the opposite of what is true.
 */
const RUNNING: ReadonlySet<string> = new Set([
  "input-streaming",
  "input-available",
  "approval-responded",
]);

/** Whether this part is a tool call that has not finished yet. */
export function isRunning(part: Part): boolean {
  // An approval that was refused is settled, whatever its state still reads as.
  return (
    isToolUIPart(part) && RUNNING.has(part.state) && part.approval?.approved !== false
  );
}

export function isFailed(part: ToolPart): boolean {
  return part.state === "output-error";
}

/** How many writer sections an edit places — "Placed 4 sections" says more than "Edited". */
function sectionsIn(part: ToolPart): number {
  const html = (part.input as { html?: string } | undefined)?.html;
  return typeof html === "string" ? (html.match(/<nt-section\b/g) ?? []).length : 0;
}

/** One quiet line per call: what it did, never the arguments it did it with. */
export function stepLine(part: ToolPart): string {
  const name = getToolName(part);
  const step = STEPS[name];
  const query = (part.input as { query?: string } | undefined)?.query;

  if (part.state === "output-error") return step?.failed ?? `Couldn't finish ${name}`;
  // A refusal has to read off the click. `output-denied` is the server agreeing,
  // and it is a whole request away — long enough for "Deleting…" to sit under a
  // button the user pressed to stop exactly that, and forever if that request
  // never lands.
  if (part.state === "output-denied" || part.approval?.approved === false) {
    return "Left it alone";
  }
  if (part.state !== "output-available") {
    if (query) return `Searching for “${query}”…`;
    // The brief is the one argument worth quoting: six parallel draw calls as
    // six bare "draw…" lines read as a stutter, where six briefs read as a
    // shot list assembling itself.
    const brief = (part.input as { brief?: string } | undefined)?.brief;
    if (name === "draw" && brief) return `Drawing ${clause(brief)}…`;
    const placing = name === "edit_page" ? sectionsIn(part) : 0;
    if (placing) return `Placing ${placing} section${placing === 1 ? "" : "s"}…`;
    return step?.doing ?? "Working…";
  }

  switch (name) {
    case "list_pages": {
      const n = Array.isArray(part.output) ? part.output.length : 0;
      return `Listed ${n} page${n === 1 ? "" : "s"}`;
    }
    case "read_page":
    case "read_open_page": {
      const title = pageTitle(part.output) ?? "an untitled page";
      // A long page reads in parts; the later ones say so.
      return (part.input as { after?: string } | undefined)?.after
        ? `Read on through ${title}`
        : `Read ${title}`;
    }
    case "edit_page": {
      // The tool opens a successful answer with "Done:", whatever the page is
      // called — judging by title alone read every edit of an UNTITLED page as
      // "left it as it was", straight-faced, under six drawings it had placed.
      const done =
        typeof part.output === "string" && part.output.startsWith("Done:");
      if (!done) return "Left the page as it was";
      const placed = sectionsIn(part);
      if (placed) return `Placed ${placed} section${placed === 1 ? "" : "s"}`;
      return `Edited ${pageTitle(part.output) ?? "the page"}`;
    }
    case "open_page": {
      const title = (part.output as { title?: string } | undefined)?.title;
      return `Opened ${title?.trim() || "an untitled page"}`;
    }
    case "draw": {
      const brief = (part.input as { brief?: string } | undefined)?.brief;
      // The tool answers {error} when nothing worth drawing came back — an
      // ordinary result to the protocol, a miss to the reader.
      if ((part.output as { error?: string } | undefined)?.error) {
        return "Nothing came of that drawing";
      }
      return brief ? `Drew ${clause(brief)}` : "Drew a canvas";
    }
    case "search_web":
      return query ? `Searched the web for “${query}”` : "Searched the web";
    case "search_context": {
      const n = Array.isArray(part.output) ? part.output.length : 0;
      const found = n ? `${n} match${n === 1 ? "" : "es"}` : "nothing";
      return query ? `Found ${found} for “${query}”` : `Found ${found}`;
    }
    case "write": {
      const out = part.output as
        | { error?: string; headings?: string[]; unsourced?: string[] }
        | undefined;
      if (out?.error) return "The writer missed that section";
      const heading = out?.headings?.[0];
      const drafted = heading ? `Drafted “${heading}”` : "Drafted a section";
      const flagged = out?.unsourced?.length ?? 0;
      return flagged ? `${drafted} — ${flagged} to check` : drafted;
    }
    case "read_context":
      return `Read ${contextTitle(part.output)}`;
    case "expand_context": {
      const links = (part.output as { links?: unknown[] } | undefined)?.links?.length ?? 0;
      const title = contextTitle(part.output);
      return links ? `Followed ${title} · ${links} link${links === 1 ? "" : "s"}` : `Followed ${title}`;
    }
    case "create_page":
      return `Added ${named(part.output)}`;
    case "rename_page": {
      const title = (part.output as { title?: string }).title?.trim();
      return title ? `Retitled to “${title}”` : "Cleared a page's title";
    }
    case "delete_page":
      return `Deleted ${named(part.output)}`;
    default:
      return step?.done ?? "Done";
  }
}

/** A draw salvo as one line: a count while it runs, a tally when it settles. */
export function drawsLine(draws: ToolPart[]): string {
  const n = draws.length;
  // Refused at the picker — read off the click, like a lone call's stepLine,
  // so the line does not sit on "Drawing…" while the denial makes its round
  // trip to the server.
  const denied = draws.filter(
    (p) => p.state === "output-denied" || p.approval?.approved === false,
  ).length;
  if (denied === n) return "Left the drawings undrawn";
  const drawn = draws.filter(
    (p) =>
      p.state === "output-available" &&
      !(p.output as { error?: string } | undefined)?.error,
  ).length;
  const settled =
    draws.filter(
      (p) => p.state === "output-available" || p.state === "output-error",
    ).length + denied;
  // A shot is a draw that named a board ratio; anything else is a drawing.
  const what = draws.every((p) => (p.input as { ratio?: string } | undefined)?.ratio)
    ? "shot"
    : "drawing";
  if (settled < n) return `Drawing ${n} ${what}s — ${drawn} done…`;
  if (drawn === n) return `Drew ${n} ${what}s`;
  return `Drew ${drawn} of ${n} ${what}s`;
}

/**
 * Several calls to one tool in one step, as one line: the work at a glance,
 * with each call's own line a click away. Five parallel searches are one act
 * of looking, and read that way.
 */
export function groupLine(tool: string, parts: ToolPart[]): string {
  if (parts.length === 1) return stepLine(parts[0]);
  if (tool === "draw") return drawsLine(parts);
  const n = parts.length;
  const running = parts.some(isRunning);
  const done = parts.filter((p) => p.state === "output-available").length;
  const failed = parts.filter(isFailed).length;
  const line = ((): string => {
    switch (tool) {
      case "search_context":
        return running ? `Searching the project · ${n}` : `Searched the project · ${n}`;
      case "search_web":
        return running ? `Searching the web · ${n}` : `Searched the web · ${n}`;
      case "read_context":
        return running ? `Reading ${n} sources — ${done} done` : `Read ${n} sources`;
      case "read_page":
      case "read_open_page":
        return running ? `Reading ${n} pages` : `Read ${n} pages`;
      case "expand_context":
        return running ? `Following ${n} threads` : `Followed ${n} threads`;
      case "write":
        return running ? `Drafting ${n} sections — ${done} done` : `Drafted ${n} sections`;
      case "edit_page":
        return running ? `Making ${n} edits` : `Made ${n} edits`;
      default:
        return `${stepLine(parts[0]).replace(/…$/, "")} · ${n}`;
    }
  })();
  return failed ? `${line} · ${failed} failed` : running ? `${line}…` : line;
}

/** What a turn holds, in reading order: the work, then the answer. */
export type TraceItem =
  | { kind: "note"; key: string; text: string }
  | { kind: "step"; key: string; tool: string; family: Family; parts: ToolPart[] };

/**
 * A turn divided into the work and the answer.
 *
 * The answer is what the agent said after its last call; anything it said
 * before one was narration on the way, and joins the notes. Calls to one tool
 * within one step are one item — a parallel batch is one act. Draws gather
 * across steps too: a retried shot is a new step, and splitting the salvo
 * there would bring the stutter back as two smaller ones. A call waiting on
 * the user's approval is not shown as work under way: the card below asks it.
 */
export function planTurn(parts: readonly Part[]): {
  trace: TraceItem[];
  answer: { key: string; text: string }[];
} {
  const lastTool = parts.reduce((at, part, i) => (isToolUIPart(part) ? i : at), -1);
  const trace: TraceItem[] = [];
  const answer: { key: string; text: string }[] = [];
  let step = 0;
  let open: { item: Extract<TraceItem, { kind: "step" }>; step: number } | null = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const key = String(i);
    if (part.type === "step-start") {
      step++;
    } else if (part.type === "reasoning" || part.type === "text") {
      // Reasoning with no words is thinking kept hidden — not a line.
      if (!part.text.trim()) continue;
      if (part.type === "text" && i > lastTool) {
        answer.push({ key, text: part.text });
      } else {
        trace.push({ kind: "note", key, text: part.text });
        open = null;
      }
    } else if (isToolUIPart(part) && part.state !== "approval-requested") {
      const tool = getToolName(part);
      if (open && open.item.tool === tool && (open.step === step || tool === "draw")) {
        open.item.parts.push(part);
        open.step = step;
      } else {
        const item: Extract<TraceItem, { kind: "step" }> = {
          kind: "step",
          key,
          tool,
          family: familyOf(tool),
          parts: [part],
        };
        trace.push(item);
        open = { item, step };
      }
    }
  }
  return { trace, answer };
}

/** The work folded to one line: how much, and the two things most worth knowing. */
export function summaryLine(trace: readonly TraceItem[]): string {
  const calls = trace.flatMap((item) => (item.kind === "step" ? item.parts : []));
  const count = (tools: string[]) =>
    calls.filter((p) => tools.includes(getToolName(p)) && p.state === "output-available").length;
  const edits = calls.filter((p) => getToolName(p) === "edit_page" && p.state === "output-available");
  const placed = edits.reduce((n, p) => n + sectionsIn(p), 0);
  const highlights = [
    [count(["write"]), "drafted", "section"],
    [placed, "placed", "section"],
    [count(["read_context"]), "read", "source"],
    [edits.filter((p) => !sectionsIn(p)).length, "made", "edit"],
    [count(["read_page", "read_open_page"]), "read", "page"],
    [count(["search_context", "search_web"]), "ran", "search"],
    [count(["expand_context"]), "followed", "thread"],
  ] as const;
  const said = highlights
    .filter(([n]) => n > 0)
    .slice(0, 2)
    .map(([n, verb, noun]) => `${verb} ${n} ${noun}${n === 1 ? "" : noun === "search" ? "es" : "s"}`);
  const failed = calls.filter(isFailed).length;
  const steps = `${calls.length} step${calls.length === 1 ? "" : "s"}`;
  return [steps, ...said, ...(failed ? [`${failed} failed`] : [])].join(" · ");
}

/**
 * A brief's opening clause, quoted — enough to tell six draw lines apart
 * without the transcript becoming the prompt. Cut at a word, never mid-one.
 */
function clause(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 48) return `“${flat}”`;
  return `“${flat.slice(0, 48).replace(/\s+\S*$/, "")}…”`;
}

/** The page tools answer with HTML, and a page with a title says so in one. */
function pageTitle(output: unknown): string | null {
  const title =
    typeof output === "string" ? /<title>([^<]*)<\/title>/.exec(output)?.[1] : null;
  return title?.trim() || null;
}

/** A context item by its title — a file's is its path. */
function contextTitle(output: unknown): string {
  const title = (output as { title?: string } | undefined)?.title?.trim();
  return title || "an untitled item";
}

/** The page tools answer with the title they left behind. */
function named(output: unknown): string {
  const title = (output as { title?: string } | undefined)?.title?.trim();
  return title ? `“${title}”` : "an untitled page";
}
