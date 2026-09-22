import type { z } from "zod";
import type { TOOLS, ToolName } from "@/app/lib/ai/chat/tools";

/**
 * What a staged call is made of.
 *
 * The demo's answers are written ahead of time; everything they DO is real.
 * A script is therefore written in the model's own vocabulary — text and tool
 * calls — and handed to `streamText` as a model. Nothing below that boundary
 * knows the difference, which is the whole point: the tool loop runs, the
 * client tools mutate the document, the turn is persisted, and the next turn
 * (staged or real) reads all of it back as ordinary history.
 */

export type ToolInput<N extends ToolName> = z.infer<(typeof TOOLS)[N]["inputSchema"]>;

/** A tool result already gathered in THIS turn, oldest first. */
export type StageResult = { toolName: string; output: unknown };

/**
 * What a resolver may look at.
 *
 * Deliberately small and all of it cheap: the pages come from one Convex query
 * and everything else is already in the request. Anything a script needs to
 * know about the DOCUMENT it learns the way the agent would — by calling
 * `read_open_page` in an earlier step and reading the result out of `results`.
 */
export type StageContext = {
  projectId: string;
  /** The page open in the editor when the message was sent. */
  pageId?: string;
  /** What the user actually typed, trimmed. */
  said: string;
  results: StageResult[];
  pages: { pageId: string; title: string }[];
};

/**
 * One tool call in a script.
 *
 * `input` is typed by that tool's own Zod schema, so a malformed `edit_page`
 * is a `tsc` failure rather than a dead moment in front of a room. It may be a
 * literal or a function of the live context — returning `null` from a resolver
 * means "the thing I was going to act on is not there", and the script bails
 * to prose instead of emitting a call against something that does not exist.
 *
 * There is deliberately no way to can a tool's OUTPUT. Every tool in these
 * seventeen calls runs for real — the repo reads hit the team's GitHub, the
 * page reads hit the live editor, the edits go through the applier. A canned
 * result would be fiction sitting in the transcript for the real model to
 * believe the moment the presenter goes off script, and the demo does not need
 * one: no call here uses a paid or networked tool.
 */
export type StagedCall = {
  [N in ToolName]: {
    tool: N;
    input: ToolInput<N> | ((ctx: StageContext) => ToolInput<N> | null);
    /**
     * A call worth making if it can be made, and not worth bailing over.
     * C-05 reads a test page that a project may legitimately not have — and
     * "there is no test page" is an answer, not a failure.
     */
    optional?: true;
  };
}[ToolName];

export type StagedStep = {
  /** Said before the calls, if any. */
  say?: string;
  call?: StagedCall[];
  /** Thinking time before this step's first token. */
  delayMs?: number;
};

export type StagedScript = {
  /** "C-16". Also the ledger's model id, as `staged/C-16`. */
  id: string;
  title: string;
  /**
   * Tolerant on wording, exclusive on subject.
   *
   * Every regex here keys on the distinctive NOUN rather than the verb —
   * "power path", "critical path", "FMEA", "ICD", "wireframe" — because the
   * verb is what a presenter varies ("draw" / "diagram" / "map out" / "can you
   * show me") and the noun is what they keep. `says` is the proof: the test
   * asserts every phrase in it routes to this script and to no other.
   */
  match: RegExp;
  /** Matched `match` but also this → not this script. Separates near neighbours. */
  not?: RegExp;
  /** Phrasings that MUST land here. The regression corpus, not documentation. */
  says: string[];
  steps: StagedStep[];
  /** Said instead when a resolver returns null. */
  bail?: string;
};
