/**
 * Fractional order keys — how sibling order and z-order live in a CRDT map.
 *
 * A list under concurrent editing cannot be an array (concurrent moves
 * duplicate or drop) and cannot be integer indices (an insert renumbers every
 * follower). A fractional key is one LWW value per node: reordering writes
 * ONE key, and two replicas that generate keys deterministically from the
 * same document produce byte-identical maps — which is what lets the lazy
 * migration run on two clients at once with no guard (see binding.ts).
 *
 * Keys are strings over [0-9a-z], compared lexicographically, and never end
 * in '0' (a key ending in '0' would leave no room before it at the same
 * length). Ties are broken by node id at read time, so keys need no jitter.
 */

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A key strictly between `a` and `b` (null = unbounded on that side). */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`keyBetween: ${a} >= ${b}`);
  }
  return mid(a ?? "", b ?? "");
}

function mid(a: string, b: string): string {
  if (b !== "") {
    // Shared prefix stays; the work happens where they differ.
    let n = 0;
    while (n < b.length && (a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + mid(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : DIGITS.indexOf(a[0]);
  const digitB = b === "" ? DIGITS.length : DIGITS.indexOf(b[0]);
  if (digitB - digitA > 1) {
    return DIGITS[Math.round((digitA + digitB) / 2)];
  }
  // Adjacent digits: descend. Below `b` when it has room of its own, else
  // above `a`.
  if (b.length > 1) return b[0] + mid("", b.slice(1));
  return DIGITS[digitA] + mid(a.slice(1), "");
}

/**
 * The key for index `i` when a whole list is laid down at once — pure in `i`,
 * so two replicas populating the same document write the same keys. Spaced
 * out (not adjacent) so later drags between neighbours stay short.
 */
export function keyForIndex(i: number): string {
  // Base-34 digits 1..z (skipping 0 as a final digit and leaving headroom
  // below "1" and above the largest), most significant first, fixed spacing.
  let key = "";
  let n = i;
  do {
    key = DIGITS[(n % 34) + 1] + key;
    n = Math.floor(n / 34) - 1;
  } while (n >= 0);
  // Length-prefix with 'z' runs so longer numbers sort after shorter ones.
  return "z".repeat(key.length - 1) + key;
}

/** Sorts entries by key, ties by id — THE comparator, used everywhere. */
export function byOrder<T extends { order: string; id: string }>(
  a: T,
  b: T,
): number {
  if (a.order < b.order) return -1;
  if (a.order > b.order) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
