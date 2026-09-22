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
  no "misc". Title case for the first word only.
- brief: one plain sentence (at most 20 words) saying what it does.

A concern marked styling is the codebase's styling and component library: keep
its title "Styling and components" and write only its brief.

Answer with JSON only: {"names":[{"id":"...","title":"...","brief":"..."}]},
one entry per id you were given, and nothing else.`;

type Chunk = NamingOutline["areas"];

export async function nameRepository(
  outline: NamingOutline,
  signal?: AbortSignal,
): Promise<{
  names: Named[];
  calls: { promptTokens?: number; completionTokens?: number; failure?: string }[];
}> {
  const names: Named[] = [];
  const calls: { promptTokens?: number; completionTokens?: number; failure?: string }[] = [];
  for (const chunk of chunks(outline.areas)) {
    const result = await nameChunk(outline, chunk, signal);
    calls.push(result.call);
    names.push(...result.names);
  }
  return { names, calls };
}

/** Areas grouped so no call carries more concerns than one answer holds. */
function chunks(areas: Chunk): Chunk[] {
  const out: Chunk[] = [];
  let current: Chunk = [];
  let count = 0;
  for (const area of areas) {
    if (count && count + area.concerns.length > AI.context.concernsPerCall) {
      out.push(current);
      current = [];
      count = 0;
    }
    current.push(area);
    count += area.concerns.length;
  }
  if (current.length) out.push(current);
  return out;
}

async function nameChunk(outline: NamingOutline, areas: Chunk, signal?: AbortSignal) {
  const lines = [
    `Repository: ${outline.fullName}${outline.description ? ` — ${outline.description}` : ""}`,
    "",
  ];
  const ids = new Set<string>();
  for (const area of areas) {
    ids.add(area.nodeId);
    lines.push(`AREA id=${area.nodeId} (currently "${area.name}")`);
    for (const c of area.concerns) {
      ids.add(c.nodeId);
      lines.push(`  CONCERN id=${c.nodeId}${c.styling ? " styling" : ""} (currently "${c.name}")`);
      for (const f of c.files) lines.push(`    ${f.path}${f.brief ? ` — ${f.brief}` : ""}`);
      if (c.more) lines.push(`    …and ${c.more} more files`);
    }
    lines.push("");
  }

  const res = await postChat(
    chatTarget(AI.context.nameModel, AI.context.answerTokens),
    {
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: lines.join("\n").slice(0, 60_000) },
      ],
    },
    signal,
  );
  if (!res.ok) {
    await reportUpstream("context-name", res);
    return { names: [], call: { failure: `upstream-${res.status}` } };
  }
  const json = await res.json();
  const usage = readUsage(json?.usage);
  const text = String(json?.choices?.[0]?.message?.content ?? "");
  const parsed = parse(text).filter((n) => ids.has(n.nodeId));
  return {
    names: parsed,
    call: { ...usage, ...(parsed.length ? {} : { failure: "unparsed" }) },
  };
}

/** The answer's names, tolerating a fenced block around the JSON. */
export function parse(text: string): Named[] {
  const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const value = JSON.parse(body) as { names?: unknown };
    if (!Array.isArray(value.names)) return [];
    return value.names.flatMap((n) => {
      const row = n as { id?: unknown; title?: unknown; brief?: unknown };
      return typeof row.id === "string" && typeof row.title === "string"
        ? [{ nodeId: row.id, title: row.title, brief: typeof row.brief === "string" ? row.brief : "" }]
        : [];
    });
  } catch {
    return [];
  }
}
