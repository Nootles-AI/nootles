import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { AI, normalizeLanguage } from "@/app/lib/ai/aiConfig";
import { diagramOutput } from "@/app/lib/ai/actions";
import { generateFim } from "@/app/lib/ai/fim";

/**
 * Tier 2: generate content for a proposal the gate already confirmed.
 *
 * Only two kinds reach a model. `formatCode` / `formatMath` / `reformat` are
 * compiled locally by the client from text that already exists — no call at all.
 *
 *   code    → Codestral FIM writes the body (a code model writing code)
 *   diagram → the strong model, the only expensive branch, and a rare one
 */

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

const DIAGRAM_SYSTEM = [
  "Convert the described process into a small diagram.",
  'Reply with ONLY JSON: {"nodes":[{"tempId","shape","label","x","y"}],"edges":[{"source","target","label"}]}.',
  'shape is one of "rectangle" | "ellipse" | "diamond" | "text"; use "diamond" for decisions.',
  "Lay nodes left-to-right about 220px apart, y=0 for the main path.",
  "edges reference node tempIds. Keep labels under 4 words. No prose, no code fences.",
].join(" ");

/**
 * A CLOSED comment stating the intent. Closed matters: given an unterminated
 * `#`/`//` comment, FIM happily continues the sentence onto the next line, which
 * lands a bare phrase in the middle of the code and breaks it.
 */
function closedComment(language: string, intent: string): string {
  const l = language.toLowerCase();
  if (l === "python") return `"""${intent}"""`;
  if (l === "html" || l === "markdown") return `<!-- ${intent} -->`;
  // Always return something: this is prompt scaffolding that never appears in
  // the output, so comment validity for the target language doesn't matter —
  // but dropping it would leave the model with no intent at all, which makes it
  // hallucinate something unrelated.
  return `/* ${intent} */`;
}

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

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const { kind, language, intent, projection, nearbyText } = (body ?? {}) as {
    kind?: unknown;
    language?: unknown;
    intent?: unknown;
    projection?: unknown;
    nearbyText?: unknown;
  };

  if (kind === "code") {
    const lang = normalizeLanguage(
      typeof language === "string" ? language : undefined,
    );
    // An intent-less prompt makes the model invent something unrelated, so
    // refuse rather than emit garbage.
    const goal = String(intent ?? "").trim();
    if (goal.length < 3) {
      return Response.json({ error: "no intent" }, { status: 400 });
    }
    // Scaffolding only — the fence pins the language (without it Codestral will
    // happily answer a JS request in C), the closed comment states the intent.
    // Neither appears in the returned code; `stop` ends at the closing fence.
    const prefix = `\`\`\`${lang}\n${closedComment(lang, goal)}\n`;
    const gen = await generateFim(prefix, "", {
      maxTokens: AI.fim.contentMaxTokens,
      stop: ["```"],
      signal: req.signal,
    });
    const code = gen.replace(/^\s*\n/, "").trimEnd();
    if (!code) return Response.json({ error: "empty" }, { status: 502 });
    return Response.json({ code, language: lang });
  }

  if (kind === "diagram") {
    try {
      const result = await generateText({
        model: openrouter(AI.planner.model),
        system: DIAGRAM_SYSTEM,
        prompt: [
          "# Document near the cursor",
          String(projection ?? ""),
          "",
          "# Process to diagram",
          String(nearbyText ?? ""),
        ].join("\n"),
        temperature: 0.2,
        maxOutputTokens: AI.planner.maxOutputTokens,
        abortSignal: req.signal,
      });
      const parsed = diagramOutput.safeParse(extractJson(result.text));
      if (!parsed.success) return Response.json({ error: "unusable" }, { status: 502 });
      return Response.json(parsed.data);
    } catch (e) {
      if ((e as Error).name === "AbortError") return new Response(null, { status: 204 });
      console.error("[content] diagram failed:", e);
      return Response.json({ error: "failed" }, { status: 502 });
    }
  }

  return Response.json({ error: "unsupported kind" }, { status: 400 });
}
