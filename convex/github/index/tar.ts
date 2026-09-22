import { gunzipSync } from "fflate";

/**
 * A repository tarball, as GitHub's /tarball endpoint hands it over, flattened
 * to its regular files with repo-relative paths.
 *
 * GitHub wraps everything in one `owner-repo-sha/` directory, which says
 * nothing about the repo and would make every path differ between commits, so
 * it is dropped. Anything that is not a plain file — directories, links,
 * devices — carries no source to index.
 */
export function untar(gz: Uint8Array): { path: string; data: Uint8Array }[] {
  const tar = gunzipSync(gz);
  const out: { path: string; data: Uint8Array }[] = [];
  let longName: string | null = null;
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = sizeOf(header);
    const start = offset + BLOCK;
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    const type = String.fromCharCode(header[156]);
    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === "L") {
      longName = cString(data, 0, data.length);
      continue;
    }
    if (type === "g") continue;

    const name = longName ?? ustarName(header);
    longName = null;
    if (type !== "0" && type !== "\0") continue;

    const path = repoPath(name);
    if (path) out.push({ path, data: data.slice() });
  }
  return out;
}

const BLOCK = 512;
const decoder = new TextDecoder();

function ustarName(header: Uint8Array): string {
  const name = cString(header, 0, 100);
  const isUstar = cString(header, 257, 6).startsWith("ustar");
  const prefix = isUstar ? cString(header, 345, 155) : "";
  return prefix ? `${prefix}/${name}` : name;
}

function sizeOf(header: Uint8Array): number {
  // Base-256 is how GNU tar writes sizes that overflow eleven octal digits.
  if (header[124] & 0x80) {
    let size = header[124] & 0x7f;
    for (let i = 125; i < 136; i++) size = size * 256 + header[i];
    return size;
  }
  const digits = cString(header, 124, 12).trim();
  return digits ? parseInt(digits, 8) : 0;
}

function cString(bytes: Uint8Array, start: number, length: number): string {
  let end = start;
  while (end < start + length && end < bytes.length && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(start, end));
}

/** Pax records are `<length> <key>=<value>\n`, the length counting itself. */
function paxPath(data: Uint8Array): string | null {
  let path: string | null = null;
  let at = 0;
  while (at < data.length) {
    let space = at;
    while (space < data.length && data[space] !== 0x20) space++;
    const length = parseInt(decoder.decode(data.subarray(at, space)), 10);
    if (!length || space >= data.length) break;
    const record = decoder.decode(data.subarray(space + 1, at + length - 1));
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    at += length;
  }
  return path;
}

function repoPath(name: string): string | null {
  const segments = name.split("/").filter((s) => s && s !== ".");
  if (segments.length < 2) return null;
  if (segments.includes("..")) return null;
  return segments.slice(1).join("/");
}
