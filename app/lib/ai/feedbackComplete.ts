import { AI } from "./aiConfig";
import { chatTarget } from "./providers";

/**
 * Finishes the sentence a user is typing into the feedback form, informed by
 * what just happened on their screen: the kinds of recent ops and the console
 * tail travel with the draft. Ghost text only — Tab accepts, anything else
 * discards, and an empty completion is a fine answer.
 */

const SYSTEM = `You finish the sentence a user is typing into the feedback form of
Nootles, an AI-native planning tool. You are given their draft, whether it is a bug
report or a feature request, and context about what they were just doing (recent
operation kinds, recent console output).

Continue THEIR text in THEIR voice — first person, plain words — by at most twelve
words. Use the context to be concrete: name the surface, the action, the error. Reply
with ONLY the continuation, starting exactly where their text ends (begin with a space
if one is needed). No quotes, no rephrasing of what they already wrote. If their text
already reads complete, or you have nothing specific to add, reply with nothing.`;

export async function completeFeedback(
  input: {
    text: string;
    kind: "issue" | "wish";
    ops?: string;
    consoleTail?: string;
  },
  signal?: AbortSignal,
): Promise<{
  completion: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}> {
  const { url, key, model } = chatTarget(AI.reformat.model);

  const context = [
    `Report type: ${input.kind === "issue" ? "bug report" : "feature request"}`,
    input.ops ? `Recent op kinds: ${input.ops.slice(0, 300)}` : "",
    input.consoleTail ? `Console tail:\n${input.consoleTail.slice(-600)}` : "",
    `Draft (continue from its final character):\n${input.text.slice(-1000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 40,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: context },
      ],
    }),
    signal,
  });
  if (!res.ok) return { completion: "" };

  const json = await res.json();
  const usage = json?.usage
    ? {
        promptTokens: json.usage.prompt_tokens as number | undefined,
        completionTokens: json.usage.completion_tokens as number | undefined,
      }
    : undefined;
  let completion = String(json?.choices?.[0]?.message?.content ?? "")
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trimEnd()
    .slice(0, 140);
  if (completion && !/^\s/.test(completion) && !/\s$/.test(input.text)) {
    completion = ` ${completion}`;
  }
  return { completion, usage };
}
