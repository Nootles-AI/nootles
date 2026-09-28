import type { NamingOutline } from "@/convex/github/naming";
import { AI } from "../aiConfig";
import { chatTarget, postChat, readUsage, reportUpstream } from "../providers";

/**
 * Names a repository's areas and concerns from what they hold — stage 2 of the
 * context graph. The clustering found the groups; this says what each is for,
 * in the words a person on the team would use.
 */

export type Named = { nodeId: string; title: string; brief: string };

const SYSTEM = `You name the parts of a software repository for a planning tool's
map of it. The parts were found by clustering files that import each other and
change together, so each group is one real area of the product or codebase.

For every area and concern you are given, write:
- title: 1 to 4 words, what it IS or DOES for the product ("Checkout flow",
  "Canvas rendering", "Auth and sessions"). No file extensions, no "module",
  no "misc". Use sentence case: capitalize the first word and preserve proper names.
- brief: one plain sentence (at most 20 words) saying what it does.

A concern marked styling is the codebase's styling and component library: keep
its title "Styling and components" and write only its brief.

Answer with JSON only: {"names":[{"id":"...","title":"...","brief":"..."}]},
one entry per id you were given, and nothing else.`;

type Chunk = NamingOutline["areas"];
type Call = {
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  failure?: string;
};
type Work = { areas: Chunk; root: number; depth: number; order: number };
const PROMPT_CHARS = 50_000;
const PARALLEL = 3;
const EXTRA_CALLS_PER_CHUNK = 8;

