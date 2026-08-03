/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai_checkpoints from "../ai/checkpoints.js";
import type * as ai_context from "../ai/context.js";
import type * as ai_opLog from "../ai/opLog.js";
import type * as ai_operations from "../ai/operations.js";
import type * as ai_suggestions from "../ai/suggestions.js";
import type * as auth from "../auth.js";
import type * as chat_attachments from "../chat/attachments.js";
import type * as chat_messages from "../chat/messages.js";
import type * as chat_threads from "../chat/threads.js";
import type * as chat_turns from "../chat/turns.js";
import type * as pages from "../pages.js";
import type * as preview from "../preview.js";
import type * as projects from "../projects.js";
import type * as prosemirror from "../prosemirror.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "ai/checkpoints": typeof ai_checkpoints;
  "ai/context": typeof ai_context;
  "ai/opLog": typeof ai_opLog;
  "ai/operations": typeof ai_operations;
  "ai/suggestions": typeof ai_suggestions;
  auth: typeof auth;
  "chat/attachments": typeof chat_attachments;
  "chat/messages": typeof chat_messages;
  "chat/threads": typeof chat_threads;
  "chat/turns": typeof chat_turns;
  pages: typeof pages;
  preview: typeof preview;
  projects: typeof projects;
  prosemirror: typeof prosemirror;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  prosemirrorSync: import("@convex-dev/prosemirror-sync/_generated/component.js").ComponentApi<"prosemirrorSync">;
};
