import { generateText, tool } from "ai";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AI } from "../aiConfig";
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
 *
 * `token` is the caller's Clerk session token. Convex scopes every row by owner,
 * so a client without it reads an empty project — these tools act as the user,
 * not as the server.
 */
export function chatTools(projectId: Id<"projects">, token: string) {
  const convex = client(token);
  return {
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

function client(token: string) {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
  const convex = new ConvexHttpClient(url);
  convex.setAuth(token);
  return convex;
}
