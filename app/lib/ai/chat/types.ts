import type { UIMessage } from "ai";
import type { Id } from "@/convex/_generated/dataModel";
import type { AbDataParts } from "./parts";

/** Which tools the server may offer this turn. */
export type ChatMode = "agent" | "ask";

/**
 * Travels with each message and is persisted alongside it.
 *
 * `pageIdAtSend` is what makes "@current-page" resolvable after the fact: the
 * open page moves as the agent works, so a mention has to record which page it
 * meant at the moment it was sent.
 */
export type AbMetadata = {
  pageIdAtSend?: Id<"pages">;
  mode?: ChatMode;
  /** Links a turn to its checkpoints and op-log rows. */
  chatPromptId?: string;
};

export type AbMessage = UIMessage<AbMetadata, AbDataParts>;
