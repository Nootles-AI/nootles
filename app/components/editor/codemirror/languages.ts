import type { Extension } from "@codemirror/state";

/**
 * Supported languages for code blocks. Each grammar is loaded lazily on demand
 * (dynamic import) so the initial bundle stays small and only languages a
 * document actually uses are fetched.
 */
type LangDef = { id: string; label: string; load: () => Promise<Extension> };

export const LANGUAGES: LangDef[] = [
  { id: "plaintext", label: "Plain text", load: async () => [] },
  { id: "typescript", label: "TypeScript", load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }) },
  { id: "tsx", label: "TSX", load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }) },
  { id: "javascript", label: "JavaScript", load: async () => (await import("@codemirror/lang-javascript")).javascript() },
  { id: "jsx", label: "JSX", load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }) },
  { id: "python", label: "Python", load: async () => (await import("@codemirror/lang-python")).python() },
  { id: "json", label: "JSON", load: async () => (await import("@codemirror/lang-json")).json() },
  { id: "html", label: "HTML", load: async () => (await import("@codemirror/lang-html")).html() },
  { id: "css", label: "CSS", load: async () => (await import("@codemirror/lang-css")).css() },
  { id: "markdown", label: "Markdown", load: async () => (await import("@codemirror/lang-markdown")).markdown() },
  { id: "sql", label: "SQL", load: async () => (await import("@codemirror/lang-sql")).sql() },
  { id: "rust", label: "Rust", load: async () => (await import("@codemirror/lang-rust")).rust() },
];

const byId = new Map(LANGUAGES.map((l) => [l.id, l]));

export const languageLabel = (id: string): string => byId.get(id)?.label ?? id;

export const loadLanguage = (id: string): Promise<Extension> =>
  byId.get(id)?.load() ?? Promise.resolve([]);
