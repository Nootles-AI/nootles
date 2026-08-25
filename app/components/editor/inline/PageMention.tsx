"use client";

import { createReactInlineContentSpec } from "@blocknote/react";
import type { Id } from "@/convex/_generated/dataModel";
import { useCurrentPage, useOpenPageOptional } from "../../OpenPageContext";
import { usePages } from "../../PagesContext";
import { RowIcon, type RowIconValue } from "../../rowIcon";

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
      {/* The page's own icon when it has chosen one, read from the live list
          so it follows a change the way the title does; otherwise the page
          glyph, which is what a chip has always worn. */}
      <RowIcon
        icon={live?.icon as RowIconValue | undefined}
        kind="page"
        className="nt-ref-icon"
      />
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
