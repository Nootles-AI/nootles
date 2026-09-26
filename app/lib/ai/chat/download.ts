import { createDownload, type Experimental_DownloadFunction } from "ai";

/**
 * Fetching the files a message carries, on the way to the model.
 *
 * The SDK refuses to fetch a private or loopback address, which is right for a
 * URL it was handed by a model and wrong for the only one it will ever see here:
 * an attachment lives in our own Convex deployment, and in development that
 * deployment is `http://127.0.0.1:3210` — so an attached image would fail every
 * turn it appeared in (measured: `AI_DownloadError: URL with IP address
 * 127.0.0.1 is not allowed`).
 *
 * The exception is exactly this deployment's origin, which is our configuration
 * rather than anyone's input. Every other URL keeps the default protection.
 */
const fetchFile = createDownload();

export const downloadAttachments: Experimental_DownloadFunction = (requests) =>
  Promise.all(
    requests.map(async (request) => {
      // Null leaves the URL alone for a provider that can fetch it itself.
      if (request.isUrlSupportedByModel) return null;
      if (!isOurStorage(request.url)) return await fetchFile(request);
      return await fromStorage(request.url);
    }),
  );

type Downloaded = { data: Uint8Array; mediaType: string | undefined };

/**
 * Attachments this process has already downloaded, by URL, oldest first.
 *
 * The whole thread is converted on every request, and a turn is one request per
 * browser tool it calls — so a picture attached three turns ago was fetched from
 * storage again before every step since, holding up the model's first token
 * each time (NT-91). A storage URL names one immutable file, so the bytes never
 * go stale; kept per process, a warm instance answers the rest of the turn, and
 * the thread's later ones, without the round trip.
 */
const kept = new Map<string, Promise<Downloaded>>();
const sizes = new Map<string, number>();
let keptBytes = 0;

/** Enough for a few busy threads' pictures; `attachments.maxBytes` is 3.5 MB each. */
const KEEP_BYTES = 48_000_000;

function fromStorage(url: URL): Promise<Downloaded> {
  const key = url.href;
  const hit = kept.get(key);
  if (hit) {
    // Most recently used goes to the back of the line.
    kept.delete(key);
    kept.set(key, hit);
    return hit;
  }
  const download = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not read the attachment at ${url} (${response.status}).`);
    }
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      mediaType: response.headers.get("content-type") ?? undefined,
    };
  })();
  kept.set(key, download);
  download.then(
    ({ data }) => {
      if (kept.get(key) !== download) return;
      sizes.set(key, data.byteLength);
      keptBytes += data.byteLength;
      evict();
    },
    // A failed read is not kept: the next request tries again.
    () => {
      if (kept.get(key) === download) kept.delete(key);
    },
  );
  return download;
}

function evict() {
  for (const key of kept.keys()) {
    if (keptBytes <= KEEP_BYTES) return;
    const size = sizes.get(key);
    // Still downloading: nothing to free yet, and a request is waiting on it.
    if (size === undefined) continue;
    kept.delete(key);
    sizes.delete(key);
    keptBytes -= size;
  }
}

/** Forgets every download. For tests. */
export function forgetDownloads() {
  kept.clear();
  sizes.clear();
  keptBytes = 0;
}

function isOurStorage(url: URL): boolean {
  const convex = process.env.NEXT_PUBLIC_CONVEX_URL;
  return !!convex && url.origin === new URL(convex).origin;
}
