/** Synthetic workspace for the mockups. Nothing here is read from Convex, and nothing calls a model. */

export const mockups = [
  { n: 1, name: "Quiet Rails", note: "The incumbent shell, finished in the projects page's materials" },
  { n: 2, name: "Islands", note: "A sheet on a ground; every panel floats, folds to a pill" },
  { n: 3, name: "One Bar", note: "No rails. One ink dock that becomes what the moment needs" },
  { n: 4, name: "Margin", note: "Pages as tabs on the sheet; the AI and the inspector live in the margin" },
  { n: 5, name: "Stage", note: "A filmstrip of pages; a diagram opens into a stage with trays" },
  { n: 6, name: "Spine", note: "An ink spine of drawers on the left, a minimap of the page on the right" },
  { n: 7, name: "Split", note: "The page and its canvas side by side, always; the assistant rises between them" },
  { n: 8, name: "Halo", note: "No panels. Controls hug the selection, and tools come to the pointer" },
  { n: 9, name: "Desk", note: "Sheets on a desk: neighbours peek from behind, and turning a page is a gesture" },
  { n: 10, name: "Inline", note: "One mono status line. The assistant answers inside the page, where you asked" },
] as const;

export const project = { title: "Rate limiting", context: "Edge team · Q4" };

export type PageNode = { id: string; title: string; folder?: string; blank?: boolean };

export const pages: PageNode[] = [
  { id: "overview", title: "Rate limiting" },
  { id: "failure", title: "Failure modes" },
  { id: "rollout", title: "Rollout plan" },
  { id: "bucket", title: "Token bucket vs sliding window", folder: "Research" },
  { id: "prior", title: "What Stripe and Cloudflare do", folder: "Research" },
  { id: "open", title: "Open questions" },
];

export type Person = { id: string; name: string; initials: string; tone: number; role: "owner" | "can edit" | "can view" };

/** `tone` is a lightness step, not a hue: presence is told apart by value and initials. */
export const people: Person[] = [
  { id: "you", name: "Ali Hosseini", initials: "A", tone: 0.32, role: "owner" },
  { id: "maya", name: "Maya Okafor", initials: "M", tone: 0.46, role: "can edit" },
  { id: "jonas", name: "Jonas Weber", initials: "J", tone: 0.6, role: "can view" },
];

export type ShapeKind = "rect" | "ellipse" | "diamond" | "polygon" | "text" | "tag";

export type Shape = {
  id: string;
  kind: ShapeKind;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  fill: string;
  stroke: string;
  text: string;
  size: number;
  weight: number;
  opacity: number;
  hidden?: boolean;
  locked?: boolean;
};

export type Edge = { id: string; from: string; to: string };

const box = { r: 10, fill: "#F2F2F0", stroke: "#D8D8D4", size: 13, weight: 500, opacity: 100 };
const tag = { r: 5, fill: "#F7DFB5", stroke: "#EBC98F", size: 11, weight: 500, opacity: 100 };
const label = { r: 0, fill: "transparent", stroke: "transparent", opacity: 100 };

/** Listed back to front, which is the order the layers panel reads bottom to top. */
export const shapes: Shape[] = [
  { id: "title", kind: "text", name: "Current shape", x: 28, y: 22, w: 300, h: 26, text: "Current rate limiting shape", size: 16, weight: 600, ...label },
  { id: "a", kind: "rect", name: "Service A", x: 28, y: 70, w: 148, h: 52, text: "Service A", ...box },
  { id: "b", kind: "rect", name: "Service B", x: 212, y: 70, w: 148, h: 52, text: "Service B", ...box },
  { id: "c", kind: "rect", name: "Service C", x: 396, y: 70, w: 148, h: 52, text: "Service C", ...box },
  { id: "ta", kind: "tag", name: "In-process count", x: 40, y: 136, w: 124, h: 26, text: "In-process count", ...tag },
  { id: "tb", kind: "tag", name: "In-process count", x: 224, y: 136, w: 124, h: 26, text: "In-process count", ...tag },
  { id: "redis", kind: "ellipse", name: "Shared Redis", x: 408, y: 150, w: 124, h: 48, text: "Redis", ...box, r: 999 },
  { id: "note", kind: "text", name: "Caption", x: 28, y: 214, w: 360, h: 34, text: "Two of three services count in process memory, so the real limit is the limit times the replica count.", size: 11, weight: 400, ...label },
];

export const edges: Edge[] = [
  { id: "e1", from: "a", to: "b" },
  { id: "e2", from: "b", to: "c" },
  { id: "e3", from: "c", to: "redis" },
];

export const STAGE = { w: 572, h: 270 };

export type Block =
  | { id: string; type: "p" | "h2" | "quote"; text: string; ghost?: string; caret?: string; arrived?: boolean }
  | { id: string; type: "bullet"; text: string; hunk?: { del: string; add: string } }
  | { id: string; type: "todo"; text: string; done: boolean }
  | { id: string; type: "code"; lang: string; text: string }
  | { id: string; type: "table"; rows: string[][] }
  | { id: string; type: "diagram" };

