"use client";

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { slash, type Block } from "./data";
import { useUi } from "./store";
import { Editable, IconBtn, Segmented } from "./controls";
import { Group, Item, Pop, Select, Sep } from "./overlays";
import {
  At,
  BlockIcon,
  Bold,
  Check,
  CodeMark,
  Copy,
  Duplicate,
  FileDoc,
  Grip,
  ItalicMark,
  LinkIcon,
  Plus,
  Sparkle,
  Strike,
  Trash,
  Underline,
  X,
} from "./icons";
import { Diagram } from "./Diagram";
import { Face } from "./Share";

type Trigger = {
  kind: "/" | "@";
  block: string;
  query: string;
  index: number;
  x: number;
  y: number;
};

const KEYWORDS = /^(export|async|function|const|await|return|if)$/;

/** Enough of a highlighter to read as code: keywords lift, strings and the rest recede. */
function Code({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`]*`|\b(?:export|async|function|const|await|return|if)\b)/g)
        .map((part, i) =>
          part.startsWith("`") ? (
            <span key={i} className="ek-tok-str">
              {part}
            </span>
          ) : KEYWORDS.test(part) ? (
            <b key={i}>{part}</b>
          ) : (
            <Fragment key={i}>{part}</Fragment>
          ),
        )}
    </>
  );
}

export function ModeToggle() {
  const { ui, act } = useUi();
  return (
    <Segmented
      label="Suggestion mode"
      className="ek-mode is-mono"
      value={ui.docMode}
      onChange={(docMode) => act.set({ docMode })}
      options={[
        {
          value: "create",
          label: "Create",
          tip: "Writes what is not there yet.",
        },
        {
          value: "complete",
          label: "Complete",
          tip: "Only finishes what you started.",
        },
      ]}
    />
  );
}

function Handles({ block }: { block: Block }) {
  const { act } = useUi();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const grip = useRef<HTMLButtonElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  return (
    <div
      className="ek-handles"
      data-open={open || adding || undefined}
      contentEditable={false}
    >
      <button
        ref={plus}
        type="button"
        className="ek-icon-btn is-sm"
        aria-label="Insert a block below"
        data-tip="Insert below"
        onClick={() => setAdding((o) => !o)}
      >
        <Plus width={14} height={14} />
      </button>
      <button
        ref={grip}
        type="button"
        className="ek-icon-btn is-sm ek-grip"
        aria-label="Block actions"
        data-tip="Drag to move · click for actions"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Grip width={14} height={14} />
      </button>
      <Pop
        open={open}
        onClose={() => setOpen(false)}
        anchor={grip}
        label="Block actions"
      >
        <Item
          icon={<Duplicate />}
          label="Duplicate"
          keys="⌘D"
          onSelect={() => act.insertBlock(block.id, block.type)}
        />
        <Item
          icon={<Copy />}
          label="Copy"
          keys="⌘C"
          onSelect={() => act.toast("Block copied")}
        />
        <Item icon={<span className="ek-colors-dot" />} label="Colors" />
        <Sep />
        <Item
          icon={<Trash width={16} height={16} />}
          label="Delete"
          keys="⌫"
          danger
          onSelect={() => act.removeBlock(block.id)}
        />
      </Pop>
      <Pop
        open={adding}
        onClose={() => setAdding(false)}
        anchor={plus}
        label="Insert a block"
        className="ek-pop-slash"
      >
        <SlashList
          query=""
          index={-1}
          onPick={(id) => act.insertBlock(block.id, id)}
        />
      </Pop>
    </div>
  );
}

function SlashList({
  query,
  index,
  onPick,
}: {
  query: string;
  index: number;
  onPick: (id: string) => void;
}) {
  const found = slash.filter((s) =>
    s.label.toLowerCase().includes(query.toLowerCase()),
  );
  if (!found.length)
    return <p className="ek-note ek-pop-empty">No blocks match</p>;
  return (
    <>
      {found.map((s, i) => (
        <Fragment key={s.id}>
          {(i === 0 || found[i - 1].group !== s.group) && (
            <Group>{s.group}</Group>
          )}
          <div data-active={i === index || undefined} className="ek-item-wrap">
            <Item
              icon={<BlockIcon name={s.icon} />}
              label={s.label}
              hint={s.hint}
              keys={s.keys}
              onSelect={() => onPick(s.id)}
            />
          </div>
        </Fragment>
      ))}
    </>
  );
}

