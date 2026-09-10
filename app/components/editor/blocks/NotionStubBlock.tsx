"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { NotionMark } from "@/app/components/NotionMark";
import { describeStub } from "@/app/lib/notion/stub";
import "./notionStub.css";

/**
 * The stub block: a Notion block the import could not bring across.
 *
 * The canonical document keeps the quote-and-link form the converter writes;
 * this is how the editor shows it. Locked, because nothing in it is the
 * reader's to edit: the type names what it was, the link goes back to it, and
 * `raw` carries the ledger's JSON so a later schema can upgrade the block in
 * place without going back to Notion.
 *
 * The way back is a link, not a button: it is a navigation, and a link keeps
 * a link's affordances — a modified click to a tab, an address to copy. Tab
 * cannot reach it from inside the editor (the editor owns Tab), so the block
 * also opens from the keyboard when it is the selected block; see
 * `useNotionLinks`.
 */
export const notionStubBlockSpec = createReactBlockSpec(
  {
    type: "notionStub",
    propSchema: {
      notionType: { default: "" },
      notionId: { default: "" },
      href: { default: "" },
      raw: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const { label, reason, known } = describeStub(block.props.notionType);
      const href = block.props.href;
      return (
        // `w-full` is load-bearing: BlockNote lays a block's content out with
        // flex, so this wrapper would otherwise shrink to the card's width.
        <div className="relative w-full">
          <div
            className="nt-stub"
            contentEditable={false}
            role="group"
            aria-label={`${label} from Notion, ${reason.toLowerCase()}`}
          >
            <span className="nt-stub-mark" aria-hidden>
              <NotionMark />
            </span>
            <span className="nt-stub-text">
              <span className={known ? "nt-stub-label" : "nt-stub-type"}>{label}</span>
              <span className="nt-stub-reason">{reason}</span>
            </span>
            {href && (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="nt-row nt-stub-open"
              >
                Open in Notion
              </a>
            )}
          </div>
        </div>
      );
    },
  },
)();
