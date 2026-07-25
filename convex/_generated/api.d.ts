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
import type * as auth from "../auth.js";
import type * as pages from "../pages.js";
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
  auth: typeof auth;
  pages: typeof pages;
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
