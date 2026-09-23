"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { InstallFailure } from "@/app/api/github/app/flow";
import { Brandmark } from "../../Brand";
import { Check, ChevronsUpDown, Lock, Person, X } from "../../Icons";
import { Menu, MenuItem } from "../../Menu";
import { Segmented, type Segment } from "../../Segmented";
import { useStandIn } from "../../StandIn";
import { GitHubMark } from "../../context/marks";
import { useOrgProof } from "../../context/useOrgProof";
import { installPath } from "../../context/useGitHubDoor";
import { useContainer, type WorkspaceContainer } from "../ContainerContext";
import { refusal } from "../refusal";

type Status = NonNullable<ReturnType<typeof useQuery<typeof api.github.app.status>>>;
type Installation = Status["installations"][number];

const WHEN = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * What this workspace is connected to — for now, GitHub: the Nootles GitHub
 * App its projects read code through, whether a member's own connection may
 * stand in for it, and the organisation everyone must belong to to read that
 * code (docs/github-app.md).
 *
 * Everyone here sees what is installed; only owners and admins change it.
 * `installable` is whether the web app knows the App's name to send an admin
 * to — the other half of "set up on this deployment", which Convex answers.
 */
export function IntegrationsSettings({ installable }: { installable: boolean }) {
  const container = useContainer();
  if (container.kind !== "workspace") return null;
  return <Integrations workspace={container} installable={installable} />;
}

function Integrations({ workspace, installable }: { workspace: WorkspaceContainer; installable: boolean }) {
  const status = useQuery(api.github.app.status, { workspaceId: workspace.workspaceId });
  const standIn = useStandIn();
  const outcome = useInstallOutcome();

  if (status === undefined) {
    return (
      <section className="nt-set-section" aria-labelledby="nt-ws-github" aria-busy="true">
        <h2 id="nt-ws-github" className="nt-set-label">
          GitHub
        </h2>
      </section>
    );
  }
  if (!status) return null;

  const edits = status.canManage && !standIn;
  const ready = status.ready && installable;
  // An uninstalled installation is history; a suspended one is still the
  // workspace's, and says so on its row.
  const live = status.installations.filter((i) => i.removedAt === undefined);

  return (
    <>
      <section className="nt-set-section" aria-labelledby="nt-ws-github">
        <h2 id="nt-ws-github" className="nt-set-label">
          GitHub
        </h2>
        {!ready ? (
          <ul className="nt-set-list">
            <li>
              <div className="nt-set-row">
                <span className="nt-set-glyph">
                  <GitHubMark />
                </span>
                <div className="nt-set-body-col">
                  <div className="nt-set-name">GitHub App</div>
                  <p className="nt-set-note">
                    The GitHub App isn’t set up on this deployment, so repositories are linked
                    with each person’s own GitHub connection.
                  </p>
                  {edits && (
                    <p className="nt-set-note">
                      {status.blocker ||
                        "The web app is missing GITHUB_APP_SLUG. See docs/github-app.md."}
                    </p>
                  )}
                </div>
              </div>
            </li>
          </ul>
        ) : live.length === 0 ? (
          <div className="nt-set-list nt-ws-gh-install">
            <NotInstalled workspace={workspace} edits={edits} />
          </div>
        ) : (
          <ul className="nt-set-list">
            {live.map((installation) => (
              <li key={installation._id}>
                <InstallationRow installation={installation} edits={edits} />
              </li>
            ))}
            {edits && (
              <li>
                <div className="nt-set-row">
                  <span className="nt-set-glyph" />
                  <div className="nt-set-body-col">
                    <p className="nt-set-note">
                      Code in another organisation or account needs the App installed there too.
                    </p>
                  </div>
                  <div className="nt-set-actions">
                    <a href={installPath(workspace.workspaceId)} className="nt-row px-2.5">
                      Install on another account
                    </a>
                  </div>
                </div>
              </li>
            )}
          </ul>
        )}
        {outcome.line && (
          <div
            role={outcome.line.problem ? "alert" : "status"}
            className={`nt-set-outcome mt-2 ${outcome.line.problem ? "nt-set-problem" : "nt-set-note"}`}
          >
            <span>{outcome.line.text}</span>
            <button type="button" onClick={outcome.dismiss} aria-label="Dismiss" className="nt-icon-btn is-sm">
              <X />
            </button>
          </div>
        )}
      </section>

      {edits ? (
        <CodeAccess workspace={workspace} status={status} installed={live.length > 0} />
      ) : (
        status.requireGithubOrg && (
          <section className="nt-set-section" aria-labelledby="nt-ws-code">
            <h2 id="nt-ws-code" className="nt-set-label">
              Code access
            </h2>
            <ul className="nt-set-list">
              <li>
                <ProofRow workspaceId={workspace.workspaceId} org={status.requireGithubOrg} status={status} />
              </li>
            </ul>
          </section>
        )
      )}
    </>
  );
}

