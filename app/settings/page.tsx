import type { Metadata } from "next";
import { Suspense } from "react";
import { Authed } from "@/app/components/Authed";
import { Settings } from "@/app/components/settings/Settings";

export const metadata: Metadata = {
  title: "Settings — Nootles",
};

/**
 * The settings screen, and where `/api/notion/connect` sends people back to
 * when they started from it. The query string it arrives with is read on the
 * client (`useNotionOutcome`), which is what the Suspense boundary is for:
 * `useSearchParams` in a prerendered route has to sit under one.
 */
export default function SettingsPage() {
  return (
    <Authed>
      <Suspense>
        <Settings />
      </Suspense>
    </Authed>
  );
}