export const blocks: Block[] = [
  { id: "b1", type: "p", text: "Move request limits out of each service and onto the edge, so the answer to “how many requests is too many” is written in one place." },
  { id: "b2", type: "h2", text: "Where we are" },
  { id: "b3", type: "bullet", text: "Three services do their own counting. Two count in process memory, which means the limit is really the limit times the number of replicas." },
  { id: "b4", type: "bullet", text: "The third counts in Redis, which is shared, but ", hunk: { del: "nobody can say what the number is at any given moment.", add: "the number lives in a constant nobody watches." } },
  { id: "b5", type: "p", text: "The current shape is", caret: "maya" },
  { id: "b6", type: "diagram" },
  { id: "b7", type: "h2", text: "What changes" },
  { id: "b8", type: "todo", text: "One sliding-window counter per API key, held at the edge", done: true },
  { id: "b9", type: "todo", text: "Services read the verdict from a header and stop counting", done: false },
  { id: "b10", type: "todo", text: "A dashboard that says what the limit is right now", done: false },
  { id: "b11", type: "code", lang: "TypeScript", text: "export async function admit(key: string, now = Date.now()) {\n  const window = Math.floor(now / 1000);\n  const count = await redis.incr(`rl:${key}:${window}`);\n  if (count === 1) await redis.expire(`rl:${key}:${window}`, 2);\n  return count <= LIMIT;\n}" },
  { id: "b12", type: "table", rows: [["Option", "Latency", "Survives restart"], ["Redis", "< 1 ms", "No"], ["Postgres", "4–6 ms", "Yes"]] },
  { id: "b13", type: "p", text: "Losing a window of counts on a restart means a brief over-admission,", ghost: " which is the cheap failure to have." },
];

export type SlashItem = { id: string; group: string; label: string; hint: string; keys?: string; icon: string };

export const slash: SlashItem[] = [
  { id: "p", group: "Write", label: "Text", hint: "Plain paragraph", icon: "Paragraph" },
  { id: "h1", group: "Write", label: "Heading 1", hint: "Top-level section", keys: "⌘⌥1", icon: "Heading1" },
  { id: "h2", group: "Write", label: "Heading 2", hint: "Section inside a section", keys: "⌘⌥2", icon: "Heading2" },
  { id: "quote", group: "Write", label: "Quote", hint: "Set a passage apart", icon: "Quote" },
  { id: "bullet", group: "Organise", label: "Bullet list", hint: "An unordered list", keys: "⌘⇧8", icon: "BulletList" },
  { id: "todo", group: "Organise", label: "To-do list", hint: "Checkboxes you can tick", keys: "⌘⇧9", icon: "TodoList" },
  { id: "table", group: "Organise", label: "Table", hint: "Rows and columns", icon: "Table" },
  { id: "divider", group: "Organise", label: "Divider", hint: "A line between things", icon: "Divider" },
  { id: "diagram", group: "Insert", label: "Diagram", hint: "Draw a canvas with shapes and connectors", icon: "Diagram" },
  { id: "storyboard", group: "Insert", label: "Storyboard", hint: "Shot frames with room to write underneath", icon: "Storyboard" },
  { id: "image", group: "Insert", label: "Image", hint: "A picture, with a caption", icon: "Image" },
  { id: "location", group: "Insert", label: "Location", hint: "A place, with a map, photos and reviews", icon: "Location" },
  { id: "math", group: "Compute", label: "Math block", hint: "Reactive equations with live variables", icon: "MathBlock" },
  { id: "code", group: "Compute", label: "Code block", hint: "Syntax-highlighted, in any language", keys: "⌘⌥C", icon: "CodeBlock" },
];

export type Msg =
  | { id: string; from: "you"; text: string }
  | { id: string; from: "ai"; text: string; steps?: string[] };

export const thread: Msg[] = [
  { id: "m1", from: "you", text: "Redis or Postgres for the counters?" },
  {
    id: "m2",
    from: "ai",
    text: "Redis. The counter is written and read on every single request, and at that rate the durability Postgres buys you is not worth the latency it costs. Losing a window of counts on a restart means a brief over-admission, which is the cheap failure to have.",
  },
];

export const threads = [
  { title: "Where the counters live", age: "now" },
  { title: "Naming the header", age: "2d" },
  { title: "Rollout order", age: "Sep 8" },
];

/** What the mock assistant says next. Typed out on a timer; no model is called. */
export const scripted = {
  steps: ["Read Rate limiting", "Edited Rate limiting", "Drew Current shape"],
  text: "I’d put the edge in the picture. One counter in front of all three services, and the two in-process counts go away.",
};

export const swatches = ["#F2F2F0", "#FFFFFF", "#E6E5E1", "#2B2B28", "#F7DFB5", "#D9E4D4", "#E4DAD3", "#DCE1E6"];
