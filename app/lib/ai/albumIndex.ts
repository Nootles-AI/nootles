import { AI } from "./aiConfig";
import { chatTarget, postChat, readUsage } from "./providers";

/**
 * One look at a contact sheet, and an album is indexed.
 *
 * The tiles arrive as a single image with each picture's handle stamped on it
 * (see `album/sheet.ts`), and the model answers with one line per handle. That
 * is the entire reason this lane is affordable: the alternative — a request
 * carrying two dozen separate images — costs roughly two dozen times as much
 * for an answer that is no better, and loses the ability to say which picture
 * is which unless every image is labelled some other way anyway.
 *
 * What comes back is deliberately two things and not three. `alt` is what the
 * picture IS, in a sentence, and does double duty as the accessible description
 * the album has never had. `striking` is how much the picture carries a wall
 * from across the room — the model's read, where `stats.energy` is the free
 * measurement, and the two disagreeing usefully is the point of asking.
 */

export type Described = { handle: string; alt: string; striking: number };

const SYSTEM = `You are looking at a contact sheet: a grid of photographs, each
with a short handle stamped in black at its top-left corner.

Answer with one line per photograph, in this exact format and nothing else:

handle | striking | what the photograph is

- handle: copied EXACTLY as stamped. Never invent one, never renumber.
- striking: 0-99. How much the picture holds a wall from across the room —
  strong subject, strong light, strong composition. A flat record shot of a
  document is 5; a sharply lit portrait or a dramatic landscape is 90. Judge
  the photograph, not the subject's importance.
- what it is: ONE clause, under ${AI.album.maxAltChars} characters. Say the
  subject, the setting and the light, the way you would describe it to someone
  choosing pictures for a moodboard. No preamble, no "an image of".

One line per handle on the sheet. No headers, no blank lines, no commentary.`;

export async function describeSheet(
  sheet: { dataUri: string; handles: string[] },
  signal?: AbortSignal,
): Promise<{
  described: Described[];
  usage?: { promptTokens?: number; completionTokens?: number };
}> {
  const target = chatTarget(AI.album.model, AI.album.answerTokens);
  const known = new Set(sheet.handles);

  const res = await postChat(
    target,
    {
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `The handles on this sheet are: ${sheet.handles.join(", ")}.`,
            },
            { type: "image_url", image_url: { url: sheet.dataUri } },
          ],
        },
      ],
    },
    signal,
  );
  if (!res.ok) throw new Error(`album index failed: ${res.status}`);

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: unknown;
  };
  const text = json.choices?.[0]?.message?.content ?? "";

  const seen = new Set<string>();
  const described: Described[] = [];
  for (const line of text.split("\n")) {
    const parts = line.split("|");
    if (parts.length < 3) continue;
    const handle = parts[0].trim();
    // Only handles that were actually on the sheet, and each only once. A model
    // that hallucinates a row would otherwise caption a picture nobody showed
    // it, and that caption would be indistinguishable from the real ones ever
    // after — this index is written once and trusted for the life of the photo.
    if (!known.has(handle) || seen.has(handle)) continue;
    seen.add(handle);
    described.push({
      handle,
      striking: Math.min(99, Math.max(0, Math.round(Number(parts[1].trim()) || 0))),
      alt: parts.slice(2).join("|").trim().slice(0, AI.album.maxAltChars),
    });
  }

  return { described, usage: readUsage(json.usage) };
}
