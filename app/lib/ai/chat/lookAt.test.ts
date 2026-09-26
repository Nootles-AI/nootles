import { describe, expect, test } from "vitest";
import { convertToModelMessages, tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { lookAtOutput, PICTURES_MOVED_ON, PICTURE_NOT_SENT } from "./lookAt";
import { forStorage } from "./storedParts";
import { shortenStaleParts, shortenStaleReads, stripDrawings } from "./transcript";
import type { AbMessage } from "./types";

/**
 * What `look_at` sends, keeps and resends (NT-91).
 *
 * The route's conversion is exercised the way the route runs it — the real
 * `convertToModelMessages` with a `look_at` whose `toModelOutput` is the real
 * one — so "the model sees a picture" is checked on the model messages, not on
 * a helper's return value.
 */

const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const looked = (...handles: string[]) => ({
  images: handles.map((handle) => ({
    handle,
    dataUri: `data:image/webp;base64,${PIXEL}`,
    mediaType: "image/webp",
  })),
});

const tools: ToolSet = {
  look_at: tool({
    inputSchema: z.object({ blockId: z.string(), items: z.array(z.string()) }),
    toModelOutput: ({ output }) => lookAtOutput(output),
  }),
};

type Part = AbMessage["parts"][number];
let serial = 0;
const call = (name: string, output: unknown, input: unknown = {}): Part =>
  ({ type: `tool-${name}`, toolCallId: `c${++serial}`, state: "output-available", input, output }) as unknown as Part;
const user = (text: string): AbMessage => ({ id: `u${++serial}`, role: "user", parts: [{ type: "text", text }] });
const answer = (...parts: Part[]): AbMessage => ({
  id: `a${++serial}`,
  role: "assistant",
  parts: [{ type: "step-start" }, ...parts, { type: "text", text: "Done." }],
});

/** The route's pipeline from the posted thread to what the model is sent. */
async function modelSees(messages: AbMessage[]): Promise<ModelMessage[]> {
  return stripDrawings(
    shortenStaleReads(await convertToModelMessages<AbMessage>(messages, { ignoreIncompleteToolCalls: true, tools })),
  );
}

const results = (messages: ModelMessage[]) =>
  messages.flatMap((m) => (m.role === "tool" ? m.content : [])).filter((p) => p.type === "tool-result");

describe("lookAtOutput", () => {
  test("each picture follows its handle as a file part", () => {
    expect(lookAtOutput(looked("a1", "b2"))).toEqual({
      type: "content",
      value: [
        { type: "text", text: "a1:" },
        { type: "file", data: { type: "data", data: PIXEL }, mediaType: "image/webp" },
        { type: "text", text: "b2:" },
        { type: "file", data: { type: "data", data: PIXEL }, mediaType: "image/webp" },
      ],
    });
  });

  test("a stored copy without its bytes is words, never an empty picture", () => {
    expect(lookAtOutput({ images: [{ handle: "a1", mediaType: "image/webp" }] })).toEqual({
      type: "text",
      value: `a1: ${PICTURE_NOT_SENT}\n${PICTURES_MOVED_ON}`,
    });
  });

  test("bytes cut short when a thread was saved are not sent as a picture", () => {
    // What `forStorage`'s cap made of a data URI before NT-91.
    const cut = `data:image/webp;base64,${PIXEL.slice(0, 40)}\n<!-- cut when the thread was saved: 812345 characters -->`;
    const output = lookAtOutput({
      images: [{ handle: "a1", dataUri: cut, mediaType: "image/webp" }, looked("b2").images[0]],
    });
    expect(output).toEqual({
      type: "content",
      value: [
        { type: "text", text: "a1:" },
        { type: "text", text: PICTURE_NOT_SENT },
        { type: "text", text: "b2:" },
        { type: "file", data: { type: "data", data: PIXEL }, mediaType: "image/webp" },
      ],
    });
  });

  test("a refusal is its message, and text that already replaced the result stays text", () => {
    expect(lookAtOutput({ images: [], error: "No album." })).toEqual({ type: "text", value: "No album." });
    expect(lookAtOutput("already words")).toEqual({ type: "text", value: "already words" });
  });
});

describe("a look_at in the thread", () => {
  test("reaches the model as pictures while its turn runs, and as a notice in every later one", async () => {
    const earlier = [user("What does the sign in a1 say?"), answer(call("look_at", looked("a1", "b2")))];
    const live = await modelSees([...earlier.slice(0, 1), { ...earlier[1], parts: earlier[1].parts.slice(0, 2) }]);
    expect(results(live)[0].output).toMatchObject({
      type: "content",
      value: [{ type: "text", text: "a1:" }, { type: "file", mediaType: "image/webp" }, { type: "text", text: "b2:" }, { type: "file" }],
    });

    const later = await modelSees([...earlier, user("And the colour of b2?")]);
    expect(results(later)[0].output).toEqual({
      type: "text",
      value: `a1: ${PICTURE_NOT_SENT} b2: ${PICTURE_NOT_SENT}\n${PICTURES_MOVED_ON}`,
    });
  });

  test("is saved without its bytes, handles kept", () => {
    const [saved] = forStorage([call("look_at", looked("a1"))]) as unknown as { output: unknown }[];
    expect(saved.output).toEqual({ images: [{ handle: "a1", mediaType: "image/webp" }] });
  });
});

describe("shortenStaleParts: the thread the browser POSTs", () => {
  const page = `<h1>Launch plan</h1>\n${"<p>The rover launches on Friday.</p>\n".repeat(600)}`;
  const report = {
    diagram: { w: 4000, h: 3000 },
    nodes: Array.from({ length: 120 }, (_, i) => ({ id: `r${i}`, x: i * 10, y: i * 5, w: 200, h: 80 })),
  };
  const drawing = { ref: "d3", html: `<nt-diagram>${"<nt-path d='M0 0L1 1'/>".repeat(900)}</nt-diagram>` };

  const thread = (): AbMessage[] => [
    user("Plan the launch"),
    answer(
      call("read_open_page", page),
      call("get_geometry", report, { blockId: "d1" }),
      call("look_at", looked("a1", "b2"), { blockId: "al", items: ["a1", "b2"] }),
      call("draw", drawing, { subject: "rover" }),
      call("search_web", "Results: " + "x".repeat(4000), { query: "rover" }),
    ),
    user("Now tighten it"),
    answer(call("read_open_page", page), call("look_at", looked("c3"))),
  ];

  test("is what the route would have made of it: the model reads the same words either way", async () => {
    const posted = thread();
    const whole = await modelSees(posted);
    const trimmed = await modelSees(shortenStaleParts(posted));
    expect(trimmed).toEqual(whole);
  });

  test("is a fraction of the size, and leaves the turn in flight whole", () => {
    const whole = thread();
    const trimmed = shortenStaleParts(whole);
    // The earlier turn: a page, a board, two pictures and a drawing.
    expect(JSON.stringify(trimmed[1]).length * 5).toBeLessThan(JSON.stringify(whole[1]).length);

    const [, before, , current] = trimmed;
    const outputs = before.parts.flatMap((p) => ("output" in p ? [p.output] : []));
    expect(outputs[0]).toMatch(/^<h1>Launch plan<\/h1>[\s\S]*the page has changed since/);
    expect(outputs[1]).toMatch(/^\{"diagram":\{"w":4000,"h":3000\},"nodes":\[.*Ask for it again/);
    expect(outputs[2]).toBe(`a1: ${PICTURE_NOT_SENT} b2: ${PICTURE_NOT_SENT}\n${PICTURES_MOVED_ON}`);
    expect(outputs[3]).toEqual({ ref: "d3" });
    // A search stays true, and costs a call to get back: never shortened.
    expect(outputs[4]).toBe("Results: " + "x".repeat(4000));

    // The turn in flight: the page it just read and the picture it just asked for.
    expect(current).toEqual(whole[3]);
  });

  test("leaves the panel's own messages untouched", () => {
    const whole = thread();
    const before = JSON.stringify(whole);
    shortenStaleParts(whole);
    expect(JSON.stringify(whole)).toBe(before);
  });
});
