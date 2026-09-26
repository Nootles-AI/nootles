import type { ToolResultPart } from "ai";

type ToolResultOutput = ToolResultPart["output"];
type ContentPart = Extract<ToolResultOutput, { type: "content" }>["value"][number];

/**
 * What `look_at` hands back, and what the model is given for it.
 *
 * The browser fetches the pictures (a storage URL is a bearer only its session
 * can derive) and answers with inline data. The data is for one turn: the
 * route turns it into media parts while the turn that asked is running, the
 * thread never stores it (`forStorage`), and a later turn is told the pictures
 * were looked at rather than sent them again (`shortenStaleReads`). A picture
 * with no `dataUri` is one of those — stored, or trimmed before a later request.
 */
export type LookAtResult = {
  images: { handle: string; mediaType: string; dataUri?: string }[];
  error?: string;
};

/** Stands in for a picture that is no longer sent. */
export const PICTURE_NOT_SENT = "(picture not sent)";

/**
 * Written for the model, which will otherwise take a picture it cannot see for
 * one it looked at and describe it from memory.
 */
export const PICTURES_MOVED_ON =
  "(These pictures are from an earlier turn and are not sent again. Call look_at for them to see them now.)";

/**
 * The model's view of a `look_at` result: each picture's handle, then the
 * picture itself.
 *
 * `output` is whatever the transcript holds — the browser's answer, the copy the
 * thread stored, or text that has already replaced it — so nothing about its
 * shape is taken on trust. A result whose pictures are all gone is text, since
 * a message made only of notices is no reason to send media parts at all.
 */
export function lookAtOutput(output: unknown): ToolResultOutput {
  if (typeof output === "string") return { type: "text", value: output };
  const { images, error } = (output ?? {}) as Partial<LookAtResult>;
  if (!Array.isArray(images) || !images.length) {
    return { type: "text", value: String(error ?? "") };
  }
  const parts: ContentPart[] = images.flatMap((image) => {
    const data = base64Of(image.dataUri);
    return [
      { type: "text" as const, text: `${image.handle}:` },
      data
        ? { type: "file" as const, data: { type: "data" as const, data }, mediaType: image.mediaType }
        : { type: "text" as const, text: PICTURE_NOT_SENT },
    ];
  });
  return parts.some((part) => part.type !== "text")
    ? { type: "content", value: parts }
    : withoutPictures(parts);
}

/**
 * A result's words with its pictures taken out: each picture becomes a notice
 * where it stood, so a label still reads against the picture it named.
 */
export function withoutPictures(parts: ContentPart[]): ToolResultOutput {
  const said = parts.map((part) => (part.type === "text" ? part.text : PICTURE_NOT_SENT)).join(" ");
  return { type: "text", value: `${said}\n${PICTURES_MOVED_ON}` };
}

/**
 * Base64 only. The browser hands back a whole data URI because that is what a
 * FileReader gives it; the prefix is the wrapper, not the picture.
 */
function base64Of(dataUri: unknown): string | null {
  if (typeof dataUri !== "string" || !dataUri.startsWith("data:")) return null;
  const data = dataUri.slice(dataUri.indexOf(",") + 1);
  // A thread saved before the bytes were kept out of it holds them cut short
  // with a note on the end, which a provider refuses as an image — and refuses
  // the whole request for.
  return BASE64.test(data) ? data : null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
