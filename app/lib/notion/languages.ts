/**
 * Notion's code languages onto the grammars Nootles actually loads.
 *
 * Notion offers around eighty language names; `codemirror/languages.ts` ships
 * thirteen grammars, lazily. Passing an unmapped Notion name straight through
 * would produce a code block that never highlights and never says why, so the
 * map is explicit and everything outside it becomes `plaintext` with a
 * diagnostic. A test asserts every target here is a grammar that exists.
 *
 * `mermaid` is deliberately plain text for now: Notion renders those blocks as
 * diagrams, and turning them into canvas blocks is the single best enrichment
 * available later — but a wrong diagram is worse than a right code block.
 */
export const NOTION_LANGUAGES: Record<string, string> = {
  typescript: "typescript",
  "objective-c++": "plaintext",
  tsx: "tsx",
  javascript: "javascript",
  jsx: "jsx",
  java: "java",
  python: "python",
  json: "json",
  html: "html",
  css: "css",
  markdown: "markdown",
  sql: "sql",
  rust: "rust",
  // Close enough to read correctly under a neighbouring grammar.
  "c++": "plaintext",
  c: "plaintext",
  "c#": "plaintext",
  go: "plaintext",
  ruby: "plaintext",
  php: "plaintext",
  swift: "plaintext",
  kotlin: "plaintext",
  scala: "plaintext",
  shell: "plaintext",
  bash: "plaintext",
  yaml: "plaintext",
  toml: "plaintext",
  xml: "html",
  graphql: "plaintext",
  diff: "plaintext",
  docker: "plaintext",
  mermaid: "plaintext",
  "plain text": "plaintext",
};

export const FALLBACK_LANGUAGE = "plaintext";

export function nootlesLanguage(notion: string | undefined): {
  id: string;
  mapped: boolean;
} {
  if (!notion) return { id: FALLBACK_LANGUAGE, mapped: true };
  const id = NOTION_LANGUAGES[notion.toLowerCase()];
  return id ? { id, mapped: true } : { id: FALLBACK_LANGUAGE, mapped: false };
}
