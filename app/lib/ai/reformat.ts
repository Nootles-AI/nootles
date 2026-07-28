import { AI } from "./aiConfig";

/**
 * Reformat candidates for one finished block.
 *
 * Unlike inline completion this is a transformation, not a continuation, so
 * fill-in-the-middle is the wrong tool — Codestral cannot follow an instruction
 * like this. It is a few-shot instruct call instead.
 *
 * The model never writes new content. Every shape it offers is a rearrangement
 * of what is already in the block, which is what makes an ambient suggestion
 * here defensible where an ambient *continuation* was not.
 */

export type ReformatCandidate = { label: string; html: string };

const SYSTEM = `You reformat a RUN OF BLOCKS into other shapes it could take.

You are given one or more consecutive blocks. Pressing Enter starts a new
block, so something the writer thinks of as one thing — a code snippet, a
table, a list — usually arrives as several paragraphs in a row. Folding them
back into a single block is the most valuable thing you do here.

The document is HTML with a few custom elements:
  <ab-code-block lang="python">code</ab-code-block>
  <ab-math-block><ab-math-line>a = 1</ab-math-line></ab-math-block>
  <ab-diagram><ab-node shape="rectangle">Step</ab-node><ab-edge from="n1" to="n2"></ab-edge></ab-diagram>
  <ab-math>x^2</ab-math>            inline maths
  <code>maxRetries</code>           inline code
  <table><tr><th>A</th></tr><tr><td>b</td></tr></table>
  <ul><li><input type="checkbox">todo</li></ul>   checklist
  <ul><li>item</li></ul>            bullet list

Code blocks must name their language:
  plaintext typescript tsx javascript jsx python java json html css markdown sql rust
Pick the one the code is actually written in; use plaintext if it is not one of these.

Rules:
- Copy the FIRST input block's id onto the FIRST element you output.
- When you fold several blocks into one, output just the one block. The others
  are removed for you.
- Only offer shapes the content genuinely already fits. Usually 0-2, never more than 3.
- Never invent facts, never add content. Only rearrange what is written.
- If nothing fits, return [].
- Reply with JSON only: [{"label":"Checklist","html":"..."}]`;

/**
 * Examples carry the grammar. Measured on the completion lane: shown an example
 * the model adopts our elements exactly, shown none it invents its own. The
 * last shot is the important one — it teaches the model to decline.
 */
const SHOTS: Array<{ in: string; out: string }> = [
  {
    in: `<p id="a">Buy milk, call the bank, book the flight</p>`,
    out: `[{"label":"Checklist","html":"<ul><li id=\\"a\\"><input type=\\"checkbox\\">Buy milk</li><li><input type=\\"checkbox\\">Call the bank</li><li><input type=\\"checkbox\\">Book the flight</li></ul>"}]`,
  },
  {
    in: `<p id="b">Sam owns ingest, Priya owns search, Dev owns the UI</p>`,
    out: `[{"label":"Table","html":"<table id=\\"b\\"><tr><th>Owner</th><th>Area</th></tr><tr><td>Sam</td><td>ingest</td></tr><tr><td>Priya</td><td>search</td></tr><tr><td>Dev</td><td>the UI</td></tr></table>"},{"label":"Bullet list","html":"<ul><li id=\\"b\\">Sam owns ingest</li><li>Priya owns search</li><li>Dev owns the UI</li></ul>"}]`,
  },
  {
    in: `<p id="e">def greet(name):</p>\n<p id="f">    print(f"hi {name}")</p>\n<p id="g">greet("Sam")</p>`,
    out: `[{"label":"Code block","html":"<ab-code-block id=\\"e\\" lang=\\"python\\">def greet(name):\\n    print(f\\"hi {name}\\")\\ngreet(\\"Sam\\")</ab-code-block>"}]`,
  },
  {
    in: `<p id="h">Region North revenue 4.2m</p>\n<p id="i">Region South revenue 3.1m</p>`,
    out: `[{"label":"Table","html":"<table id=\\"h\\"><tr><th>Region</th><th>Revenue</th></tr><tr><td>North</td><td>4.2m</td></tr><tr><td>South</td><td>3.1m</td></tr></table>"}]`,
  },
  {
    in: `<p id="c">Set the maxRetries option before calling connect()</p>`,
    out: `[{"label":"Inline code","html":"<p id=\\"c\\">Set the <code>maxRetries</code> option before calling <code>connect()</code></p>"}]`,
  },
  {
    in: `<p id="d">The weather today is quite pleasant</p>`,
    out: `[]`,
  },
];

export async function reformatCandidates(
  block: string,
  signal?: AbortSignal,
): Promise<ReformatCandidate[]> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AI.reformat.model,
      max_tokens: AI.reformat.maxTokens,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM },
        ...SHOTS.flatMap((s) => [
          { role: "user", content: s.in },
          { role: "assistant", content: s.out },
        ]),
        { role: "user", content: block },
      ],
    }),
    signal,
  });
  if (!res.ok) return [];

  const json = await res.json();
  const text = String(json?.choices?.[0]?.message?.content ?? "")
    .trim()
    // Models fence JSON out of habit however firmly you ask them not to.
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c): c is ReformatCandidate =>
          !!c && typeof c.label === "string" && typeof c.html === "string",
      )
      .slice(0, AI.reformat.maxCandidates);
  } catch {
    return [];
  }
}