export function Doc({
  hideDiagram,
  slot,
}: { hideDiagram?: boolean; slot?: { after: string; node: ReactNode } } = {}) {
  const { ui, act } = useUi();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [fmt, setFmt] = useState<{ x: number; y: number } | null>(null);
  const [turn, setTurn] = useState("Text");
  const root = useRef<HTMLDivElement>(null);

  const options = trigger
    ? trigger.kind === "/"
      ? slash
          .filter((s) =>
            s.label.toLowerCase().includes(trigger.query.toLowerCase()),
          )
          .map((s) => s.id)
      : ui.pages
          .filter((p) =>
            p.title.toLowerCase().includes(trigger.query.toLowerCase()),
          )
          .map((p) => p.id)
    : [];

  // The formatting bar belongs to the selection, wherever in the page it is.
  useEffect(() => {
    const onSelect = () => {
      const sel = getSelection();
      const node = sel?.anchorNode;
      if (
        !sel ||
        sel.isCollapsed ||
        !node ||
        !root.current?.contains(node) ||
        (node.parentElement ?? (node as HTMLElement)).closest(
          ".ek-diagram, .ek-code",
        )
      )
        return setFmt(null);
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setFmt({ x: r.left + r.width / 2, y: r.top });
    };
    document.addEventListener("selectionchange", onSelect);
    return () => document.removeEventListener("selectionchange", onSelect);
  }, []);

  /** Cuts the typed trigger ("/tab", "@fail") back out of the text, and drops a node where it was. */
  const consume = (put?: Node) => {
    const sel = getSelection();
    const node = sel?.anchorNode;
    if (!sel || !node || node.nodeType !== Node.TEXT_NODE || !trigger) return;
    const text = node.textContent ?? "";
    const from = text.lastIndexOf(trigger.kind, sel.anchorOffset);
    if (from < 0) return;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, sel.anchorOffset);
    range.deleteContents();
    if (put) {
      range.insertNode(put);
      range.setStartAfter(put);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  const pick = (id: string) => {
    if (!trigger) return;
    if (trigger.kind === "/") {
      consume();
      if (id === "diagram") act.set({ mode: "diagram" });
      else act.insertBlock(trigger.block, id);
    } else {
      const chip = document.createElement("span");
      chip.className = "ek-mention";
      chip.contentEditable = "false";
      chip.textContent = ui.pages.find((p) => p.id === id)?.title ?? "";
      consume(chip);
    }
    setTrigger(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const host = (e.target as HTMLElement).closest<HTMLElement>("[data-block]");
    if (!host) return;
    const block = ui.blocks.find((b) => b.id === host.dataset.block);
    if (trigger) {
      const n = options.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        return setTrigger({
          ...trigger,
          index: n
            ? (trigger.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n
            : 0,
        });
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return options[trigger.index]
          ? pick(options[trigger.index])
          : setTrigger(null);
      }
      if (e.key === "Escape") return setTrigger(null);
    }
    if (
      !block ||
      block.type === "code" ||
      block.type === "table" ||
      block.type === "diagram"
    )
      return;
    const el = e.target as HTMLElement;
    if (e.key === "Tab" && "ghost" in block && block.ghost) {
      e.preventDefault();
      el.textContent += block.ghost;
      getSelection()?.selectAllChildren(el);
      getSelection()?.collapseToEnd();
      return act.acceptGhost(block.id);
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      return act.insertBlock(
        block.id,
        block.type === "bullet" || block.type === "todo" ? block.type : "p",
      );
    }
    if (
      e.key === "Backspace" &&
      el.textContent === "" &&
      ui.blocks.length > 1
    ) {
      e.preventDefault();
      const prev = host.previousElementSibling?.querySelector<HTMLElement>(
        "[contenteditable='true']",
      );
      act.removeBlock(block.id);
      if (prev) {
        prev.focus();
        getSelection()?.selectAllChildren(prev);
        getSelection()?.collapseToEnd();
      }
    }
  };

  const onInput = (e: React.FormEvent<HTMLDivElement>) => {
    const host = (e.target as HTMLElement).closest<HTMLElement>("[data-block]");
    const sel = getSelection();
    const node = sel?.anchorNode;
    if (!host || !sel || !node || node.nodeType !== Node.TEXT_NODE)
      return setTrigger(null);
    const match = /(?:^|\s)([/@])([\w ]{0,18})$/.exec(
      (node.textContent ?? "").slice(0, sel.anchorOffset),
    );
    if (!match) return setTrigger(null);
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const box = r.height
      ? r
      : (e.target as HTMLElement).getBoundingClientRect();
    setTrigger((t) => ({
      kind: match[1] as "/" | "@",
      block: host.dataset.block!,
      query: match[2],
      index: 0,
      x: t?.x ?? box.left,
      y: t?.y ?? box.bottom,
    }));
  };

  const text = (
    b: Extract<Block, { text: string }>,
    className: string,
    placeholder = "",
  ) => (
    <Editable
      initial={b.text}
      className={className}
      placeholder={placeholder}
      autoFocus={ui.fresh === b.id}
      tag={b.type === "h2" ? "h2" : "div"}
    />
  );

  return (
    <article className="ek-doc" ref={root}>
      <header className="ek-doc-head">
        <ModeToggle />
      </header>
      <Editable
        tag="h1"
        initial={ui.pages.find((p) => p.id === ui.pageId)?.title ?? ""}
        placeholder="Untitled"
        className="ek-title"
        key={ui.pageId}
      />

      <div
        className="ek-blocks ek-stagger"
        key={`blocks-${ui.pageId}`}
        onKeyDown={onKeyDown}
        onInput={onInput}
        onPointerDown={(e) => {
          // The text of a line is inline so a suggestion can follow it; a press
          // on the rest of the line still belongs to that text.
          const line = e.target as HTMLElement;
          const field =
            line.classList.contains("ek-line") &&
            line.querySelector<HTMLElement>("[contenteditable='true']");
          if (!field) return;
          e.preventDefault();
          field.focus();
          getSelection()?.selectAllChildren(field);
          getSelection()?.collapseToEnd();
        }}
      >
        {ui.pageId !== "overview" ? (
          <div className="ek-block" data-block="blank" data-type="p">
            <Editable
              initial=""
              className="ek-text"
              placeholder="Type / for headings, tables, diagrams"
            />
          </div>
        ) : (
          ui.blocks.map((b) => (
            <Fragment key={b.id}>
              <div
                className="ek-block"
                data-block={b.id}
                data-type={b.type}
                data-arrived={("arrived" in b && b.arrived) || undefined}
              >
                <Handles block={b} />
                {b.type === "diagram" && hideDiagram ? (
                  <button
                    type="button"
                    className="ek-diagram-ref"
                    onClick={() => act.set({ mode: "diagram" })}
                  >
                    <BlockIcon name="Diagram" />
                    <span>Current shape</span>
                    <span className="ek-meta">on the canvas</span>
                  </button>
                ) : b.type === "diagram" ? (
                  <Diagram />
                ) : b.type === "code" ? (
                  <figure className="ek-code">
                    <figcaption>
                      <Select
                        label="Language"
                        value={b.lang}
                        options={["TypeScript", "Python", "Go", "SQL"]}
                        onChange={() => {}}
                        className="is-on-dark"
                      />
                      <IconBtn
                        tip="Copy code"
                        className="is-sm is-on-dark"
                        onClick={() => act.toast("Code copied")}
                      >
                        <Copy width={14} height={14} />
                      </IconBtn>
                    </figcaption>
                    <pre>
                      <code>
                        <Code text={b.text} />
                      </code>
                    </pre>
                  </figure>
                ) : b.type === "table" ? (
                  <table className="ek-table">
                    <tbody>
                      {b.rows.map((row, r) => (
                        <tr key={r}>
                          {row.map((cell, c) => (
                            <td key={c} data-head={r === 0 || undefined}>
                              <Editable initial={cell} tag="span" />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : b.type === "todo" ? (
                  <div className="ek-todo" data-done={b.done}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={b.done}
                      aria-label="Done"
                      className="ek-check"
                      onClick={() => act.toggleTodo(b.id)}
                    >
                      <Check width={12} height={12} />
                    </button>
                    {text(b, "ek-text", "To-do")}
                  </div>
                ) : b.type === "bullet" && b.hunk && ui.review !== "none" ? (
                  <div
                    className="ek-text ek-bullet ek-hunk"
                    data-review={ui.review}
                  >
                    {b.text}
                    {ui.review !== "kept" && <del>{b.hunk.del}</del>}
                    {ui.review !== "discarded" && <ins>{b.hunk.add}</ins>}
                    {ui.review === "open" && (
                      <span className="ek-hunk-acts" contentEditable={false}>
                        <IconBtn
                          tip="Discard"
                          className="is-sm"
                          onClick={() => act.set({ review: "discarded" })}
                        >
                          <X width={12} height={12} />
                        </IconBtn>
                        <IconBtn
                          tip="Keep"
                          className="is-sm is-keep"
                          onClick={() => act.set({ review: "kept" })}
                        >
                          <Check width={12} height={12} />
                        </IconBtn>
                      </span>
                    )}
                  </div>
                ) : b.type === "bullet" ? (
                  <Editable
                    initial={b.text + (b.hunk?.del ?? "")}
                    className="ek-text ek-bullet"
                    placeholder="List"
                    autoFocus={ui.fresh === b.id}
                  />
                ) : (
                  <div className={`ek-line is-${b.type}`}>
                    {text(
                      b,
                      "ek-text",
                      b.type === "h2"
                        ? "Heading"
                        : "Type / for blocks, @ for pages",
                    )}
                    {b.ghost && ui.docMode === "complete" && (
                      <span className="ek-ghost" contentEditable={false}>
                        {b.ghost}
                        <kbd className="ek-kbd">Tab</kbd>
                      </span>
                    )}
                    {b.caret && (
                      <span className="ek-caret" contentEditable={false}>
                        <i>
                          <Face id={b.caret} size={14} />
                          Maya
                        </i>
                      </span>
                    )}
                  </div>
                )}
              </div>
              {slot?.after === b.id && slot.node}
            </Fragment>
          ))
        )}
      </div>

      <Pop
        open={trigger !== null && options.length > 0}
        onClose={() => setTrigger(null)}
        anchor={trigger ?? { x: 0, y: 0 }}
        focus={false}
        label={trigger?.kind === "@" ? "Link to page" : "Insert a block"}
        className={trigger?.kind === "@" ? "ek-pop-wide" : "ek-pop-slash"}
      >
        {trigger?.kind === "@" ? (
          <>
            <Group>Link to page</Group>
            {ui.pages
              .filter((p) => options.includes(p.id))
              .map((p, i) => (
                <div
                  key={p.id}
                  data-active={i === trigger.index || undefined}
                  className="ek-item-wrap"
                >
                  <Item
                    icon={<FileDoc width={14} height={14} />}
                    label={p.title || "Untitled"}
                    hint="Page"
                    onSelect={() => pick(p.id)}
                  />
                </div>
              ))}
          </>
        ) : (
          <SlashList
            query={trigger?.query ?? ""}
            index={trigger?.index ?? 0}
            onPick={pick}
          />
        )}
      </Pop>

      <Pop
        open={fmt !== null}
        onClose={() => setFmt(null)}
        anchor={fmt ?? { x: 0, y: 0 }}
        at={fmt ? `${fmt.x},${fmt.y}` : ""}
        side="top"
        align="center"
        gap={8}
        focus={false}
        role="dialog"
        label="Formatting"
        className="ek-pop-format"
      >
        <div className="ek-format" onPointerDown={(e) => e.preventDefault()}>
          <Select
            label="Turn into"
            value={turn}
            options={[
              "Text",
              "Heading 1",
              "Heading 2",
              "Quote",
              "Bullet list",
              "To-do list",
            ]}
            onChange={setTurn}
            className="is-quiet"
          />
          <i className="ek-format-sep" />
          {(
            [
              ["Bold", "⌘B", "bold", <Bold key="b" />],
              ["Italic", "⌘I", "italic", <ItalicMark key="i" />],
              ["Underline", "⌘U", "underline", <Underline key="u" />],
              ["Strikethrough", "⌘⇧X", "strikeThrough", <Strike key="s" />],
            ] as const
          ).map(([tip, keys, cmd, icon]) => (
            <IconBtn
              key={cmd}
              tip={tip}
              keys={keys}
              className="is-sm"
              onClick={() => document.execCommand(cmd)}
            >
              {icon}
            </IconBtn>
          ))}
          <IconBtn tip="Inline code" keys="⌘E" className="is-sm">
            <CodeMark />
          </IconBtn>
          <IconBtn tip="Link" keys="⌘K" className="is-sm">
            <LinkIcon width={16} height={16} />
          </IconBtn>
          <IconBtn tip="Mention a page" keys="@" className="is-sm">
            <At />
          </IconBtn>
          <i className="ek-format-sep" />
          <button
            type="button"
            className="ek-format-ai"
            onClick={() => act.set({ right: true, rightTab: "chat" })}
          >
            <Sparkle width={14} height={14} />
            Ask
          </button>
        </div>
      </Pop>
    </article>
  );
}
