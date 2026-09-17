import { POWER_PATH } from "./scenes";
import { STAGED_DIAGRAM_BRIEF } from "./tab";

/**
 * T-10's half of the Tab lane, staged at the route.
 *
 * The completion itself is painted client-side — `tourDrive` explains at length
 * why scripting that at the network layer does not survive contact with the
 * gates. Diagram expansion has no such gates: it is one request, it cannot be
 * withdrawn, and staging it here means the canvas lands through the real adopt
 * and serialize path into Yjs rather than being painted on top of the document.
 *
 * Streamed line by line because the caller draws what has arrived so far. A
 * board that appears whole is a picture; a board that builds itself is the
 * point of the beat.
 */

export function stagedDiagram(brief: string): Response | null {
  if (process.env.STAGED_DEMO !== "1") return null;
  if (!STAGED_DIAGRAM_BRIEF.test(brief)) return null;

  const lines = POWER_PATH.split("\n");
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const [i, line] of lines.entries()) {
          controller.enqueue(encoder.encode(i === 0 ? line : `\n${line}`));
          // A shape every ~90 ms, unevenly. The unevenness is what stops it
          // reading as a progress bar.
          await new Promise((done) => setTimeout(done, 70 + Math.random() * 60));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}
