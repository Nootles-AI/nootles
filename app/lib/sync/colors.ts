/**
 * Presence identity: the colour — and, for a signed-out reader, the name —
 * a person wears on every surface at once: text carets, canvas ghosts, the
 * facepile. Stable per person, so "the green one is Sam" survives a reload.
 *
 * Deliberately not the accent: amber means AI activity, and these mean
 * people. Muted mid-lightness tones, no saturated primaries.
 *
 * Two things fix the exact values. Every entry is exactly `#rrggbb`, because
 * y-prosemirror validates cursor colours against that shape and builds the
 * selection tint by appending alpha digits to it. And every entry clears
 * 4.5:1 against the page, because the name flags and canvas labels painted on
 * these are 10px text in the paper colour.
 */
const PALETTE = [
  "#69774f", // moss
  "#786b98", // heather
  "#53797a", // teal slate
  "#92657c", // rosewood
  "#7f7054", // tobacco
  "#577497", // dusk blue
  "#946856", // clay
  "#607860", // sage
];

function hash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function collabColor(key: string): string {
  return PALETTE[hash(key) % PALETTE.length];
}

/**
 * More names than colours, and drawn on a different turn of the hash, so two
 * guests who happen to land on one colour are still two people.
 */
const GUEST_NAMES = [
  "Otter",
  "Heron",
  "Marten",
  "Kestrel",
  "Hare",
  "Ibis",
  "Lynx",
  "Wren",
  "Badger",
  "Curlew",
  "Ermine",
  "Plover",
];

const GUEST_KEY = "nt:guest";
let guestKeyCache: string | null = null;

/**
 * `crypto.randomUUID` is a secure-context API — absent over plain http, which
 * is how a shared link gets opened on a LAN. Nothing here is a secret; it only
 * has to differ from the other guest in the room.
 */
function randomKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function guestKey(): string {
  if (guestKeyCache) return guestKeyCache;
  // Rendered on the server, nobody holds a caret yet; the browser decides.
  if (typeof window === "undefined") return "guest";
  try {
    const stored = sessionStorage.getItem(GUEST_KEY);
    if (stored) return (guestKeyCache = stored);
    const fresh = randomKey();
    sessionStorage.setItem(GUEST_KEY, fresh);
    return (guestKeyCache = fresh);
  } catch {
    // Storage refused (private mode, third-party embedding): the identity
    // lasts this page load instead of this tab, which is still one person.
    return (guestKeyCache = randomKey());
  }
}

/**
 * Who a signed-out reader is to everyone else. Hashing the document instead —
 * the obvious shortcut — gives every guest on a page one name and one colour,
 * which is the same as showing nobody. The tab is the person: reload keeps
 * you, a second tab is honestly a second reader.
 */
export function guestIdentity(): { name: string; color: string } {
  const key = guestKey();
  return {
    name: `Anonymous ${GUEST_NAMES[hash(`${key}:name`) % GUEST_NAMES.length]}`,
    color: collabColor(key),
  };
}
