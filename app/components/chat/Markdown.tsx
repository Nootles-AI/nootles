"use client";

import { memo, type ReactNode } from "react";
import { safeHref } from "@/app/lib/ai/html/parse";

/**
 * The assistant's reply, with its markdown rendered.
 *
 * The model writes markdown whether or not it is asked to, and shown raw it is
 * worse than plain prose would have been: `###` and `**` are noise in a column
 * this narrow. A subset is enough — headings, emphasis, code, lists, rules and
 * links are what actually turns up in a reply.
 *
 * Deliberately NOT a markdown library. This renders to React elements, so there
 * is no HTML for model-authored text to inject through, and links go through the
 * same `safeHref` the document uses rather than a second opinion about what is
 * clickable. It is also forgiving on purpose: replies arrive a token at a time,
 * so every rule needs its closing delimiter before it matches, and a half-typed
 * `**bold` stays as the characters it is until the rest lands.
 *
 * Fenced code blocks and tables are not handled and pass through as written —
 * the model puts those on the page rather than in the chat. If they start
 * turning up here, they belong in RULES and `blocksOf` respectively.
 *
 * Memoized on the text: a turn writes prose once and then goes on calling
 * tools, and every one of those redraws the turn it belongs to.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <>{blocksOf(text)}</>;
});

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const NUMBER = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;

/** Line-led block structure: the only things that need a whole line to declare. */
function blocksOf(source: string): ReactNode[] {
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  let key = 0;

  const closeParagraph = () => {
    if (!paragraph.length) return;
    // Joined with a space, because a single newline is a soft wrap in markdown
    // and the model hard-wraps its prose.
    out.push(
      <p key={key++} className="nt-turn-text">
        {inlineOf(paragraph.join(" "))}
      </p>,
    );
    paragraph = [];
  };

  const closeList = () => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{inlineOf(item)}</li>);
    out.push(
      list.ordered ? (
        <ol key={key++} className="nt-md-list" start={list.start}>
          {items}
        </ol>
      ) : (
        <ul key={key++} className="nt-md-list">
          {items}
        </ul>
      ),
    );
    list = null;
  };

  const close = () => {
    closeParagraph();
    closeList();
  };

  for (const line of source.split("\n")) {
    if (!line.trim()) {
      close();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      close();
      out.push(
        <p
          key={key++}
          className="nt-md-heading"
          // Levels past three are the same size: this is a chat panel, not an
          // outline, and six sizes of heading in it would be five too many.
          data-level={Math.min(heading[1].length, 3)}
        >
          {inlineOf(heading[2])}
        </p>,
      );
      continue;
    }

    // Before the bullet rule, or `---` reads as an empty list item.
    if (RULE.test(line)) {
      close();
      out.push(<hr key={key++} className="nt-md-rule" />);
      continue;
    }

    const numbered = NUMBER.exec(line);
    const bulleted = numbered ? null : BULLET.exec(line);
    if (numbered || bulleted) {
      const ordered = Boolean(numbered);
      closeParagraph();
      // A change of kind ends the list: one run of bullets after another of
      // numbers is two lists, not one that changed its mind.
      if (list && list.ordered !== ordered) closeList();
      if (!list) list = { ordered, start: Number(numbered?.[1] ?? 1), items: [] };
      list.items.push((numbered?.[2] ?? bulleted?.[1]) as string);
      continue;
    }

    // A plain line under a list item continues it, rather than starting a
    // paragraph that would break the list in half.
    if (list) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }

  close();
  return out;
}

type Rule = {
  match: RegExp;
  /** Whether what it captured should be read for markup of its own. */
  nested: boolean;
  render: (m: RegExpExecArray, body: ReactNode, key: number) => ReactNode;
};

/**
 * Order matters where two rules can start at the same character: the first one
 * listed wins the tie, which is why bold is above italic.
 */
const RULES: Rule[] = [
  {
    match: /`([^`\n]+)`/,
    nested: false,
    render: (m, _b, key) => <code key={key}>{m[1]}</code>,
  },
  {
    match: /\[([^\]\n]*)\]\(([^)\s]+)\)/,
    nested: true,
    render: (m, body, key) => {
      const href = safeHref(m[2]);
      // A destination we will not follow is not a link, but the words still
      // said something — the same answer the document's parser gives.
      if (!href) return <span key={key}>{body}</span>;
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {body}
        </a>
      );
    },
  },
  {
    match: /\*\*([^\n]+?)\*\*/,
    nested: true,
    render: (_m, body, key) => <strong key={key}>{body}</strong>,
  },
  {
    match: /~~([^\n]+?)~~/,
    nested: true,
    render: (_m, body, key) => <s key={key}>{body}</s>,
  },
  // The leading class refuses a space and a second asterisk, so neither a bullet
  // that lost its line nor the front of a `**bold**` is read as italic.
  {
    match: /\*([^\s*][^*\n]*?)\*/,
    nested: true,
    render: (_m, body, key) => <em key={key}>{body}</em>,
  },
  // No `_emphasis_` rule, on purpose. Underscores are far likelier to be inside
  // an identifier than around a word here — this is a tool people plan code in,
  // and `my_var_name` rendering as "my var name" with the middle in italics is a
  // worse failure than `_x_` staying as it was written.
];

/** Whichever rule closes earliest, then the same question about what is left. */
function inlineOf(text: string, key = 0): ReactNode[] {
  let best: { rule: Rule; at: RegExpExecArray } | null = null;
  for (const rule of RULES) {
    const at = rule.match.exec(text);
    if (at && (!best || at.index < best.at.index)) best = { rule, at };
  }
  if (!best) return text ? [text] : [];

  const { rule, at } = best;
  const body = rule.nested ? inlineOf(at[1], key + 1) : at[1];
  return [
    ...(at.index ? [text.slice(0, at.index)] : []),
    rule.render(at, body, key),
    ...inlineOf(text.slice(at.index + at[0].length), key + 1),
  ];
}