/**
 * Nothing installed: the connect art the source pickers show, with the one
 * press that installs it for an admin, and who to ask for anyone else.
 */
function NotInstalled({ workspace, edits }: { workspace: WorkspaceContainer; edits: boolean }) {
  return (
    <div className="nt-nc">
      <div className="nt-nc-art" aria-hidden="true">
        <span className="nt-nc-tile">
          <GitHubMark width={28} height={28} />
        </span>
        <span className="nt-nc-track" />
        <span className="nt-nc-tile is-ours">
          <Brandmark width={24} height={30} />
        </span>
      </div>
      <h3 className="nt-nc-title">Read {workspace.name}’s code into context</h3>
      <p className="nt-nc-note">
        The Nootles GitHub App reads only the repositories you choose for it, and never writes to
        them. Members link those to projects without a GitHub connection of their own.
      </p>
      {edits ? (
        <a href={installPath(workspace.workspaceId)} className="nt-nc-go">
          <GitHubMark width={15} height={15} />
          Install the Nootles GitHub App
        </a>
      ) : (
        <p className="nt-note nt-nc-blocker">Ask an owner or an admin to install it.</p>
      )}
    </div>
  );
}

function InstallationRow({ installation, edits }: { installation: Installation; edits: boolean }) {
  const org = installation.accountType === "Organization";
  return (
    <div className="nt-set-row">
      <span className="nt-set-glyph">
        <Avatar login={installation.accountLogin} round={!org} />
      </span>
      <div className="nt-set-body-col">
        <div className="nt-set-name">{installation.accountLogin}</div>
        <div className="nt-set-meta">
          {org ? "Organisation" : "Personal account"} ·{" "}
          {installation.repositorySelection === "all" ? "All repositories" : "Chosen repositories"}
        </div>
        {installation.suspendedAt !== undefined ? (
          <p className="nt-set-problem">
            Suspended on GitHub since {WHEN.format(installation.suspendedAt)}. Its repositories
            aren’t read until it’s unsuspended.
          </p>
        ) : (
          edits && (
            <p className="nt-set-note">
              Choose which repositories it reads, or uninstall it, on GitHub. Uninstalled, its
              repositories leave every project here.
            </p>
          )
        )}
      </div>
      <div className="nt-set-actions">
        <a href={installation.manageUrl} target="_blank" rel="noreferrer" className="nt-row px-2.5">
          Manage on GitHub
        </a>
      </div>
    </div>
  );
}

/**
 * An account's picture, as GitHub serves it for any login — a square for an
 * organisation, a circle for a person, the way GitHub draws them. The mark
 * stands in if it does not load.
 */
