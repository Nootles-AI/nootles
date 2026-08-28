/**
 * Claimable surfaces by block id — how a focus restore finds the diagram or
 * the place card it is bringing back, including one on a page that had to be
 * navigated to first (the block mounts a beat after the page opens).
 */

const surfaces = new Map<string, () => void>();
const waiters = new Map<string, Set<(claim: () => void) => void>>();

/** How long a navigated-to block gets to mount before a restore gives up. */
const MOUNT_MS = 5000;

export function registerSurface(blockId: string, claim: () => void): () => void {
  surfaces.set(blockId, claim);
  const waiting = waiters.get(blockId);
  if (waiting) {
    waiters.delete(blockId);
    for (const wake of waiting) wake(claim);
  }
  return () => {
    if (surfaces.get(blockId) === claim) surfaces.delete(blockId);
  };
}

export function awaitSurface(blockId: string): Promise<(() => void) | null> {
  const held = surfaces.get(blockId);
  if (held) return Promise.resolve(held);
  return new Promise((resolve) => {
    const wake = (claim: () => void) => {
      clearTimeout(timer);
      resolve(claim);
    };
    const timer = setTimeout(() => {
      waiters.get(blockId)?.delete(wake);
      resolve(null);
    }, MOUNT_MS);
    const set = waiters.get(blockId) ?? new Set();
    set.add(wake);
    waiters.set(blockId, set);
  });
}
