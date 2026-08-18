import { createHash } from "node:crypto";
import { generateText, tool } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SHOT_W, shotHeight } from "@/app/components/editor/storyboard/types";
import { AI } from "../aiConfig";
import { generateDiagram } from "../diagram";
import { DEFAULT_DRAW_CHOICE, type DrawChoice } from "../drawStyles";
import { recordAiCall } from "../recordCall";
import { generateVectorDrawing } from "../vectorDraw";
import { reason } from "@/app/lib/github";
import { searchModel } from "./provider";
import { noSuchPage, TOOLS } from "./tools";

/**
 * The agent's tool set as the route declares it.
 *
 * A tool with an `execute` is answered here and the loop keeps going; a tool
 * without one ends the step and streams the call to the browser, which is the
 * only place the document exists as blocks. That asymmetry is the whole design:
 * everything that touches the document runs on one side, everything that only
 * needs the database or the network runs on the other.
 */
export function chatTools(
  projectId: Id<"projects">,
  convex: ConvexHttpClient,
  /** Whether this project has any linked repositories / context files. */
  has: { repos: boolean; files: boolean },
  /**
   * The style the user settled for this turn's drawings. Chosen in the
   * browser — a scene draw pauses for approval, the picker answers it, and
   * the choice rides the resume request's body into here.
   */
  drawStyle: DrawChoice = DEFAULT_DRAW_CHOICE,
) {
  return {
    // Offered only where there is something to point them at. A project with no
    // repository would otherwise carry three tool schemas the model cannot use
    // and, given the chance, will try — the prompt says nothing about them
    // either, so their absence is complete rather than merely discouraged.
    ...(has.repos ? repoTools(projectId, convex) : {}),
    ...(has.files
      ? {
          read_context_file: tool({
            ...TOOLS.read_context_file,
            execute: async ({ name }) => {
              try {
                return await convex.query(api.files.context.read, { projectId, name });
              } catch (error) {
                throw new Error(reason(error, "The file could not be read."));
              }
            },
          }),
        }
      : {}),

    list_pages: tool({
      ...TOOLS.list_pages,
      execute: async () => {
        const pages = await convex.query(api.pages.listByProject, { projectId });
        return pages
          .sort((a, b) => a.order - b.order)
          .map((p) => ({ pageId: p._id, title: p.title, order: p.order }));
      },
    }),

    // No `execute` on purpose — see CLIENT_TOOLS in ./tools.
    read_page: tool(TOOLS.read_page),
    open_page: tool(TOOLS.open_page),
    read_open_page: tool(TOOLS.read_open_page),
    edit_page: tool(TOOLS.edit_page),

    draw: tool({
      ...TOOLS.draw,
      /**
       * The drawing specialist, as a tool. The agent composes and places; the
       * diagram model draws — the same division the completion lane has always
       * had, so a picture gets a whole call's attention instead of a corner of
       * a tool loop's. Costed like every other diagram call, under the same
       * feature, because that is what it is.
       */
      // A scene waits for the user to set its style and artistic level — the
      // picker in the chat answers the approval, and the choice arrives in
      // the resume request's body. A diagram has no style to set: its lane is
      // the LLM, so it runs straight through.
      needsApproval: ({ kind }) => kind !== "diagram",
      execute: async ({ brief, w, h, kind, ratio }) => {
        // A shot's frame is COMPUTED from the board's ratio, never taken from
        // the model's arithmetic. It used to be handed w and h against a table
        // of ratio→height in the prompt, and a board of 16:9 shots came back
        // drawn 569 tall — the 9:16 row — so every picture stood three times
        // its shot and hung out of the frame. The model now names the ratio it
        // can read off the board, and the one place that knows what a shot
        // measures works out the rest.
        const frame = ratio
          ? { w: SHOT_W, h: shotHeight(ratio) }
          : w && h
            ? { w, h }
            : null;
        const scene = kind !== "diagram";

        // The ref is the brief's own fingerprint, which makes drawing
        // IDEMPOTENT — and idempotence is the whole reliability story. A
        // nine-shot salvo routinely loses its slowest calls when the model
        // ends the step early (it likes an edit_page in with the draws, and
        // ending the step ends the request): measured live, four of nine
        // shots died in flight and their retries died the same way. So the
        // work below deliberately ignores the request's abort signal — an
        // orphaned draw finishes and stores anyway — and the retry, hashing
        // the same brief, finds the finished drawing here for free instead
        // of paying the artist twice. The style is part of the fingerprint:
        // the same brief in a different style is a different drawing, not a
        // cache hit on the old one.
        const ref = `d${createHash("sha256")
          .update(
            JSON.stringify([
              brief,
              frame?.w,
              frame?.h,
              kind ?? "scene",
              ...(scene ? [drawStyle.style, drawStyle.artisticLevel] : []),
            ]),
          )
          .digest("hex")
          .slice(0, 10)}`;
        const cached = await convex.query(api.ai.drawings.get, { refs: [ref] });
        if (cached[ref]) {
          return { ref, shapes: (cached[ref].match(/<nt-[a-z]/g) ?? []).length - 1 };
        }

        // Every scene goes to the vector specialist, framed or not — a bare
        // "draw a cat" is as much a picture as a storyboard shot, and an
        // unframed one takes the specialist's document-sized default. Only
        // words-first work rides the LLM lane, whose labels are text. The
        // lanes do NOT substitute for each other: a specialist miss used to
        // fall through to the LLM, which filled boards with pictures not
        // worth keeping — an honest miss the agent can retry (idempotently,
        // for free) beats a bad drawing it will place.
        let html = "";
        if (scene) {
          const vector = await generateVectorDrawing(brief, frame, drawStyle);
          if (!vector) {
            return {
              error:
                "The artist did not answer for this brief. Call draw again " +
                "with the SAME brief — finished work is kept, so a retry " +
                "costs nothing and answers instantly once the drawing lands. " +
                "If it misses twice more, say so honestly and leave the shot " +
                "to its written note.",
            };
          }
          recordAiCall(convex, {
            feature: "diagram",
            model: AI.diagram.vector.model,
            latencyMs: vector.latencyMs,
            status: "ok",
          });
          html = vector.html;
        }
        if (!html) {
          html = await generateDiagram(brief, frame, undefined, ({ usage, latencyMs }) =>
            recordAiCall(convex, {
              feature: "diagram",
              model: AI.diagram.model,
              promptTokens: usage.inputTokens,
              completionTokens: usage.outputTokens,
              cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
              cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
              latencyMs,
              status: "ok",
            }),
          );
        }
        if (!html) {
          return {
            error:
              "Nothing worth drawing came back. Rewrite the brief to describe a " +
              "picture — a subject, an action, a composition — and try once more.",
          };
        }
        // The drawing goes into its own table and the result is a NAME. Not an
        // optimisation — carried in the result, a drawing rides everywhere a
        // message rides: through the model's own step loop (nine shots put
        // 400K tokens into one request — the draw tool executes server-side,
        // so its results re-enter the model INSIDE the request, where the
        // route's transcript stripping never runs), and into a persisted
        // transcript that Convex refused at 2.14MiB. A ref weighs nothing in
        // all three places, and `edit_page` redeems it from the table.
        await convex.mutation(api.ai.drawings.put, { ref, data: html });
        return { ref, shapes: (html.match(/<nt-[a-z]/g) ?? []).length - 1 };
      },
    }),

    search_web: tool({
      ...TOOLS.search_web,
      execute: async ({ query, maxResults }, { abortSignal }) => {
        const { text, sources } = await generateText({
          // Carries the search itself — a request plugin through OpenRouter, a
          // provider-executed tool when Google is called directly.
          ...searchModel(maxResults ?? AI.chat.search.maxResults),
          system: SEARCH_SYSTEM,
          prompt: query,
          abortSignal,
        });
        return {
          answer: text,
          sources: sources
            .filter((s) => s.sourceType === "url")
            .map((s) => ({ title: s.title, url: s.url })),
        };
      },
    }),

    create_page: tool({
      ...TOOLS.create_page,
      execute: async ({ title, afterPageId }) => {
        const after = afterPageId
          ? await ownedPage(convex, projectId, afterPageId)
          : undefined;
        const pageId = await convex.mutation(api.pages.create, {
          projectId,
          title,
          ...(after ? { after: after._id } : {}),
        });
        return { pageId, title };
      },
    }),

    rename_page: tool({
      ...TOOLS.rename_page,
      execute: async ({ pageId, title }) => {
        const page = await ownedPage(convex, projectId, pageId);
        await convex.mutation(api.pages.rename, { pageId: page._id, title });
        return { pageId: page._id, title };
      },
    }),

    delete_page: tool({
      ...TOOLS.delete_page,
      /**
       * The one tool that asks first. The SDK holds the call, streams an
       * approval request to the browser and ends the turn there; the user's
       * answer comes back as the next request and only then does this run —
       * which is why deleting is the one thing the model cannot do by itself.
       */
      needsApproval: true,
      execute: async ({ pageId }) => {
        const page = await ownedPage(convex, projectId, pageId);
        await convex.mutation(api.pages.remove, { pageId: page._id });
        return { pageId: page._id, title: page.title };
      },
    }),
  };
}

