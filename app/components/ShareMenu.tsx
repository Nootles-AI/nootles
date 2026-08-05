"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { track } from "@/app/lib/telemetry";
import { LinkIcon } from "./Icons";
import { Menu, MenuItem } from "./Menu";

/**
 * Read-only sharing, from the sidebar head. One menu, two states: not shared
 * offers to create a link (and copies it in the same press), shared offers the
 * link again and the way out. The token lives on the project row, so this
 * reads it from the same `projects.get` the sidebar already subscribes to.
 */
export function ShareMenu({ projectId }: { projectId: Id<"projects"> }) {
  const project = useQuery(api.projects.get, { projectId });
  const setSharing = useMutation(api.share.setSharing);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async (token: string) => {
    await navigator.clipboard.writeText(
      `${window.location.origin}/share/${token}`,
    );
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  const token = project?.shareToken ?? null;

  return (
    <Menu
      label="Share"
      side="bottom"
      align="end"
      trigger={(t) => (
        <button
          {...t}
          aria-label="Share project"
          title="Share"
          className="nt-icon-btn"
        >
          <LinkIcon />
        </button>
      )}
    >
      {(close) =>
        token ? (
          <>
            <div className="nt-menu-caption">
              <span className="nt-row-label">Anyone with the link can view</span>
            </div>
            <div className="nt-menu-sep" />
            <MenuItem onClick={() => void copy(token)}>
              {copied ? "Copied" : "Copy link"}
            </MenuItem>
            <MenuItem
              danger
              onClick={() => {
                close();
                void setSharing({ projectId, enabled: false });
                track("share_toggled", { on: false });
              }}
            >
              Stop sharing
            </MenuItem>
          </>
        ) : (
          <>
            <div className="nt-menu-caption">
              <span className="nt-row-label">Not shared</span>
            </div>
            <div className="nt-menu-sep" />
            <MenuItem
              onClick={() => {
                void setSharing({ projectId, enabled: true }).then((t) => {
                  if (t) void copy(t);
                });
                track("share_toggled", { on: true });
              }}
            >
              Create read-only link
            </MenuItem>
          </>
        )
      }
    </Menu>
  );
}
