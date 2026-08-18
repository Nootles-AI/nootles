import { AI } from "./aiConfig";
import { chatTarget, reportUpstream } from "./providers";

/**
 * Guesses which surface a feedback report is about, from everything the
 * report already carries: the words, the kinds of recent ops, the console
 * tail. A guess only — the form shows it in an editable select, and the
 * operator can re-file it later.
 */

export const FEEDBACK_CATEGORIES = [
  "canvas",
  "code",
  "math",
  "tables",
  "autocomplete",
  "chat",
  "editor",
  "sharing",
  "account",
  "general",
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

const SYSTEM = `You classify a user's feedback report for Nootles, an AI-native
planning tool. Reply with EXACTLY one word from this list and nothing else:

canvas        drawing, diagrams, flowcharts, shapes, connectors, the whiteboard
code          code blocks, syntax highlighting, languages
math          equations, math blocks, calculations, LaTeX
tables        tables, rows, columns, cells
autocomplete  ghost text, inline suggestions, Tab completion, reformat chips
chat          the chat agent, its edits, reviews of its changes
editor        typing, blocks, formatting, copy/paste, anything in the text editor
sharing       share links, read-only views
account       sign-in, sign-up, profile, billing
general       anything else: performance, crashes with no clear surface, praise

You are given the report, the kinds of operations the user recently performed,
and recent console output. The report's own words outweigh the context.`;

export async function categorizeFeedback(
  input: { text: string; ops?: string; consoleTail?: string },
  signal?: AbortSignal,
): Promise<{
  category: FeedbackCategory;
  usage?: { promptTokens?: number; completionTokens?: number };
}> {
  const { url, key, model } = chatTarget(AI.reformat.model);

  const context = [
    `Report: ${input.text.slice(0, 1500)}`,
    input.ops ? `Recent op kinds: ${input.ops.slice(0, 300)}` : "",
    input.consoleTail ? `Console tail:\n${input.consoleTail.slice(-600)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: context },
      ],
    }),
    signal,
  });
  if (!res.ok) {
    await reportUpstream("categorize", res);
    return { category: "general" };
  }

  const json = await res.json();
  const usage = json?.usage
    ? {
        promptTokens: json.usage.prompt_tokens as number | undefined,
        completionTokens: json.usage.completion_tokens as number | undefined,
      }
    : undefined;
  const word = String(json?.choices?.[0]?.message?.content ?? "")
    .trim()
    .toLowerCase()
    .split(/\s/)[0];
  const category = (FEEDBACK_CATEGORIES as readonly string[]).includes(word)
    ? (word as FeedbackCategory)
    : "general";
  return { category, usage };
}
