import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { plannerOutput, type PlannerOutput } from "@/app/lib/ai/actions";
import { generateFim } from "@/app/lib/ai/fim";

/**
 * The "action lane" planner. Given the document projection (id-tagged) and the
 * cursor context, the model decides whether ONE structured action is worth
 * suggesting — insert code / math / diagram, or reformat existing text — and
 * returns it (or `kind: "none"`). The client compiles the action into Phase-2
 * ops, validates, and applies on Tab.
 *
 * Runs through OpenRouter so the model is a one-line swap. For an `insertCode`
 * action the model only names the language + intent; the code body is generated
 * here by Codestral FIM (a code model writing the code).
 */

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
const PLANNER_MODEL = "anthropic/claude-sonnet-4.6";

const NONE: PlannerOutput = { label: "", action: { kind: "none" } };

const SYSTEM = [
  "You are a proactive inline assistant inside a rich-text document editor (like",
  "Notion). When the current text clearly maps to one of the actions below,",
  "suggest it so the user can accept with Tab. Use kind \"none\" only when none of",
  "the actions genuinely fit — don't force a suggestion, but don't be shy when",
  "there is an obvious fit.",
  "",
  "Each block is tagged with its stable id as ⟦id⟧; reference existing blocks by",
  "these ids. Set a 2-4 word \"label\", an \"action.kind\", and ONLY the fields for",
  "that kind:",
  "- insertCode: the user is about to write or describe code. Set \"language\" and",
  "  a one-line \"intent\". Do NOT write the code yourself.",
  "- insertMathBlock: multi-line or variable-defining math. Set \"rows\" of LaTeX.",
  "- insertInlineMath: a single inline formula fits. Set \"latex\".",
  "- insertDiagram: the text describes a flow/process/architecture. Set \"nodes\"",
  "  (each tempId, shape, label, x, y) and \"edges\" (source/target tempIds,",
  "  optional label), laid out ~200px apart.",
  "- reformat: existing text reads better as a different block type. Set the",
  "  existing \"blockIds\" and target \"to\" type (+ headingLevel for headings).",
  "- none: nothing fits.",
  "",
  "Examples:",
  '- "Here is a python function that sorts a list:" →',
  '  {"label":"Insert code block","action":{"kind":"insertCode","language":"python","intent":"sort a list of numbers ascending"}}',
  '- "The signup flow: user submits the form, server validates, then saves." →',
  '  {"label":"Add diagram","action":{"kind":"insertDiagram","nodes":[{"tempId":"n1","shape":"rectangle","label":"Submit form","x":0,"y":0},{"tempId":"n2","shape":"diamond","label":"Validate","x":220,"y":0},{"tempId":"n3","shape":"rectangle","label":"Save to DB","x":440,"y":0}],"edges":[{"source":"n1","target":"n2"},{"source":"n2","target":"n3"}]}}',
  '- three short lines ⟦c1⟧ "buy milk" / ⟦c2⟧ "walk the dog" / ⟦c3⟧ "finish report" →',
  '  {"label":"Format as checklist","action":{"kind":"reformat","blockIds":["c1","c2","c3"],"to":"checkListItem"}}',
  "",
  "Suggest at most one action; never duplicate existing content.",
].join("\n");

/** Pull the JSON object out of the model's text (tolerating code fences/prose). */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function codeComment(language: string, intent: string): string {
  const l = language.toLowerCase();
  if (l === "python" || l === "py") return `# ${intent}\n`;
  if (l === "sql") return `-- ${intent}\n`;
  if (l === "html" || l === "xml") return `<!-- ${intent} -->\n`;
  return `// ${intent}\n`;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(NONE);
  }
  const { projection, before, after } = (body ?? {}) as {
    projection?: unknown;
    before?: unknown;
    after?: unknown;
  };
  if (typeof projection !== "string" || !projection.trim()) {
    return Response.json(NONE);
  }

  const prompt = [
    "# Document (each block tagged with its id):",
    projection,
    "",
    "# Cursor context",
    `Text just before the caret: ${JSON.stringify(String(before ?? "").slice(-400))}`,
    `Text just after the caret: ${JSON.stringify(String(after ?? "").slice(0, 200))}`,
  ].join("\n");

  let object: PlannerOutput;
  try {
    const result = await generateText({
      model: openrouter(PLANNER_MODEL),
      system: `${SYSTEM}\n\nRespond with ONLY the JSON object — no prose, no code fences.`,
      prompt,
      temperature: 0.2,
      maxOutputTokens: 1024,
      abortSignal: req.signal,
    });
    const parsed = plannerOutput.safeParse(extractJson(result.text));
    object = parsed.success ? parsed.data : NONE;
  } catch (e) {
    if ((e as Error).name === "AbortError") return new Response(null, { status: 204 });
    console.error("[plan] planner failed:", e);
    return Response.json(NONE);
  }

  if (object.action.kind === "insertCode" && !object.action.code) {
    const comment = codeComment(
      object.action.language ?? "",
      object.action.intent ?? "",
    );
    const gen = await generateFim(comment, "", { maxTokens: 256, stop: ["```"] });
    object.action.code = (comment + gen).trimEnd();
  }

  return Response.json(object);
}
