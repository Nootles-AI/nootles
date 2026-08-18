import { generateText, tool } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AI } from "../aiConfig";
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

    search_web: tool({
      ...TOOLS.search_web,
      execute: async ({ query, maxResults }, { abortSignal }) => {
        const { text, sources } = await generateText({
          model: searchModel(),
          system: SEARCH_SYSTEM,
          prompt: query,
          providerOptions: {
            openrouter: {
              plugins: [
                { id: "web", max_results: maxResults ?? AI.chat.search.maxResults },
              ],
            },
          },
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
