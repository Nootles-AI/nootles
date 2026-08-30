"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Meter } from "@/convex/entitlements";
import { DialogBox } from "../Dialog";

/**
 * What the free run ran out of, said once, where it ran out.
 *
 * One component for all three meters rather than three near-identical
 * dialogs — the sentence changes, the shape does not, and three copies is
 * three places for the tone to drift.
 *
 * It stays a `DialogBox` (the small box the delete confirmation established)
 * rather than growing into a pricing page in a modal. The plans are one click
 * away and already have a page; putting them here would make being stopped
 * feel like being sold to, which is the difference between a limit and a trap.
 */

const SAID: Record<Meter, { title: string; body: string }> = {
  projects: {
    title: "That's both your free projects",
    body: "Pro gives you as many as you want. Everything already here stays exactly as it is.",
  },
  completions: {
    title: "You've kept all 100 free completions",
    body: "The editor works as it always did — the suggestions are what stop. Pro turns them back on for good.",
  },
  chats: {
    title: "That's all ten free conversations",
    body: "The ones you've already started still work. Pro lets you begin as many more as you like.",
  },
};

export function PlanWall({ meter, onClose }: { meter: Meter; onClose: () => void }) {
  const router = useRouter();
  const sawWall = useMutation(api.entitlements.sawWall);
  const { title, body } = SAID[meter];

  // Reported as it is DRAWN, not where it was refused: the server says no in
  // several places, the user is shown one wall, and the funnel is about the
  // showing. Swallowed on failure — a paywall that raises an error because it
  // could not log itself is worse than not knowing. An operator standing in is
  // refused by `requireOwner`, which keeps their looking out of the numbers.
  useEffect(() => {
    void sawWall({ meter }).catch(() => {});
  }, [sawWall, meter]);

  return (
    <DialogBox label={title} onClose={onClose}>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1.5 text-[13px] text-muted">{body}</p>
      <div className="mt-4 flex justify-end gap-1">
        <button onClick={onClose} className="nt-row px-2.5">
          Not now
        </button>
        <button
          autoFocus
          onClick={() => router.push("/upgrade")}
          className="nt-row nt-solid px-2.5 font-medium"
        >
          See plans
        </button>
      </div>
    </DialogBox>
  );
}
