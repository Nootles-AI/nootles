import type { DataUIPart, TextPart } from "ai";

/**
 * What a user message carries besides its prose, and how each reaches the model.
 *
 * Both are structured parts rather than text woven into the message: a mention
 * resolves to the page it named, not to whatever prose happens to surround the
 * word, and an attachment keeps its filename attached to its bytes. They are
 * stored verbatim in `chatMessages.parts`, so a reloaded thread shows the same
 * chips and sends the model the same thing it saw the first time.
 *
 * An image is not here — it is a `file` part, which is how a provider is given
 * something to look at.
 */

export type MentionData =
  /** A page, with what it said when the message was sent. */
  | { kind: "page"; pageId: string; title: string; content: string }
  /** A file attached to this same message. */
  | { kind: "file"; filename: string };

/** A text, code or Markdown file, inlined — the bytes are the message. */
export type AttachmentData = {
  filename: string;
  mediaType: string;
  text: string;
};

export type AbDataParts = {
  mention: MentionData;
  attachment: AttachmentData;
};

/**
 * The model's view of a data part.
 *
 * Passed to `convertToModelMessages`, which drops any part this returns nothing
 * for. A page mention carries the page's HTML because it was resolved in the
 * browser when the message was sent — the page has since moved on, and what the
 * user was pointing at is what they meant.
 */
export function convertDataPart(
  part: DataUIPart<AbDataParts>,
): TextPart | undefined {
  if (part.type === "data-attachment") {
    const { filename, mediaType, text } = part.data;
    return {
      type: "text",
      text: [
        `The user attached the file "${filename}" (${mediaType}):`,
        `--- begin ${filename} ---`,
        text,
        `--- end ${filename} ---`,
      ].join("\n"),
    };
  }

  if (part.type === "data-mention" && part.data.kind === "page") {
    return {
      type: "text",
      text: [
        `The user mentioned the page "${part.data.title}". It read, when they sent this:`,
        part.data.content,
      ].join("\n"),
    };
  }

  // A file mention names an attachment on this same message, which the model has
  // already been given under that filename. Saying so again would be a second
  // copy of the file, or a sentence about one.
  return undefined;
}
