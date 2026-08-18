/**
 * The turn row's luggage compression.
 *
 * A turn's trace holds every op it applied and every block those ops produced
 * — for a drawn storyboard, several copies of each drawing's path data. One
 * three-shot board pushed the row to 1.08MiB, past Convex's value ceiling, and
 * the failed save fired AFTER the edit had applied, so the tool's answer
 * called an applied edit failed and the model dutifully un-did nothing twice.
 * Path data gzips 4-6x, which turns the ceiling from "three drawn shots" into
 * "more board than anyone will make".
 *
 * Old rows hold plain objects; `unpack` passes them through untouched, so no
 * migration and no version stamp — the value's own type is the discriminant.
 */

async function pipe(input: Uint8Array, stream: TransformStream): Promise<ArrayBuffer> {
  const out = new Response(
    new Blob([input as BlobPart]).stream().pipeThrough(stream),
  );
  return await out.arrayBuffer();
}

export async function packTurn(value: unknown): Promise<ArrayBuffer> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return await pipe(bytes, new CompressionStream("gzip"));
}

export async function unpackTurn<T>(stored: unknown): Promise<T> {
  if (!(stored instanceof ArrayBuffer)) return stored as T;
  const bytes = await pipe(new Uint8Array(stored), new DecompressionStream("gzip"));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
