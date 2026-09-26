// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { downloadAttachments, forgetDownloads } from "./download";

/**
 * Attachment downloads against a stand-in for Convex storage (NT-91): the
 * thread is converted on every request, so a picture is asked for again with
 * every step of every later turn.
 */

let server: Server;
let origin: string;
const served: string[] = [];
let failNext = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    served.push(req.url ?? "");
    if (failNext > 0) {
      failNext--;
      res.writeHead(503).end();
      return;
    }
    const size = Number(new URL(req.url ?? "", "http://x").searchParams.get("bytes") ?? 16);
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.alloc(size, 7));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", origin);
  forgetDownloads();
  served.length = 0;
  failNext = 0;
});

const ask = (...paths: string[]) =>
  downloadAttachments(
    paths.map((path) => ({ url: new URL(`${origin}${path}`), isUrlSupportedByModel: false })),
  );

describe("downloadAttachments", () => {
  test("a picture is fetched once however many requests carry it", async () => {
    const [first] = await ask("/api/storage/one");
    // Six more steps of the thread, two of them at once.
    await ask("/api/storage/one");
    await Promise.all([ask("/api/storage/one"), ask("/api/storage/one")]);
    const [again] = await ask("/api/storage/one", "/api/storage/two");

    expect(served).toEqual(["/api/storage/one", "/api/storage/two"]);
    expect(again).toEqual(first);
    expect(first).toEqual({ data: new Uint8Array(16).fill(7), mediaType: "image/png" });
  });

  test("two requests at once share one download", async () => {
    await Promise.all([ask("/api/storage/same"), ask("/api/storage/same")]);
    expect(served).toEqual(["/api/storage/same"]);
  });

  test("a failed read is not kept: the next request tries again", async () => {
    failNext = 1;
    await expect(ask("/api/storage/flaky")).rejects.toThrow(/Could not read the attachment .* \(503\)/);
    const [got] = await ask("/api/storage/flaky");
    expect(got?.data.byteLength).toBe(16);
    expect(served).toEqual(["/api/storage/flaky", "/api/storage/flaky"]);
  });

  test("the oldest pictures go first once the process holds too many", async () => {
    const big = (n: number) => `/api/storage/big${n}?bytes=20000000`;
    await ask(big(1));
    await ask(big(2));
    await ask(big(1)); // used again, so 2 is now the oldest
    await ask(big(3)); // 60 MB held: past the limit, so the oldest goes
    served.length = 0;

    await ask(big(1));
    await ask(big(3));
    expect(served).toEqual([]);
    await ask(big(2));
    expect(served).toEqual([big(2)]);
  });

  test("a URL a provider fetches itself, or one off our storage, is not ours to keep", async () => {
    const [left] = await downloadAttachments([
      { url: new URL(`${origin}/api/storage/one`), isUrlSupportedByModel: true },
    ]);
    expect(left).toBeNull();
    expect(served).toEqual([]);

    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://elsewhere.convex.cloud");
    // The SDK's own download refuses a loopback address, as it always did.
    await expect(ask("/api/storage/one")).rejects.toThrow(/127\.0\.0\.1/);
    expect(served).toEqual([]);
  });
});
