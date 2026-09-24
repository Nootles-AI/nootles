import type { CSSProperties } from "react";
import { Check, ChevronsUpDown, PersonPlus } from "./Icons";

/**
 * Inviting someone, pictured: the invite form on top, the workspace's members
 * below, and the invitation crossing from one to the other.
 *
 * An address types itself in, Invite is pressed and the field clears for the
 * next, a pulse runs down the wire, and Maya arrives — her face into the pile
 * on the same spring every face arrives on, her row under the others, a tick
 * as it lands. Then a rest, and again. All of it in our own ink: this is our
 * screen, not someone else's.
 *
 * One nine-second loop, all of it delays on shared keyframes: each letter is
 * the same keystroke `--n` beats late.
 *
 * Decorative, and marked so: the row it sits beside says what it is.
 */
const ADDRESS = "maya@studio.com";

const MEMBERS = [
  { name: "Ada", role: "Owner" },
  { name: "Jonah", role: "Admin" },
];

const at = (n: number) => ({ "--n": n }) as CSSProperties;

export function InviteSend() {
  return (
    <div className="nt-invs" aria-hidden="true">
      <div className="nt-invs-form">
        <p className="nt-invs-head">
          <PersonPlus width={14} height={14} />
          Invite people
        </p>
        <div className="nt-invs-field">
          <span className="nt-invs-hint">Their email address</span>
          <span className="nt-invs-typed">
            {[...ADDRESS].map((letter, n) => (
              <span key={n} className="nt-invs-key" style={at(n)}>
                {letter}
              </span>
            ))}
          </span>
          <span className="nt-invs-caret" />
        </div>
        <div className="nt-invs-foot">
          <span className="nt-invs-role">
            Member
            <ChevronsUpDown width={12} height={12} />
          </span>
          <span className="nt-invs-send">Invite</span>
        </div>
      </div>

      <svg className="nt-invs-wire" width="60" height="80" viewBox="0 0 60 80" fill="none">
        <path d="M14 0v44q0 14 14 14h32" />
        <path d="M14 0v44q0 14 14 14h32" pathLength={100} className="nt-invs-pulse" />
      </svg>

      <div className="nt-invs-team">
        <div className="nt-invs-team-head">
          Members
          <span className="nt-facepile">
            {MEMBERS.map((m) => (
              <span key={m.name} className="nt-face">
                {m.name[0]}
              </span>
            ))}
            <span className="nt-face is-new">M</span>
          </span>
        </div>
        {MEMBERS.map((m) => (
          <div key={m.name} className="nt-invs-row">
            {m.name}
            <span className="nt-invs-role-of">· {m.role}</span>
          </div>
        ))}
        <div className="nt-invs-row is-new">
          Maya
          <span className="nt-invs-role-of">· Member</span>
          <Check width={14} height={14} className="nt-invs-tick" />
        </div>
      </div>
    </div>
  );
}