/**
 * Reading the project's GitHub repositories.
 *
 * Every one is a call into Convex rather than into GitHub: the token lives on
 * that side and is opened only inside the action, and the action checks the
 * repository is linked to THIS project before it fetches. A model naming a
 * repository is not a model with permission to read it.
 *
 * The failures are worth as much as the results here — "authorise this token
 * for your organisation" is something the agent can tell the user to go and do,
 * where a bare 403 is something it can only apologise for.
 */
function repoTools(projectId: Id<"projects">, convex: ConvexHttpClient) {
  return {
    list_repo_files: tool({
      ...TOOLS.list_repo_files,
      execute: async ({ repo, path, ref }) =>
        await reading(() =>
          convex.action(api.github.read.tree, { projectId, repo, path, ref }),
        ),
    }),

    read_repo_file: tool({
      ...TOOLS.read_repo_file,
      execute: async ({ repo, path, ref }) =>
        await reading(() =>
          convex.action(api.github.read.file, { projectId, repo, path, ref }),
        ),
    }),

    search_repo_code: tool({
      ...TOOLS.search_repo_code,
      execute: async ({ query, repo }) =>
        await reading(() =>
          convex.action(api.github.read.search, { projectId, query, repo }),
        ),
    }),
  };
}

/** The sentence, not the request id — see `reason`. */
async function reading<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new Error(reason(error));
  }
}

/**
 * A page id from the model, resolved against the project this chat belongs to.
 * Convex answers a malformed id with a request id and "Server Error", which
 * reads to a model as an outage rather than as the typo it is — and an id from
 * another project is the same mistake with a worse outcome, since these tools
 * rename and delete.
 */
async function ownedPage(
  convex: ConvexHttpClient,
  projectId: Id<"projects">,
  pageId: string,
) {
  const page = await convex
    .query(api.pages.get, { pageId: pageId as Id<"pages"> })
    .catch(() => null);
  if (!page || page.projectId !== projectId) throw new Error(noSuchPage(pageId));
  return page;
}

/**
 * The searching model reads result pages; it is not the one deciding what to do
 * with them. Dates matter because a page that says "last week" is worthless to
 * a caller reading the answer later.
 */
const SEARCH_SYSTEM = `Answer the question from current web results. Be specific:
name sources, give figures and dates rather than "recently". If the results do not
answer it, say so instead of guessing.`;
