import type { UIMessage } from "ai";
import type { Id } from "@/convex/_generated/dataModel";
import type { ReadyAttachment } from "./attachments";
import type { MentionPick } from "./mentions";
import type { AbDataParts } from "./parts";

/**
 * Travels with each message and is persisted alongside it.
 *
 * `pageIdAtSend` is what makes "@current-page" resolvable after the fact: the
 * open page moves as the agent works, so a mention has to record which page it
 * meant at the moment it was sent.
 */
export type AbMetadata = {
  pageIdAtSend?: Id<"pages">;
  /** Links a turn to its checkpoints and op-log rows. */
  chatPromptId?: string;
};

export type AbMessage = UIMessage<AbMetadata, AbDataParts>;

/** What the composer hands over: the words, and what was attached to them. */
export type ChatDraft = {
  text: string;
  attachments: ReadyAttachment[];
  mentions: MentionPick[];
};

/**
 * A draft written while a turn was running, waiting for it to end.
 *
 * Still a draft rather than a message: nothing about it is decided until it is
 * sent, so its mentions are resolved and its page recorded when the queue
 * reaches it, against the document the answer has just finished changing.
 */
export type QueuedDraft = { id: string; draft: ChatDraft };
