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

      const response = await fetch(request.url);
      if (!response.ok) {
        throw new Error(`Could not read the attachment at ${request.url} (${response.status}).`);
      }
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        mediaType: response.headers.get("content-type") ?? undefined,
      };
    }),
  );

function isOurStorage(url: URL): boolean {
  const convex = process.env.NEXT_PUBLIC_CONVEX_URL;
  return !!convex && url.origin === new URL(convex).origin;
}
