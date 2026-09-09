import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    // Node 26's fetch speaks HTTP/2 wherever a server offers it, and
    // OpenRouter's edge tears a streaming session down mid-turn: every chat
    // call died with ERR_HTTP2_INVALID_SESSION, three retries in a row, on a
    // key their own endpoint accepted. Every lane here ran on HTTP/1.1 for
    // the life of the project; this pins them back to it, for the whole
    // server rather than per call, so no vendor wire has to know.
    const { Agent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new Agent({ allowH2: false }));
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
