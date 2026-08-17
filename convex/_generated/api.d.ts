/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as ai_calls from "../ai/calls.js";
import type * as ai_checkpoints from "../ai/checkpoints.js";
import type * as ai_context from "../ai/context.js";
import type * as ai_opLog from "../ai/opLog.js";
import type * as ai_operations from "../ai/operations.js";
import type * as ai_questions from "../ai/questions.js";
import type * as ai_suggestions from "../ai/suggestions.js";
import type * as albums from "../albums.js";
import type * as auth from "../auth.js";
import type * as chat_attachments from "../chat/attachments.js";
import type * as chat_messages from "../chat/messages.js";
import type * as chat_threads from "../chat/threads.js";
import type * as chat_turns from "../chat/turns.js";
import type * as counters from "../counters.js";
import type * as crons from "../crons.js";
import type * as devSeed from "../devSeed.js";
import type * as feedback from "../feedback.js";
import type * as github_account from "../github/account.js";
import type * as github_read from "../github/read.js";
import type * as github_repos from "../github/repos.js";
import type * as github_rest from "../github/rest.js";
import type * as github_seal from "../github/seal.js";
import type * as migrations from "../migrations.js";
import type * as onboarding from "../onboarding.js";
import type * as pages from "../pages.js";
import type * as presence from "../presence.js";
import type * as profiles from "../profiles.js";
import type * as projects from "../projects.js";
import type * as prosemirror from "../prosemirror.js";
import type * as prs from "../prs.js";
import type * as share from "../share.js";
import type * as surveys from "../surveys.js";
import type * as tickets from "../tickets.js";
import type * as ydoc from "../ydoc.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  "ai/calls": typeof ai_calls;
  "ai/checkpoints": typeof ai_checkpoints;
  "ai/context": typeof ai_context;
  "ai/opLog": typeof ai_opLog;
  "ai/operations": typeof ai_operations;
  "ai/questions": typeof ai_questions;
  "ai/suggestions": typeof ai_suggestions;
  albums: typeof albums;
  auth: typeof auth;
  "chat/attachments": typeof chat_attachments;
  "chat/messages": typeof chat_messages;
  "chat/threads": typeof chat_threads;
  "chat/turns": typeof chat_turns;
  counters: typeof counters;
  crons: typeof crons;
  devSeed: typeof devSeed;
  feedback: typeof feedback;
  "github/account": typeof github_account;
  "github/read": typeof github_read;
  "github/repos": typeof github_repos;
  "github/rest": typeof github_rest;
  "github/seal": typeof github_seal;
  migrations: typeof migrations;
  onboarding: typeof onboarding;
  pages: typeof pages;
  presence: typeof presence;
  profiles: typeof profiles;
  projects: typeof projects;
  prosemirror: typeof prosemirror;
  prs: typeof prs;
  share: typeof share;
  surveys: typeof surveys;
  tickets: typeof tickets;
  ydoc: typeof ydoc;
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
