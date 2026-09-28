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
The tiles run left to right, then top to bottom. Use the ordered handle list
provided with the sheet to name each tile by its position; the stamp is only
a cross-check. If a tile and its listed handle seem to disagree, omit that tile.

Answer with one line per photograph, in this exact format and nothing else:

handle | striking | what the photograph is

- handle: copied EXACTLY from the ordered list. Never invent one, never renumber.
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
              text: `Handles in grid order (left to right, top to bottom):\n${sheet.handles.map((handle, index) => `${index + 1}. ${handle}`).join("\n")}`,
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
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: unknown;
  };
  const text = json.choices?.[0]?.message?.content ?? "";

  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  // A length stop can leave a plausible but clipped caption. It would be
  // written once and never asked about again, so the last row must stay open.
  if (json.choices?.[0]?.finish_reason === "length") lines.pop();

  const seen = new Set<string>();
  const described: Described[] = [];
  let rowIndex = 0;
  for (const line of lines) {
    const parts = line
      .trim()
      .replace(/^(?:[-*]|\d+[.)])\s+/, "")
      .replace(/^\|/, "")
      .replace(/\|\s*$/, "")
      .split("|");
    if (parts.length < 3) continue;
    const score = parts[1].match(/\d+/)?.[0];
    const alt = parts.slice(2).join("|").trim().slice(0, AI.album.maxAltChars);
    if (!score || !alt) continue;
    const handle = parts[0].trim().replace(/^[*`]+|[*`]+$/g, "").trim();
    const expected = sheet.handles[rowIndex++];
    // Only handles that were actually on the sheet, and each only once. A model
    // that swaps two valid handles would attach captions to the wrong pictures.
    // The ordered list lets us leave doubtful rows undescribed for a later read.
    if (!known.has(handle) || handle !== expected || seen.has(handle)) continue;
    seen.add(handle);
    described.push({
      handle,
      striking: Math.min(99, Math.max(0, Number(score))),
      alt,
    });
  }

  return { described, usage: readUsage(json.usage) };
}
