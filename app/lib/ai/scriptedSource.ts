/**
 * A stand-in for the model, used only by the first-run guide.
 *
 * The guide's first two beats have to land exactly, every time: a completion
 * that arrives slow, or arrives good but different, spends the one impression
 * the product gets. So those two are scripted — but scripted at the NETWORK,
 * not in the UI. What comes back from here is an ordinary `Response` carrying
 * an ordinary text stream, so it travels the real completion path: the same
 * ghost-text plugin, the same diagram preview, the same Tab handler, the same
 * accept that writes the same operations. Nothing downstream can tell.
 *
 * Registered as a module-level handler rather than through context, matching
 * `setActionApplyHandler` in `ghostText.ts` — the completion effect reads it at
 * call time, and a context value would re-run that effect on every change.
 */

export type ScriptRequest =
  | { lane: "complete"; before: string; after: string }
  | { lane: "diagram"; brief: string };

/** Returns a scripted response, or null to let the real model answer. */
export type CompletionSource = (req: ScriptRequest) => Response | null;

let source: CompletionSource | null = null;

export function setCompletionSource(fn: CompletionSource | null) {
  source = fn;
  // Logged at `log` rather than `debug` on purpose: DevTools files `debug`
  // under Verbose and hides it by default, which turns "the guide never ran"
  // and "the guide ran fine" into the same empty console.
  console.log("[nt-tour]", fn ? "guide is driving" : "guide stood down");
}

/** Whether the guide is currently driving — used to scope its own tracing. */
export function scriptedActive(): boolean {
  return source !== null;
}

export function scriptedResponse(req: ScriptRequest): Response | null {
  if (!source) return null;
  try {
    const res = source(req);
    trace(req.lane === "diagram" ? "diagram" : "complete", res !== null, req);
    return res;
  } catch (error) {
    // A broken script must never take the real completion lane down with it.
    trace("threw", false, req, error);
    return null;
  }
}

/**
 * Says what the guide was asked for and whether it answered.
 *
 * Only ever reached while a tour is running, so this is not logging on a hot
 * path — and the two lanes hand off to each other through the completion
 * grammar, which means "the diagram never came" and "the diagram was asked for
 * and then dropped" look identical from the outside. They are not the same
 * bug, and this is the line that tells them apart.
 */
function trace(what: string, answered: boolean, req: ScriptRequest, error?: unknown) {
  const detail =
    req.lane === "diagram"
      ? { brief: req.brief }
      : { tail: req.before.slice(-90) };
  console.log("[nt-tour]", what, answered ? "scripted" : "passed through", detail, error ?? "");
}

/**
 * `text`, as a stream that arrives the way a model's does.
 *
 * Pull-driven: a chunk is produced only when the consumer asks for one, so a
 * completion the user has already moved past stops costing anything the moment
 * the reader is dropped — there is no timer left running behind it.
 *
 * The jitter is not decoration. A perfectly even stream reads as a progress
 * bar; real token arrival is uneven, and it is the unevenness that makes this
 * look like generation rather than playback.
 */
export function pacedStream(text: string, perChunkMs = 26): Response {
  const chunks = tokenize(text);
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const jitter = 0.6 + Math.random() * 0.9;
      await sleep(perChunkMs * jitter);
      controller.enqueue(new TextEncoder().encode(chunks[i++]));
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Split the way a tokenizer would: a word and the space in front of it travel
 * together. Splitting on characters looks like a typewriter, which is a
 * different effect and a slower one.
 */
function tokenize(text: string): string[] {
  return text.match(/\s*\S+|\s+/g) ?? [text];
}

/**
 * Markup streams in bigger pieces than prose does — a shape at a time rather
 * than a word at a time, which is what makes a diagram look like it is being
 * drawn rather than typed.
 */
export function pacedMarkup(html: string, perLineMs = 90): Response {
  const lines = html.split(/(?<=\n)/);
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= lines.length) {
        controller.close();
        return;
      }
      await sleep(perLineMs * (0.7 + Math.random() * 0.7));
      controller.enqueue(new TextEncoder().encode(lines[i++]));
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