export async function nameRepository(
  outline: NamingOutline,
  signal?: AbortSignal,
): Promise<{
  names: Named[];
  calls: Call[];
}> {
  const initial = chunks(outline);
  const queue: Work[] = initial.map((areas, root) => ({
    areas,
    root,
    depth: 0,
    order: root,
  }));
  const extra = initial.map(() => 0);
  const results: { names: Named[]; call: Call }[] = [];
  let next = 0;

  async function worker() {
    while (next < queue.length) {
      const job = queue[next++];
      const result = await nameChunk(outline, job.areas, signal);
      results[job.order] = result;
      if (!result.truncated || job.depth >= 4) continue;
      const missing = missingPieces(
        job.areas,
        new Set(result.names.map((n) => n.nodeId)),
      );
      if (!missing.length || (missing.length === 1 && job.depth > 0)) continue;
      const middle = Math.ceil(missing.length / 2);
      const halves =
        missing.length === 1
          ? [missing]
          : [missing.slice(0, middle), missing.slice(middle)];
      for (const half of halves) {
        if (extra[job.root] >= EXTRA_CALLS_PER_CHUNK) break;
        queue.push({
          areas: pack(half),
          root: job.root,
          depth: job.depth + 1,
          order: queue.length,
        });
        extra[job.root]++;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, () => worker()),
  );
  const names = new Map<string, Named>();
  for (const result of results) {
    for (const name of result.names)
      if (!names.has(name.nodeId)) names.set(name.nodeId, name);
  }
  return {
    names: [...names.values()],
    calls: results.map((result) => result.call),
  };
}

/** A large area can cross calls; each copy carries only the concerns in that call. */
function pieces(areas: Chunk): Chunk {
  return areas.flatMap((area) =>
    area.concerns.length
      ? area.concerns.map((concern) => ({ ...area, concerns: [concern] }))
      : [{ ...area, concerns: [] }],
  );
}

function pack(parts: Chunk): Chunk {
  const grouped: Chunk = [];
  for (const part of parts) {
    const last = grouped[grouped.length - 1];
    if (last?.nodeId === part.nodeId) last.concerns.push(...part.concerns);
    else grouped.push({ ...part, concerns: [...part.concerns] });
  }
  return grouped;
}

function chunks(outline: NamingOutline): Chunk[] {
  const out: Chunk[] = [];
  let current: Chunk = [];
  for (const piece of pieces(outline.areas)) {
    const candidate = pack([...current, piece]);
    const count = candidate.reduce(
      (sum, area) => sum + area.concerns.length,
      0,
    );
    if (
      current.length &&
      (count > AI.context.concernsPerCall ||
        prompt(outline, candidate).length > PROMPT_CHARS)
    ) {
      out.push(current);
      current = [];
    }
    current = pack([...current, piece]);
  }
  if (current.length) out.push(current);
  return out;
}

function missingPieces(areas: Chunk, present: Set<string>): Chunk {
  return areas.flatMap((area) => {
    const missing = area.concerns.filter(
      (concern) => !present.has(concern.nodeId),
    );
    return missing.length
      ? missing.map((concern) => ({ ...area, concerns: [concern] }))
      : present.has(area.nodeId)
        ? []
        : [{ ...area, concerns: [] }];
  });
}

function short(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function prompt(outline: NamingOutline, areas: Chunk): string {
  const lines = [
    `Repository: ${short(outline.fullName, 300)}${outline.description ? ` — ${short(outline.description, 1000)}` : ""}`,
    "",
  ];
  for (const area of areas) {
    lines.push(`AREA id=${area.nodeId} (currently "${short(area.name, 120)}")`);
    for (const c of area.concerns) {
      lines.push(
        `  CONCERN id=${c.nodeId}${c.styling ? " styling" : ""} (currently "${short(c.name, 120)}")`,
      );
      for (const f of c.files)
        lines.push(
          `    ${short(f.path, 240)}${f.brief ? ` — ${short(f.brief, 160)}` : ""}`,
        );
      if (c.more) lines.push(`    …and ${c.more} more files`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function nameChunk(
  outline: NamingOutline,
  areas: Chunk,
  signal?: AbortSignal,
) {
  const started = Date.now();
  const ids = new Set<string>();
  for (const area of areas) {
    ids.add(area.nodeId);
    for (const c of area.concerns) ids.add(c.nodeId);
  }

  try {
    const res = await postChat(
      chatTarget(AI.context.nameModel, AI.context.answerTokens),
      {
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt(outline, areas) },
        ],
      },
      signal,
    );
    if (!res.ok) {
      await reportUpstream("context-name", res);
      return {
        names: [],
        call: {
          latencyMs: Date.now() - started,
          failure: `upstream-${res.status}`,
        },
        truncated: false,
      };
    }
    const json = await res.json();
    const usage = readUsage(json?.usage);
    const choice = json?.choices?.[0];
    const text = String(choice?.message?.content ?? "");
    const parsed = parse(text).filter((n) => ids.has(n.nodeId));
    const named = new Set(parsed.map((n) => n.nodeId));
    const truncated = choice?.finish_reason === "length";
    return {
      names: parsed,
      call: {
        ...usage,
        latencyMs: Date.now() - started,
        ...(truncated
          ? { failure: "truncated" }
          : !parsed.length
            ? { failure: "unparsed" }
            : named.size < ids.size
              ? { failure: "incomplete" }
              : {}),
      },
      truncated,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      names: [],
      call: { latencyMs: Date.now() - started, failure: "request" },
      truncated: false,
    };
  }
}

function rows(value: unknown): Named[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((n) => {
    if (!n || typeof n !== "object") return [];
    const row = n as { id?: unknown; title?: unknown; brief?: unknown };
    return typeof row.id === "string" && typeof row.title === "string"
      ? [
          {
            nodeId: row.id,
            title: row.title,
            brief: typeof row.brief === "string" ? row.brief : "",
          },
        ]
      : [];
  });
}

/** Keep complete entries even if the response ends inside a later JSON object. */
export function parse(text: string): Named[] {
  const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const value = JSON.parse(body) as { names?: unknown };
    return rows(value.names);
  } catch {
    const start = /"names"\s*:\s*\[/.exec(text);
    if (!start) return [];
    const complete: unknown[] = [];
    let depth = 0;
    let begin = -1;
    let quoted = false;
    let escaped = false;
    for (let i = start.index + start[0].length; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") {
        if (depth++ === 0) begin = i;
      } else if (char === "}" && depth && --depth === 0) {
        try {
          complete.push(JSON.parse(text.slice(begin, i + 1)));
        } catch {
          /* Keep later complete rows. */
        }
      } else if (char === "]" && depth === 0) break;
    }
    return rows(complete);
  }
}
