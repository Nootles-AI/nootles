import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { createRoot } from "react-dom/client";
import { TextSelection } from "prosemirror-state";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { useTabCompletion } from "../app/components/editor/ai/useTabCompletion";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

type Editor = typeof schema.BlockNoteEditor;

const text = (t: string) => [{ type: "text" as const, text: t, styles: {} }];
const block = (id: string, type: string, t: string) => ({
  id,
  type,
  props: {},
  content: text(t),
  children: [],
});

// Each scenario is a page a person might really be writing.
const SCENARIOS: Record<string, { title: string; blocks: ReturnType<typeof block>[] }> = {
  list: {
    title: "Release checklist",
    blocks: [
      block("h", "heading", "Launch steps"),
      ...Array.from({ length: 12 }, (_, i) =>
        block(`li${i + 1}`, "numberedListItem", `Step ${i + 1}: verify widget${i + 1}`),
      ),
    ],
  },
  long: {
    title: "Field notes",
    blocks: Array.from({ length: 300 }, (_, i) =>
      block(`p${i}`, "paragraph", `Paragraph ${i} ${"lorem ipsum ".repeat(8)}`.trim()),
    ),
  },
  far: {
    title: "Platform plan",
    blocks: [
      block("stack", "paragraph", "Our stack runs on Kubernetes with Terraform modules."),
      ...Array.from({ length: 8 }, (_, i) =>
        block(`n${i}`, "paragraph", `Note ${i} about the weekly sync.`),
      ),
      block("caret", "paragraph", "Next quarter we migrate the"),
    ],
  },
  diagram: {
    title: "Fulfilment",
    blocks: [
      block("intro", "paragraph", "Orders move through picking, packing and shipping."),
      block("caret", "paragraph", "Here is the flow"),
    ],
  },
  sentence: {
    title: "Launch plan",
    blocks: [
      block("intro", "paragraph", "The launch is planned for the spring."),
      block("caret", "paragraph", "The release ships on Friday."),
      block("after", "paragraph", "Support is staffed all weekend."),
    ],
  },
  below: {
    title: "Platform plan",
    blocks: [
      block("caret", "paragraph", "This quarterly platform plan mostly covers the"),
      ...Array.from({ length: 6 }, (_, i) =>
        block(`n${i}`, "paragraph", `Note ${i} about the weekly sync.`),
      ),
      block("later", "paragraph", "Rollout checklist and staffing are owned by ops."),
    ],
  },
};

const params = new URLSearchParams(location.search);
const scenario = SCENARIOS[params.get("scenario") ?? "list"];
const reach = Number(params.get("reach") ?? "1");

const editor = BlockNoteEditor.create({
  schema,
  extensions: [completionExtension, reviewExtension, hintExtension],
  initialContent: scenario.blocks as never,
}) as unknown as Editor;

function Fixture() {
  useTabCompletion(editor, undefined, scenario.title, reach);
  return (
    <BlockNoteView
      editor={editor}
      theme="light"
      className="nt-editor"
      sideMenu={false}
      slashMenu={false}
      formattingToolbar={false}
    />
  );
}

const convex = new ConvexReactClient("https://completion-window.invalid", {
  skipConvexDeploymentUrlCheck: true,
});
createRoot(document.getElementById("app")!).render(
  <ConvexProvider client={convex}>
    <Fixture />
  </ConvexProvider>,
);

const flat = (blocks: unknown[]): { id: string; type: string; text: string }[] =>
  (blocks as Array<{ id: string; type: string; content?: unknown; children?: unknown[] }>).flatMap(
    (b) => [
      {
        id: b.id,
        type: b.type,
        text: Array.isArray(b.content)
          ? (b.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
          : "",
      },
      ...flat(b.children ?? []),
    ],
  );

const harness = {
  caretAtEnd(id: string) {
    editor.focus();
    editor.setTextCursorPosition(id, "end");
  },
  /** The caret `offset` characters into block `id`'s text. */
  caretAt(id: string, offset: number) {
    editor.focus();
    editor.setTextCursorPosition(id, "start");
    const view = editor.prosemirrorView!;
    const at = view.state.selection.from + offset;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  },
  doc: () => flat(editor.document),
  /** Each canvas block's stored markup, in document order. */
  canvases: () =>
    (editor.document as Array<{ type: string; props: { data?: string } }>)
      .filter((b) => b.type === "canvas")
      .map((b) => b.props.data ?? ""),
  ghost: () => document.querySelector(".nt-ghost")?.textContent ?? "",
};

declare global {
  interface Window {
    completionWindow: typeof harness;
  }
}
window.completionWindow = harness;
