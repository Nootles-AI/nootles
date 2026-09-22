import type { Metadata } from "next";
import { Suspense } from "react";
import { Connected } from "./Connected";

export const metadata: Metadata = {
  title: "GitHub — Nootles",
};

/**
 * Where the GitHub consent popup lands once the callback is done. It says how
 * it went and closes itself; the window that opened it is already watching
 * the account status and needs nothing from here.
 */
export default function GitHubConnectedPage() {
  return (
    <Suspense>
      <Connected />
    </Suspense>
  );
}