function Avatar({ login, round }: { login: string; round: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <GitHubMark />;
  return (
    // Not next/image: the optimizer would need GitHub's avatar host allowed,
    // for a 20px picture.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://github.com/${encodeURIComponent(login)}.png?size=40`}
      alt=""
      width={20}
      height={20}
      onError={() => setFailed(true)}
      className={`nt-ws-gh-avatar${round ? " is-round" : ""}`}
    />
  );
}

type Switch = "off" | "on";

const PERSONAL: readonly Segment<Switch>[] = [
  { id: "off", label: "Off", hint: "Repositories are linked and read only through the GitHub App" },
  { id: "on", label: "On", hint: "Members may link repositories with their own GitHub connection" },
];

/**
 * For owners and admins: whether a member's own connection may stand in for
 * the App, and the organisation rule. Each moves on the press, and a refusal
 * puts it back.
 */
function CodeAccess({
  workspace,
  status,
  installed,
}: {
  workspace: WorkspaceContainer;
  status: Status;
  installed: boolean;
}) {
  const args = { workspaceId: workspace.workspaceId };
  const update = useMutation(api.workspaces.updateSettings).withOptimisticUpdate((store, { patch }) => {
    const now = store.getQuery(api.github.app.status, args);
    if (!now || patch.allowPersonalTokens === undefined) return;
    store.setQuery(api.github.app.status, args, { ...now, allowPersonalTokens: patch.allowPersonalTokens });
  });
  const setOrgRule = useMutation(api.github.app.setOrgRule).withOptimisticUpdate((store, { org }) => {
    const now = store.getQuery(api.github.app.status, args);
    if (!now) return;
    store.setQuery(api.github.app.status, args, { ...now, requireGithubOrg: org });
  });
  const [problem, setProblem] = useState<string | null>(null);

  const personal = status.allowPersonalTokens;
  const rule = status.requireGithubOrg;
  const orgs = status.installations
    .filter(
      (i) => i.accountType === "Organization" && i.removedAt === undefined && i.suspendedAt === undefined,
    )
    .map((i) => i.accountLogin);

  const fail = (error: unknown) => setProblem(refusal(error, "That didn’t save. Try again in a moment."));
  const savePersonal = (on: boolean) => {
    setProblem(null);
    update({ workspaceId: workspace.workspaceId, patch: { allowPersonalTokens: on } }).catch(fail);
  };
  const saveRule = (org: string | null) => {
    setProblem(null);
    setOrgRule({ workspaceId: workspace.workspaceId, org }).catch(fail);
  };

  return (
    <section className="nt-set-section nt-ws-policy" aria-labelledby="nt-ws-code">
      <h2 id="nt-ws-code" className="nt-set-label">
        Code access
      </h2>
      <ul className="nt-set-list">
        <li>
          <div className="nt-set-row">
            <span className="nt-set-glyph">
              <Person aria-hidden="true" />
            </span>
            <div className="nt-set-body-col">
              <div className="nt-set-name">Personal GitHub connections</div>
              <p className="nt-set-note">
                {personal
                  ? installed
                    ? "Members may still link a repository with their own connection where the App doesn’t reach. Turning this off keeps every project’s code in the App’s hands, and stops reading what was linked the other way."
                    : "Members link repositories with their own GitHub connection. Installing the App is better: code keeps being read when whoever linked it leaves."
                  : installed
                    ? "Repositories are linked and read only through the GitHub App."
                    : "Repositories are linked and read only through the GitHub App, which isn’t installed — so no project here reads code yet."}
              </p>
            </div>
            <div className="nt-set-actions">
              <Segmented
                label="Personal GitHub connections"
                segments={PERSONAL}
                value={personal ? "on" : "off"}
                onChange={(to) => savePersonal(to === "on")}
                chosenSaidBelow
              />
            </div>
          </div>
        </li>
        <li>
          <div className="nt-set-row">
            <span className="nt-set-glyph">
              <Lock aria-hidden="true" />
            </span>
            <div className="nt-set-body-col">
              <div className="nt-set-name">Require GitHub organisation membership</div>
              <p className="nt-set-note">
                {rule
                  ? `Everyone here — owners and admins too — reads code only after GitHub shows they’re in ${rule}. Each presses Verify GitHub membership in a project’s context, and again every two weeks; leaving ${rule} on GitHub takes their access away at once. Guests are covered by their own grant.`
                  : orgs.length
                    ? "Off: every member reads the code linked here. On, members must show GitHub lists them in the organisation you choose."
                    : "Available once the App is installed on an organisation."}
              </p>
              {rule && (
                <p className="nt-set-note">Choosing another organisation asks everyone to verify again.</p>
              )}
            </div>
            <div className="nt-set-actions">
              <Menu
                label="Required GitHub organisation"
                side="bottom"
                align="end"
                trigger={(t) => (
                  <button
                    {...t}
                    disabled={!rule && !orgs.length}
                    aria-label={`Required GitHub organisation, ${rule ?? "off"}`}
                    className="nt-row nt-ws-pick gap-1.5 px-2.5"
                  >
                    {rule ?? "Off"}
                    <ChevronsUpDown width={14} height={14} aria-hidden="true" className="nt-ws-pick-glyph" />
                  </button>
                )}
              >
                {(close) =>
                  [null, ...orgs].map((org) => (
                    <MenuItem
                      key={org ?? "off"}
                      onClick={() => {
                        close();
                        if (org !== rule) saveRule(org);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{org ?? "Off"}</span>
                      <Check
                        width={14}
                        height={14}
                        aria-hidden="true"
                        className={`nt-menu-check${org === rule ? " is-on" : ""}`}
                      />
                    </MenuItem>
                  ))
                }
              </Menu>
            </div>
          </div>
        </li>
        {rule && (
          <li>
            <ProofRow workspaceId={workspace.workspaceId} org={rule} status={status} />
          </li>
        )}
      </ul>
      {problem && (
        <p role="alert" className="nt-set-problem">
          {problem}
        </p>
      )}
    </section>
  );
}

/** Where you stand with the organisation rule, and the press that proves it. */
function ProofRow({
  workspaceId,
  org,
  status,
}: {
  workspaceId: Id<"workspaces">;
  org: string;
  status: Status;
}) {
  const proof = useOrgProof(workspaceId, org);
  const { passes, verifiedAt, login } = status.orgProof;
  return (
    <div className="nt-set-row">
      <span className="nt-set-glyph">
        <GitHubMark />
      </span>
      <div className="nt-set-body-col">
        <div className="nt-set-name">Your membership of {org}</div>
        {passes && verifiedAt ? (
          <div className="nt-set-meta">
            Verified {WHEN.format(verifiedAt)}
            {login ? ` · @${login}` : ""}
          </div>
        ) : (
          <p className="nt-set-note">
            {verifiedAt
              ? "Your last check is over two weeks old. Until you verify again, this workspace’s code is hidden from you."
              : "Not verified. Until you are, this workspace’s code is hidden from you."}
          </p>
        )}
        {proof.blocker && <p className="nt-set-problem">{proof.blocker}</p>}
        {proof.said && (
          <p
            role={proof.said.problem ? "alert" : "status"}
            className={`nt-set-outcome ${proof.said.problem ? "nt-set-problem" : "nt-set-note"}`}
          >
            <span>{proof.said.text}</span>
          </p>
        )}
      </div>
      {proof.action && (
        <div className="nt-set-actions">
          <button
            type="button"
            onClick={proof.action.run}
            disabled={proof.action.busy}
            className={passes ? "nt-row px-2.5" : "nt-row nt-solid px-3 font-medium"}
          >
            {proof.action.label}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- How an install ended ---------------------------------------------------

type InstallOutcome = "installed" | "requested" | "error";

const FAILED: Record<InstallFailure, string> = {
  state: "the install didn’t start from this browser, so it wasn’t trusted. Start it again from here.",
  no_code:
    "GitHub came back without authorising Nootles. The App must request user authorisation during installation (docs/github-app.md).",
  no_installation: "GitHub came back without an installation. Try again.",
  verify: "GitHub didn’t confirm you can reach that installation, so it wasn’t added. Try again.",
};

/**
 * How the round trip to GitHub ended, read once off the address the setup
 * route sent the browser back to (`?github=`), and the address cleaned at
 * once so a reload does not report it again — `useNotionOutcome`'s way.
 */
function useInstallOutcome() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [held, setHeld] = useState<{ outcome: InstallOutcome; reason: string | null } | null>(() => {
    const outcome = params.get("github");
    if (outcome !== "installed" && outcome !== "requested" && outcome !== "error") return null;
    return { outcome, reason: params.get("reason") };
  });

  const carried = params.has("github") || params.has("reason");
  useEffect(() => {
    if (!carried) return;
    const rest = new URLSearchParams(params);
    rest.delete("github");
    rest.delete("reason");
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [carried, params, pathname, router]);

  const dismiss = useCallback(() => setHeld(null), []);
  return { line: held && describe(held.outcome, held.reason), dismiss };
}

function describe(outcome: InstallOutcome, reason: string | null): { text: string; problem: boolean } {
  switch (outcome) {
    case "installed":
      return { text: "The GitHub App is installed.", problem: false };
    case "requested":
      return {
        text: "Your request went to the organisation’s owners. Once one of them approves it, install it again from here to add it to this workspace.",
        problem: false,
      };
    case "error": {
      const why = reason && reason in FAILED ? FAILED[reason as InstallFailure] : null;
      return {
        text: why ? `The GitHub App wasn’t added: ${why}` : "The GitHub App wasn’t added. Try again.",
        problem: true,
      };
    }
  }
}
