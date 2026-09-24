"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { atLeast } from "@/convex/auth";
import { normalizeSlug, typingSlug } from "@/convex/slugs";
import { rememberWorkspace } from "@/app/lib/projectsCache";
import { Check } from "../../Icons";
import { useStandIn } from "../../StandIn";
import { useContainer, type WorkspaceContainer } from "../ContainerContext";
import { refusal } from "../refusal";
import { heirOf, leaveProblem } from "../seats";
import { useMoment } from "../useMoment";
import { useSlugProblem } from "../useSlugProblem";
import { ConfirmBox, LeaveWorkspace } from "./Confirm";
import { Fold, Problem } from "./parts";
import { SharingSettings } from "./SharingSettings";

/**
 * What a workspace is called, where it lives, how its projects are shared,
 * and the ways out of it.
 *
 * Owners and admins edit the name and address in place — each saves as focus
 * leaves it, or on Enter, with no Save button to forget. Everyone else reads
 * them. Sharing is theirs alone. The danger zone holds what each role can do
 * to its own seat: leave, and for an owner, delete.
 */
export function GeneralSettings() {
  const container = useContainer();
  if (container.kind !== "workspace") return null;
  return <General workspace={container} />;
}

function General({ workspace }: { workspace: WorkspaceContainer }) {
  const standIn = useStandIn();
  const edits = !standIn && atLeast(workspace.role, "admin");

  return (
    <>
      <section className="nt-set-section" aria-labelledby="nt-ws-general">
        <h2 id="nt-ws-general" className="nt-set-label">
          Workspace
        </h2>
        <ul className="nt-set-list">
          <li>
            <NameField workspace={workspace} edits={edits} />
          </li>
          <li>
            <AddressField workspace={workspace} edits={edits} />
          </li>
        </ul>
        {!edits && (
          <p className="nt-set-note mt-2">Only an owner or an admin can change these.</p>
        )}
      </section>
      {edits && <SharingSettings workspace={workspace} />}
      {!standIn && <DangerZone workspace={workspace} />}
    </>
  );
}

/**
 * The name, edited where it is read. Escape puts back what was there; an
 * emptied field goes back too, since a workspace always has a name.
 */
function NameField({ workspace, edits }: { workspace: WorkspaceContainer; edits: boolean }) {
  const rename = useMutation(api.workspaces.rename);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, flash] = useMoment();
  const dropped = useRef(false);

  const commit = async () => {
    if (dropped.current) {
      dropped.current = false;
      return;
    }
    if (draft === null) return;
    const name = draft.trim();
    if (!name || name === workspace.name) {
      setDraft(null);
      setProblem(null);
      return;
    }
    try {
      await rename({ workspaceId: workspace.workspaceId, name });
      setDraft(null);
      setProblem(null);
      flash();
    } catch (error) {
      setProblem(refusal(error, "That name didn’t save. Try again in a moment."));
    }
  };

  return (
    <div className="nt-ws-fld">
      <Key htmlFor="nt-ws-name" edits={edits}>
        Name
      </Key>
      <div className="min-w-0">
        {edits ? (
          <div className="nt-ws-saving">
            <input
              id="nt-ws-name"
              autoComplete="off"
              value={draft ?? workspace.name}
              aria-invalid={!!problem}
              aria-describedby={problem ? "nt-ws-name-note" : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                setProblem(null);
              }}
              onKeyDown={(e) =>
                settle(e, () => {
                  dropped.current = true;
                  setDraft(null);
                  setProblem(null);
                })
              }
              onBlur={() => void commit()}
              className="nt-input"
            />
            {/* Drawn always so it can fade both ways; announced only when it is news. */}
            <span className="nt-ws-saved" data-on={saved || undefined} aria-hidden="true">
              <Check width={12} height={12} />
              Saved
            </span>
            <span role="status" className="sr-only">
              {saved ? "Saved" : ""}
            </span>
          </div>
        ) : (
          <p className="nt-ws-value">{workspace.name}</p>
        )}
        <Problem text={problem} id="nt-ws-name-note" className="nt-ws-note is-problem nt-settle" />
      </div>
    </div>
  );
}

/**
 * The address, judged as it is typed by the rules the server keeps it by
 * (`useSlugProblem`). Saving moves this page to the new address in place — the
 * old one keeps arriving, which is what the note under it promises, and says
 * again for a moment once it has moved, naming the address that still leads
 * here.
 */
