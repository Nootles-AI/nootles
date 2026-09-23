"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { slugProblem } from "@/convex/slugs";

/** How long typing rests before the server is asked whether an address is free. */
const SETTLE_MS = 250;

/**
 * What is wrong with an address as it is typed, or null.
 *
 * First by the rules the server keeps it by (`convex/slugs.ts`), so nothing is
 * said here that saving would contradict; then, once typing rests, by the
 * server itself, since whether an address is taken is only its to know. Its
 * answer counts only while it is still about the address in the field.
 *
 * `judge` is false while there is nothing yet to judge — an untouched field.
 * With `workspaceId`, the address is judged as that workspace's next one, so
 * its own current and old addresses are free to it.
 */
export function useSlugProblem(
  slug: string,
  { judge, workspaceId }: { judge: boolean; workspaceId?: Id<"workspaces"> },
): string | null {
  const local = judge ? slugProblem(slug) : null;
  const settled = useSettled(slug);
  const check = useQuery(
    api.workspaces.checkSlug,
    judge && !local && settled === slug ? (workspaceId ? { slug, workspaceId } : { slug }) : "skip",
  );
  return local ?? (check?.slug === slug ? check.problem : null);
}

/** `value`, once it has stopped changing for a moment. */
function useSettled<T>(value: T): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}
