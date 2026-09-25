"use client";

import { createReactInlineContentSpec } from "@blocknote/react";
import { PageChip } from "../../PageChip";

export { pageTitle } from "../../PageChip";

/**
 * "@Page" in the document — the chip that names another page and opens it on
 * click. The chip itself is `PageChip`, shared with the chat's replies.
 */
export const pageMentionSpec = createReactInlineContentSpec(
  {
    type: "pageMention",
    propSchema: { pageId: { default: "" }, title: { default: "" } },
    content: "none",
  },
  {
    render: (props) => (
      <PageChip
        pageId={props.inlineContent.props.pageId}
        title={props.inlineContent.props.title}
      />
    ),
  },
);
