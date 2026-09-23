"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useContainer } from "../ContainerContext";

/** The people in a workspace, for anyone with a member's seat or better. */
export function MembersSettings() {
  const container = useContainer();
  const people = useQuery(
    api.members.list,
    container.kind === "workspace" ? { workspaceId: container.workspaceId } : "skip",
  );
  return (
    <section
      className="nt-set-section"
      aria-labelledby="nt-ws-members"
      aria-busy={people === undefined}
    >
      <h2 id="nt-ws-members" className="nt-set-label">
        Members
      </h2>
      {people && (
        <ul className="nt-set-list">
          {people.members.map((member) => (
            <li key={member.userId} className="nt-set-row">
              <div className="nt-set-body-col">
                <p className="nt-set-name">{member.name ?? member.email ?? "Someone"}</p>
                {member.name && member.email && <p className="nt-set-note">{member.email}</p>}
              </div>
              <span className="nt-set-meta">{member.role}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
