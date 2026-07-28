import { Suspense } from "react";
import { Workspace } from "./components/Workspace";

export default function Home() {
  // Workspace reads ?project= via useSearchParams, which suspends during a
  // static render — without this boundary the production build fails.
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <Workspace />
    </Suspense>
  );
}
