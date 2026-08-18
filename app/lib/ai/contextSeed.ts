import { AI } from "./aiConfig";

/**
 * The project's standing context as the completion lane carries it: an HTML
 * comment appended to the grammar preamble, so the parser never sees it and the
 * model does. The chat agent gets the same context as an instruction with tools
 * to read further; this lane has no tools, so it gets the words themselves —
 * the sheet's answers and the head of each context file — tightly capped,
 * because the seed prefixes every completion.
 */
export function contextSeed(
  project: {
    title: string;
    entries: readonly { question: string; answer?: string }[];
    files?: readonly { filename: string; head?: string }[];
  } | null,
): string {
  if (!project) return "";
  const { fileHeadChars, maxChars } = AI.fim.context;

  const said = project.entries
    .map((e) => ({ question: e.question.trim(), answer: e.answer?.trim() ?? "" }))
    .filter((e) => e.answer);
  const files = (project.files ?? []).filter((f) => f.head?.trim());
  if (!said.length && !files.length) return "";

  const body = comment(
    [
      `Project: ${project.title.trim() || "Untitled"}`,
      "",
      ...said.flatMap((e) => [e.question, e.answer, ""]),
      ...files.flatMap((f) => [
        `From ${f.filename}:`,
        f.head!.trim().slice(0, fileHeadChars),
        "",
      ]),
    ]
      .join("\n")
      .trim(),
  ).slice(0, maxChars);

  return `<!-- What this document's project is about. Ground completions in it: prefer its
names and facts over invented ones.
${body} -->\n`;
}

/**
 * A comment may not contain "--", and this body is the user's own files — one
 * stray "-->" in a pasted README would end the comment and dump the rest into
 * the document the model completes.
 */
const comment = (text: string) => text.replace(/--/g, "–");
