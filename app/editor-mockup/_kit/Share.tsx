"use client";

import { useState, type CSSProperties } from "react";
import { people } from "./data";
import { useUi } from "./store";
import { Segmented } from "./controls";
import { Select } from "./overlays";
import { Check, Copy, X } from "./icons";

export function Face({ id, size = 24 }: { id: string; size?: number }) {
  const p = people.find((x) => x.id === id)!;
  return (
    <span className="ek-face" data-tip={p.name} data-tip-side="bottom" style={{ "--tone": p.tone, "--size": `${size}px` } as CSSProperties}>
      {p.initials}
    </span>
  );
}

const ROLES = ["can edit", "can view"] as const;

/** Sharing: one link per role, who is asking for the pen, who already has it. */
export function SharePanel() {
  const { ui, act } = useUi();
  const [asking, setAsking] = useState(true);
  const [granted, setGranted] = useState(false);
  const [roles, setRoles] = useState<Record<string, (typeof ROLES)[number]>>({ maya: "can edit", jonas: "can view" });
  const [copied, setCopied] = useState(false);
  const off = ui.linkRole === "off";

  return (
    <div className="ek-share">
      <header className="ek-share-head">
        <h2>Share “Rate limiting”</h2>
        <Segmented
          label="Link role"
          value={off ? "can view" : ui.linkRole}
          onChange={(linkRole) => act.set({ linkRole })}
          options={[
            { value: "can view", label: "Viewer link" },
            { value: "can edit", label: "Editor link" },
          ]}
        />
      </header>

      <div className="ek-share-link" data-off={off}>
        <input readOnly aria-label={ui.linkRole === "can edit" ? "Editor link" : "Viewer link"} value={off ? "Link is off" : `nootles.app/share/${ui.linkRole === "can edit" ? "e" : "v"}-7Kq2mXw9`} />
        <button
          type="button"
          className="ek-btn is-ink"
          disabled={off}
          data-done={copied}
          onClick={() => {
            setCopied(true);
            act.toast("Link copied");
            setTimeout(() => setCopied(false), 1600);
          }}
        >
          <span className="ek-swap">
            <Copy width={14} height={14} />
            <Check width={14} height={14} />
          </span>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="ek-note">
        {off
          ? "Nobody new can open this project. People below keep their access."
          : ui.linkRole === "can edit"
            ? "Anyone with this link can edit once they sign in. Their assistant’s changes stay private until approved."
            : "Anyone with this link can read every page. They cannot edit, and they get no assistant."}
      </p>

      {asking && (
        <section className="ek-share-ask" data-state={granted ? "closed" : "open"}>
          <div className="ek-group-label">People waiting to edit</div>
          <div className="ek-person">
            <Face id="jonas" size={28} />
            <span className="ek-person-name">
              Jonas Weber <i>asked 4 minutes ago</i>
            </span>
            <button type="button" className="ek-icon-btn is-sm" aria-label="Decline" data-tip="Decline" onClick={() => setAsking(false)}>
              <X width={14} height={14} />
            </button>
            <button
              type="button"
              className="ek-btn"
              onClick={() => {
                setGranted(true);
                setRoles((r) => ({ ...r, jonas: "can edit" }));
                setTimeout(() => setAsking(false), 240);
                act.toast("Jonas can edit now");
              }}
            >
              Allow
            </button>
          </div>
        </section>
      )}

      <section>
        <div className="ek-group-label">People with access</div>
        <ul className="ek-people ek-stagger">
          {people.map((p) => (
            <li key={p.id} className="ek-person">
              <Face id={p.id} size={28} />
              <span className="ek-person-name">
                {p.name} {p.id === "you" && <i>you</i>}
              </span>
              {p.id === "you" ? (
                <span className="ek-meta">Owner</span>
              ) : (
                <Select label={`Role for ${p.name}`} value={roles[p.id]} options={ROLES} onChange={(v) => setRoles((r) => ({ ...r, [p.id]: v }))} className="is-quiet" />
              )}
            </li>
          ))}
        </ul>
      </section>

      <button type="button" className="ek-row ek-share-off" data-danger onClick={() => act.set({ linkRole: off ? "can view" : "off" })}>
        {off ? "Turn the link back on" : "Turn the link off"}
      </button>
    </div>
  );
}
