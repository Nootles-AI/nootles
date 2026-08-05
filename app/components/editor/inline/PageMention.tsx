"use client";

import { createReactInlineContentSpec } from "@blocknote/react";
import type { Id } from "@/convex/_generated/dataModel";
import { useCurrentPage, useOpenPageOptional } from "../../OpenPageContext";
import { usePages } from "../../PagesContext";
import { FileDoc } from "../../Icons";

/**
 * "@Page" — a chip that names another page and opens it on click.
 *
 * The title is stored with the mention so the chip still reads as something
 * when the page is gone or the surface has no page list (the share route), but
 * it is rendered from the live list when one is around — a rename should not
 * leave stale chips scattered through the project.
 */
export function pageTitle(title: string): string {
  return title.trim() || "Untitled";
}

function PageMentionView({
  pageId,
  title,
}: {
  pageId: string;
  title: string;
}) {
  const pages = usePages();
  const openPage = useOpenPageOptional();
  const here = useCurrentPage();
  const live = pages?.find((p) => p._id === pageId);
  const label = pageTitle(live?.title ?? title);
  const open = openPage
    ? () => openPage.follow(pageId as Id<"pages">, here)
    : undefined;

  return (
    <span
      className="nt-ref"
      contentEditable={false}
      role={open ? "link" : undefined}
      tabIndex={open ? 0 : undefined}
      onClick={open}
      onKeyDown={
        open
          ? (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                open();
              }
            }
          : undefined
      }
    >
      {/* The glyph is the referent's kind — a page, today. When chips learn to
          name tickets and files, the icon is what will tell them apart. */}
      <FileDoc className="nt-ref-icon" aria-hidden />
      {label}
    </span>
  );
}

export const pageMentionSpec = createReactInlineContentSpec(
  {
    type: "pageMention",
    propSchema: { pageId: { default: "" }, title: { default: "" } },
    content: "none",
  },
  {
    render: (props) => (
      <PageMentionView
        pageId={props.inlineContent.props.pageId}
        title={props.inlineContent.props.title}
      />
    ),
  },
);