function AddressField({ workspace, edits }: { workspace: WorkspaceContainer; edits: boolean }) {
  const { userId } = useAuth();
  const setSlug = useMutation(api.workspaces.setSlug);
  // Null while the field shows the address as it is.
  const [typed, setTyped] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState<string | null>(null);
  const [moved, flashMoved] = useMoment(5000);
  const dropped = useRef(false);

  const slug = normalizeSlug(typed ?? workspace.slug);
  const changed = typed !== null && slug !== workspace.slug;
  const problem =
    useSlugProblem(slug, { judge: changed, workspaceId: workspace.workspaceId }) ?? failure;
  const host = window.location.host;

  const commit = async () => {
    if (dropped.current) {
      dropped.current = false;
      return;
    }
    // Emptied or unchanged, it goes back to the address it has.
    if (!changed || !slug) {
      setTyped(null);
      setFailure(null);
      return;
    }
    if (problem || busy) return;
    setBusy(true);
    try {
      const next = await setSlug({ workspaceId: workspace.workspaceId, slug });
      // What the new address resolves to is already known, so the next page
      // opened there draws at once rather than waiting to be told. This one
      // stays put: `ContainerRoute` rewrites its address, as it does for
      // everyone else here.
      if (userId) rememberWorkspace(userId, next.slug, { ...workspace, slug: next.slug });
      setTyped(null);
      setFailure(null);
      setFrom(workspace.slug);
      flashMoved();
    } catch (error) {
      setFailure(refusal(error, "That address didn’t save. Try again in a moment."));
    }
    setBusy(false);
  };

  const note = problem
    ? problem
    : busy
      ? "Moving…"
      : moved && from && typed === null
        ? `Moved. ${host}/w/${from} still leads here.`
        : edits
          ? "Links to the old address keep working if you change it."
          : "Where everyone here finds its projects.";

  return (
    <div className="nt-ws-fld">
      <Key htmlFor="nt-ws-slug" edits={edits}>
        Address
      </Key>
      <div className="min-w-0">
        {edits ? (
          // A label, so pressing the fixed part of the address still lands in the field.
          <label className={`nt-ws-url${busy ? " is-busy" : ""}`}>
            <span className="nt-ws-url-base" aria-hidden="true">
              {host}/w/
            </span>
            <input
              id="nt-ws-slug"
              autoComplete="off"
              spellCheck={false}
              value={typed ?? workspace.slug}
              readOnly={busy}
              aria-invalid={!!problem}
              aria-describedby="nt-ws-slug-note"
              onChange={(e) => {
                setTyped(typingSlug(e.target.value));
                setFailure(null);
              }}
              onKeyDown={(e) =>
                settle(e, () => {
                  dropped.current = true;
                  setTyped(null);
                  setFailure(null);
                })
              }
              onBlur={() => void commit()}
            />
          </label>
        ) : (
          <p className="nt-ws-value">
            {host}/w/{workspace.slug}
          </p>
        )}
        <p
          id="nt-ws-slug-note"
          aria-live="polite"
          className={`nt-ws-note${problem ? " is-problem" : ""}`}
        >
          {/* The words settle in as they change; the line keeps its place. */}
          <span key={note} className="nt-ws-swap">
            {note}
          </span>
        </p>
      </div>
    </div>
  );
}

/** A field's name: its label where it can be edited, a caption where it is only read. */
function Key({
  htmlFor,
  edits,
  children,
}: {
  htmlFor: string;
  edits: boolean;
  children: string;
}) {
  return edits ? (
    <label htmlFor={htmlFor} className="nt-ws-key">
      {children}
    </label>
  ) : (
    <span className="nt-ws-key">{children}</span>
  );
}

/** Enter keeps what was typed, Escape puts it back; either one is done with the field. */
function settle(e: KeyboardEvent<HTMLInputElement>, drop: () => void) {
  if (e.key === "Escape") {
    e.preventDefault();
    drop();
    e.currentTarget.blur();
  } else if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.blur();
  }
}

/**
 * Leaving, and for an owner deleting. An owner leaves only while another
 * owner stays behind — the last one's way out is deleting — so the section
 * waits for the members list to say whether there is one, and arrives whole.
 */
function DangerZone({ workspace }: { workspace: WorkspaceContainer }) {
  const router = useRouter();
  const people = useQuery(api.members.list, { workspaceId: workspace.workspaceId });
  const remove = useMutation(api.workspaces.remove);
  const [asking, setAsking] = useState<"leave" | "delete" | null>(null);
  // Only a list still on its way is worth opening into place for.
  const [cold] = useState(people === undefined);

  if (!people) return null;
  const owner = workspace.role === "owner";
  const owners = people.members.filter((m) => m.role === "owner").length;
  const leaves = !leaveProblem(workspace.role, { owners, people: people.members.length });
  const heir = heirOf(people.members);
  // It waits on the members list, so it opens into its place rather than
  // landing under everything else a beat after the page.
  return (
    <Fold arriving={cold}>
      <section className="nt-set-section" aria-labelledby="nt-ws-danger">
        <h2 id="nt-ws-danger" className="nt-set-label">
          Danger zone
        </h2>
        <ul className="nt-set-list">
          {leaves && (
            <li>
              <div className="nt-set-row">
                <div className="nt-set-body-col">
                  <div className="nt-set-name">Leave {workspace.name}</div>
                  <p className="nt-set-note">
                    You lose access to its projects straight away.
                  </p>
                </div>
                <div className="nt-set-actions">
                  <button
                    type="button"
                    onClick={() => setAsking("leave")}
                    className="nt-row px-2.5 font-medium text-danger"
                  >
                    Leave
                  </button>
                </div>
              </div>
            </li>
          )}
          {owner && (
            <li>
              <div className="nt-set-row">
                <div className="nt-set-body-col">
                  <div className="nt-set-name">Delete {workspace.name}</div>
                  <p className="nt-set-note">Everyone loses access and its projects are deleted.</p>
                </div>
                <div className="nt-set-actions">
                  <button
                    type="button"
                    onClick={() => setAsking("delete")}
                    className="nt-row px-2.5 font-medium text-danger"
                  >
                    Delete workspace
                  </button>
                </div>
              </div>
            </li>
          )}
        </ul>

        {asking === "leave" && (
          <LeaveWorkspace
            workspace={workspace}
            heir={heir && (heir.name ?? heir.email)}
            onClose={() => setAsking(null)}
          />
        )}
        {asking === "delete" && (
          <ConfirmBox
            label={`Delete ${workspace.name}`}
            question={`Delete ${workspace.name}?`}
            action="Delete"
            busyAction="Deleting…"
            confirmText={workspace.name}
            onConfirm={async () => {
              await remove({ workspaceId: workspace.workspaceId });
              router.replace("/");
            }}
            onClose={() => setAsking(null)}
          >
            {people.members.length > 1
              ? `${people.members.length} people lose access at once, and all of its projects are deleted, private ones included.`
              : "All of its projects are deleted, private ones included."}{" "}
            This can’t be undone.
          </ConfirmBox>
        )}
      </section>
    </Fold>
  );
}
