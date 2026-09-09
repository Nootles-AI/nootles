import { clerkClient } from "@clerk/nextjs/server";
import { ConvexHttpClient, type HttpMutationOptions } from "convex/browser";
import type {
  ArgsAndOptions,
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
} from "convex/server";

/**
 * A Convex client that reads and writes AS the caller.
 *
 * `token` is their Clerk session token. Convex scopes every row by owner, so a
 * client without it reads an empty project — the routes act on the user's data
 * as the user, never as the server.
 */
export function asUser(token: string): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
  const convex = new ConvexHttpClient(url);
  convex.setAuth(token);
  return convex;
}

/**
 * A Clerk session token is minted for sixty seconds; this is how long one is
 * trusted before the next call re-mints. Well inside the minute, so a call
 * that starts on a token nearly spent does not arrive on one already dead.
 */
const TOKEN_SAFE_MS = 40_000;

/**
 * A client that stays the caller for as long as the request runs.
 *
 * `asUser` above holds one token, and a token lives a minute — long enough
 * for every lane but the chat loop, whose one request can read a design
 * board and write a screen back over more than that. Every Convex call made
 * past the minute was refused, silently: the cost ledger lost the turn, and a
 * drawing stored after a slow artist would be lost the same way. This client
 * mints a fresh token from the session, through Clerk's backend, before any
 * call made on one too old — so every call goes out as the user, whatever
 * the clock says. Never as the server: the rows it writes are still theirs.
 */
export function asSession(session: { token: string; sessionId: string }): ConvexHttpClient {
  return new SessionClient(session.token, session.sessionId);
}

class SessionClient extends ConvexHttpClient {
  private mintedAt = Date.now();
  private minting: Promise<void> | null = null;

  constructor(
    token: string,
    private readonly sessionId: string,
  ) {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
    super(url);
    this.setAuth(token);
  }

  private fresh(): Promise<void> {
    if (Date.now() - this.mintedAt < TOKEN_SAFE_MS) return Promise.resolve();
    // One mint for however many calls are waiting on it.
    this.minting ??= (async () => {
      try {
        const { jwt } = await (await clerkClient()).sessions.getToken(this.sessionId);
        this.setAuth(jwt);
        this.mintedAt = Date.now();
      } finally {
        this.minting = null;
      }
    })();
    return this.minting;
  }

  override async query<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>> {
    await this.fresh();
    return super.query(query, ...args);
  }

  override async mutation<Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    ...args: ArgsAndOptions<Mutation, HttpMutationOptions>
  ): Promise<FunctionReturnType<Mutation>> {
    await this.fresh();
    return super.mutation(mutation, ...args);
  }

  override async action<Action extends FunctionReference<"action">>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<FunctionReturnType<Action>> {
    await this.fresh();
    return super.action(action, ...args);
  }
}
