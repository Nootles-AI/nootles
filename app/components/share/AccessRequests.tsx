"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { track } from "@/app/lib/telemetry";
import { FountainPen, X } from "../Icons";
import "./access.css";

/** By code point, not char: a name starting with an emoji keeps it whole. */
function initial(name: string | null | undefined) {
  return (Array.from(name?.trim() ?? "")[0] ?? "?").toUpperCase();
}

/** As many as one corner can hold; answering one uncovers the next. */
const AT_ONCE = 3;

/**
 * The two ends of an access request, in the one corner nothing else uses.
 *
 * The owner is asked, wherever they are standing — the query is keyed on them
 * rather than on a project, so a request made in one document reaches them in
 * another. The requester is told, once, when the answer is yes; a no is never
 * announced, it simply leaves the ask available again.
 *
 * Both answers are decisions: there is no dismiss that leaves the question
 * hanging where only this toast could have shown it. What is not answered here
 * stays in the share popover, which is where "who has access" already lives.
 */
export function AccessRequests() {
  const incoming = useQuery(api.share.incomingRequests) ?? [];
  const granted = useQuery(api.share.grantedForMe) ?? [];
  const decide = useMutation(api.share.decideRequest);
  const markSeen = useMutation(api.share.markGrantsSeen);

  // Held rather than read live: acknowledging clears the rows server-side, and
  // a toast that vanishes as it is being read was never read.
  const [toldOf, setToldOf] = useState<ReadonlySet<string>>(new Set());
  const news = granted.filter((g) => !toldOf.has(g.requestId));

  const answer = (requestId: Id<"accessRequests">, grant: boolean) => {
    track("access_request_decided", { grant });
    void decide({ requestId, grant }).catch(() => {});
  };

  const acknowledge = () => {
    const ids = news.map((g) => g.requestId);
    setToldOf((held) => new Set([...held, ...ids]));
    void markSeen({ requestIds: ids }).catch(() => {});
  };

  if (!incoming.length && !news.length) return null;

  return (
    <div className="nt-asks">
      {news.length > 0 && (
        <div className="nt-ask" role="status">
          <span className="nt-ask-pen" aria-hidden>
            <FountainPen width={15} height={15} />
          </span>
          <span className="nt-ask-said">
            You can now edit{" "}
            {news.length === 1 ? (
              <strong className="font-medium">
                {news[0].projectTitle || "Untitled project"}
              </strong>
            ) : (
              `${news.length} projects`
            )}
            .
          </span>
          <button
            className="nt-ask-x"
            aria-label="Dismiss"
            onClick={acknowledge}
          >
            <X width={12} height={12} />
          </button>
        </div>
      )}

      {incoming.slice(0, AT_ONCE).map((ask) => (
        <div key={ask.requestId} className="nt-ask is-decision" role="status">
          {ask.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={ask.imageUrl} alt="" className="nt-ask-face" />
          ) : (
            <span aria-hidden className="nt-monogram nt-ask-face">
              {initial(ask.name ?? ask.email)}
            </span>
          )}
          <span className="nt-ask-said">
            <strong className="font-medium">
              {ask.name ?? ask.email ?? "Someone"}
            </strong>{" "}
            wants to edit{" "}
            <strong className="font-medium">
              {ask.projectTitle || "Untitled project"}
            </strong>
            .
          </span>
          {/* Their own row: a project name is arbitrarily long, and the answer
              must not be squeezed into whatever it leaves over. */}
          <span className="nt-ask-answers">
            <button
              className="nt-ask-no"
              onClick={() => answer(ask.requestId, false)}
            >
              Not now
            </button>
            <button
              className="nt-ask-yes"
              onClick={() => answer(ask.requestId, true)}
            >
              Give edit access
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The ask itself, for someone already signed in and reading a project they
 * cannot write. Renders nothing for anyone who has the pen already — the
 * caller decides that; this only knows how to ask and how to say it has.
 */
export function RequestEditButton({
  projectId,
}: {
  projectId: Id<"projects">;
}) {
  const request = useQuery(api.share.myEditRequest, { projectId });
  const requestEdit = useMutation(api.share.requestEdit);
  const pending = request?.status === "pending";

  if (request === undefined) return null;

  return (
    <button
      onClick={() => {
        if (pending) return;
        track("access_requested", { from: "workspace" });
        void requestEdit({ projectId }).catch(() => {});
      }}
      disabled={pending}
      className="nt-row w-full"
      title={
        pending
          ? "The owner has been asked"
          : "Ask the owner for permission to edit"
      }
    >
      <FountainPen width={14} height={14} className="nt-row-icon" />
      <span className="nt-row-label">
        {pending ? "Edit access requested" : "Request edit access"}
      </span>
    </button>
  );
}
