import { useSyncExternalStore } from "react";

const noop = () => () => {};

/** ⌘ on Apple hardware, Ctrl elsewhere — read on the client, ⌘ until then. */
export function useModKey(): string {
  const mac = useSyncExternalStore(
    noop,
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => true,
  );
  return mac ? "⌘" : "Ctrl";
}
