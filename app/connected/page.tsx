import type { Metadata } from "next";
import { Suspense } from "react";
import { Connected } from "./Connected";

export const metadata: Metadata = {
  title: "Connected — Nootles",
};

/**
 * Where a provider's consent popup — GitHub's or Notion's — lands once its
 * callback is done. It says how it went and closes itself; the window that
 * opened it is already watching the account status and needs nothing from here.
 */
export default function ConnectedPage() {
  return (
    <Suspense>
      <Connected />
    </Suspense>
  );
}
