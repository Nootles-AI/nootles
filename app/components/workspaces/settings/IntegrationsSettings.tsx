"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { atLeast } from "@/convex/auth";
import type { InstallFailure } from "@/app/api/github/app/flow";
import { Check, ChevronsUpDown, Lock, Person, Plus } from "../../Icons";
import { Menu, MenuItem } from "../../Menu";
import { Segmented, type Segment } from "../../Segmented";
import { useStandIn } from "../../StandIn";
import { GitHubMark } from "../../context/marks";
import { useOrgProof } from "../../context/useOrgProof";
import { installPath } from "../../context/useGitHubDoor";
import { useContainer, type WorkspaceContainer } from "../ContainerContext";
import { refusal } from "../refusal";
import { ConfirmBox } from "./Confirm";
import { Bone, Fold, Outcome, Problem, Said } from "./parts";

type Status = NonNullable<ReturnType<typeof useQuery<typeof api.github.app.status>>>;
type Installation = Status["installations"][number];
type Line = { text: string; problem: boolean };

const WHEN = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * What this workspace is connected to — for now, GitHub: the Nootles GitHub
 * App its projects read code through, whether a member's own connection may
 * stand in for it, and the organisation everyone must belong to to read that
 * code (docs/github-app.md).
 *
 * Everyone here sees what is installed; only owners and admins change it.
 */
export function IntegrationsSettings() {
  const container = useContainer();
  if (container.kind !== "workspace") return null;
  return <Integrations workspace={container} />;
}

function Integrations({ workspace }: { workspace: WorkspaceContainer }) {
  const status = useQuery(api.github.app.status, { workspaceId: workspace.workspaceId });
  const standIn = useStandIn();
  const outcome = useInstallOutcome();

  if (status === undefined) return <Loading edits={!standIn && atLeast(workspace.role, "admin")} />;
  if (!status) return null;

  const edits = status.canManage && !standIn;
  // What the deployment lacks is for whoever runs it, not for a customer.
  const operator = standIn || process.env.NODE_ENV !== "production";
  // An uninstalled installation is history; a suspended one is still the
  // workspace's, and says so on its row.
  const live = status.installations.filter((i) => i.removedAt === undefined);
  // How the install ended, said in the row it is about.
  const said = outcome.line && (
    <Outcome text={outcome.line.text} problem={outcome.line.problem} onDismiss={outcome.dismiss} />
  );

  return (
    <>
      <section className="nt-set-section" aria-labelledby="nt-ws-github">
        <h2 id="nt-ws-github" className="nt-set-label">
          GitHub
        </h2>
        <ul className="nt-set-list">
          {!status.ready ? (
            <li>
              <div className="nt-set-row" tabIndex={-1}>
                <span className="nt-set-glyph">
                  <GitHubMark />
                </span>
                <div className="nt-set-body-col">
                  <div className="nt-set-name">GitHub App</div>
                  <p className="nt-set-note">
                    {status.allowPersonalTokens
                      ? "Nootles can’t connect to GitHub right now. Members link repositories with their own GitHub connection in the meantime."
                      : "Nootles can’t connect to GitHub right now, so no project here can read code."}
                  </p>
                  {operator && status.missing.length > 0 && (
                    <p className="nt-set-problem" title={status.missing.join("\n")}>
                      This deployment needs its GitHub App keys. See docs/github-app.md.
                    </p>
                  )}
                  {said}
                </div>
              </div>
            </li>
          ) : live.length === 0 ? (
            <li>
              <NotInstalled workspace={workspace} edits={edits} personal={status.allowPersonalTokens} said={said} />
            </li>
          ) : (
            <>
              {live.map((installation, i) => (
                <li key={installation._id}>
                  <InstallationRow installation={installation} edits={edits} said={i === 0 ? said : null} />
                </li>
              ))}
              {edits && (
                <li>
                  <div className="nt-set-row">
                    <span className="nt-set-glyph">
                      <Plus aria-hidden="true" />
                    </span>
                    <div className="nt-set-body-col">
                      <div className="nt-set-name">Another organisation or account</div>
                      <p className="nt-set-note">Its code needs the GitHub App installed there too.</p>
                    </div>
                    <div className="nt-set-actions">
                      <a href={installPath(workspace.workspaceId)} className="nt-row px-2.5">
                        Install on another account
                      </a>
                    </div>
                  </div>
                </li>
              )}
            </>
          )}
        </ul>
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
 * The page's shape while it is on its way, drawn for the usual answer — an
 * installation, and for whoever edits, the row that adds another and the two
 * rows of Code access — so nothing moves down when the answer arrives. Each
 * bar sits in the line box of its text.
 */
function Loading({ edits }: { edits: boolean }) {
  return (
    <>
      <section className="nt-set-section" aria-busy="true" aria-label="GitHub">
        <Bone bar="h-3.5 w-14" className="mb-2" />
        <ul className="nt-set-list" aria-hidden="true">
          <BoneRow meta notes={edits ? ["w-full", "w-40"] : []} action={edits} />
          {edits && <BoneRow notes={["w-64"]} action />}
        </ul>
      </section>
      {edits && (
        <section className="nt-set-section" aria-hidden="true">
          <Bone bar="h-3.5 w-24" className="mb-2" />
          <ul className="nt-set-list">
            <BoneRow notes={["w-full", "w-full", "w-24"]} action />
            <BoneRow notes={["w-full", "w-40"]} action />
          </ul>
        </section>
      )}
    </>
  );
}

function BoneRow({ meta, notes, action }: { meta?: boolean; notes: readonly string[]; action?: boolean }) {
  return (
    <li>
      <div className="nt-set-row">
        <span className="nt-set-glyph">
          <span className="nt-skeleton h-5 w-5" />
        </span>
        <div className="nt-set-body-col">
          <div className="flex h-5 items-center">
            <div className="nt-skeleton h-3.5 w-32" />
          </div>
          {meta && (
            <div className="mt-0.5 flex h-[18px] items-center">
              <div className="nt-skeleton h-3 w-44" />
            </div>
          )}
          {notes.map((width, i) => (
            <Bone key={i} bar={`h-3 ${width}`} className={i === 0 ? "mt-0.5" : ""} />
          ))}
        </div>
        {action && (
          <div className="nt-set-actions">
            <div className="nt-skeleton h-8 w-[5.5rem]" />
          </div>
        )}
      </div>
    </li>
  );
}

/** Nothing installed: what the App would read, and the press that installs it — or who to ask. */
function NotInstalled({
  workspace,
  edits,
  personal,
  said,
}: {
  workspace: WorkspaceContainer;
  edits: boolean;
  /** Members may link repositories with their own connection meanwhile. */
  personal: boolean;
  said: ReactNode;
}) {
  return (
    <div className="nt-set-row" tabIndex={-1}>
      <span className="nt-set-glyph">
        <GitHubMark />
      </span>
      <div className="nt-set-body-col">
        <div className="nt-set-name">GitHub App</div>
        <p className="nt-set-note">
          {edits
            ? `Not installed. It reads only the repositories you choose, and never writes to them, so members link ${workspace.name}’s code without a GitHub connection of their own.`
            : personal
              ? "Not installed yet. Until an owner or admin installs it, link repositories with your own GitHub connection from any project’s Context panel."
              : "Not installed yet, so no project here can read code. Ask an owner or an admin to install it."}
        </p>
        {said}
      </div>
      {edits && (
        <div className="nt-set-actions">
          <a href={installPath(workspace.workspaceId)} className="nt-row nt-solid px-3 font-medium">
            Install GitHub App
          </a>
        </div>
      )}
    </div>
  );
}

function InstallationRow({
  installation,
  edits,
  said,
}: {
  installation: Installation;
  edits: boolean;
  said: ReactNode;
}) {
  const org = installation.accountType === "Organization";
  return (
    <div className="nt-set-row" tabIndex={-1}>
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
        {said}
      </div>
      {/* GitHub opens an installation's settings to its account's owners only. */}
      {edits && (
        <div className="nt-set-actions">
          <a href={installation.manageUrl} target="_blank" rel="noreferrer" className="nt-row px-2.5">
            Manage on GitHub
          </a>
        </div>
      )}
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
  { id: "off", label: "Off", hint: "Only the GitHub App links repositories" },
  { id: "on", label: "On", hint: "Members may also link repositories with their own GitHub connection" },
];

/**
 * For owners and admins: whether a member's own connection may stand in for
 * the App, and the organisation rule. Either one that takes code away from
 * people asks first; giving it back is one press. A refusal puts it back.
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
  const [asking, setAsking] = useState<{ kind: "rule"; org: string } | { kind: "personal" } | null>(null);
  const trigger = useRef<{ focus: () => void }>(null);
  const proofPress = useRef<HTMLButtonElement>(null);

  const personal = status.allowPersonalTokens;
  const rule = status.requireGithubOrg;
  // Shut, the rule's folds go on drawing the organisation they last named.
  const [drawnRule, setDrawnRule] = useState(rule);
  if (rule && rule !== drawnRule) setDrawnRule(rule);
  const named = rule ?? drawnRule;
  // A rule first set here folds its proof row open; one there at load is simply there.
  const [ruleAtLoad] = useState(!!rule);
  const orgs = status.installations
    .filter(
      (i) => i.accountType === "Organization" && i.removedAt === undefined && i.suspendedAt === undefined,
    )
    .map((i) => i.accountLogin);

  const fail = (error: unknown) => setProblem(refusal(error, "That didn’t save. Try again in a moment."));
  const choosePersonal = (on: boolean) => {
    setProblem(null);
    if (!on) return setAsking({ kind: "personal" });
    update({ workspaceId: workspace.workspaceId, patch: { allowPersonalTokens: true } }).catch(fail);
  };
  const chooseRule = (org: string | null) => {
    setProblem(null);
    if (org !== null) return setAsking({ kind: "rule", org });
    setOrgRule({ workspaceId: workspace.workspaceId, org: null }).catch(fail);
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
              <Said open={personal}>
                {installed
                  ? "Members can also link repositories the GitHub App can’t reach, using their own GitHub connection. Turned off, those repositories stop being read."
                  : status.ready
                    ? "Members link repositories with their own GitHub connection. Install the GitHub App so linked code stays readable when that person leaves."
                    : "Members link repositories with their own GitHub connection."}
              </Said>
              <Said open={!personal}>
                {installed
                  ? "Only the GitHub App can link repositories."
                  : status.ready
                    ? "Only the GitHub App can link repositories. It isn’t installed, so no project here can read code yet."
                    : "Only the GitHub App can link repositories. No project here can read code while this is off."}
              </Said>
            </div>
            <div className="nt-set-actions">
              <Segmented
                label="Personal GitHub connections"
                segments={PERSONAL}
                value={personal ? "on" : "off"}
                onChange={(to) => choosePersonal(to === "on")}
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
              <Said open={!!rule}>
                Only members of <Login>{named}</Login> on GitHub can read this workspace’s code, owners
                and admins included, and anyone who leaves it loses access at once. Each person verifies
                here or from a project’s context every two weeks. Guests aren’t affected.
              </Said>
              <Said open={!rule}>
                {orgs.length
                  ? "Everyone in the workspace can read its linked code. Choose an organisation to limit it to that organisation’s members."
                  : status.ready
                    ? "Available once the GitHub App is installed on an organisation."
                    : "Available once Nootles can connect to GitHub."}
              </Said>
            </div>
            <div className="nt-set-actions">
              <Menu
                label="Required GitHub organisation"
                side="bottom"
                align="end"
                focusRef={trigger}
                trigger={(t) => (
                  <button
                    {...t}
                    disabled={!rule && !orgs.length}
                    aria-label={`Required GitHub organisation, ${rule ?? "off"}`}
                    className="nt-row nt-ws-pick gap-1.5 px-2.5"
                  >
                    <Login>{rule ?? "Off"}</Login>
                    <ChevronsUpDown width={14} height={14} aria-hidden="true" className="nt-ws-pick-glyph" />
                  </button>
                )}
              >
                {(close) =>
                  [null, ...orgs].map((org) => (
                    <MenuItem
                      key={org ?? "off"}
                      onClick={() => {
                        // An organisation asks first, in a box that takes focus as it
                        // opens; handed back to the trigger, it would be taken from it.
                        close(org !== null && org !== rule ? { restoreFocus: false } : undefined);
                        if (org !== rule) chooseRule(org);
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
        {named && (
          <li className="nt-ws-gh-proof">
            <Fold open={!!rule} arriving={!ruleAtLoad}>
              <div className="nt-ws-gh-proof-row">
                <ProofRow workspaceId={workspace.workspaceId} org={named} status={status} pressRef={proofPress} />
              </div>
            </Fold>
          </li>
        )}
      </ul>
      <Problem text={problem} />
      <p className="nt-set-note nt-ws-policy-aside">
        What guests can read is set in{" "}
        <Link href={`/w/${workspace.slug}/settings#nt-ws-sharing`} className="nt-ws-aside-link">
          General › Sharing
        </Link>
        .
      </p>

      {asking?.kind === "rule" && (
        <ConfirmBox
          label="Require GitHub organisation membership"
          question={`Require membership of ${asking.org}?`}
          action="Require membership"
          busyAction="Saving…"
          onConfirm={async () => {
            await setOrgRule({ workspaceId: workspace.workspaceId, org: asking.org });
            // Verifying is the next step the box promised; its press is already open.
            (proofPress.current ?? trigger.current)?.focus();
            setAsking(null);
          }}
          onClose={() => {
            trigger.current?.focus();
            setAsking(null);
          }}
        >
          Everyone in {workspace.name}, including you, loses access to the workspace’s code until
          they verify they’re in <Login>{asking.org}</Login> on GitHub
          {rule && (
            <>
              , even anyone verified for <Login>{rule}</Login>
            </>
          )}
          . You can verify on this page right after.
        </ConfirmBox>
      )}
      {asking?.kind === "personal" && (
        <ConfirmBox
          label="Turn off personal GitHub connections"
          question="Turn off personal GitHub connections?"
          action="Turn off"
          busyAction="Turning off…"
          onConfirm={async () => {
            await update({ workspaceId: workspace.workspaceId, patch: { allowPersonalTokens: false } });
            setAsking(null);
          }}
          onClose={() => setAsking(null)}
        >
          Repositories that members linked with their own GitHub accounts stay linked, but no
          project reads them while this is off. Turning it back on brings them back.
          {!installed &&
            (status.ready
              ? " Until the GitHub App is installed, no project here reads code."
              : " The GitHub App can’t be set up here, so no project here reads code.")}
        </ConfirmBox>
      )}
    </section>
  );
}

/** A GitHub login, which a line may not break at its hyphen. */
function Login({ children }: { children: ReactNode }) {
  return <span className="whitespace-nowrap">{children}</span>;
}

/** Where you stand with the organisation rule, and the press that proves it. */
function ProofRow({
  workspaceId,
  org,
  status,
  pressRef,
}: {
  workspaceId: Id<"workspaces">;
  org: string;
  status: Status;
  pressRef?: Ref<HTMLButtonElement>;
}) {
  const proof = useOrgProof(workspaceId, org);
  const { passes, verifiedAt, login } = status.orgProof;
  const verified = passes && !!verifiedAt;
  const hidden = verifiedAt
    ? "Your last check is over two weeks old. Until you verify again, this workspace’s code is hidden from you."
    : "Not verified. Until you are, this workspace’s code is hidden from you.";
  // Each line goes on drawing what it last said while it folds shut.
  const [drawn, setDrawn] = useState({ at: verifiedAt, login, hidden });
  if (verified && (verifiedAt !== drawn.at || login !== drawn.login)) setDrawn({ ...drawn, at: verifiedAt, login });
  if (!verified && hidden !== drawn.hidden) setDrawn({ ...drawn, hidden });
  return (
    <div className="nt-set-row">
      <span className="nt-set-glyph">
        <GitHubMark />
      </span>
      <div className="nt-set-body-col">
        <div className="nt-set-name">
          Your membership of <Login>{org}</Login>
        </div>
        <Fold open={verified}>
          <div className="nt-set-meta">
            Verified{drawn.at ? ` ${WHEN.format(drawn.at)}` : ""}
            {drawn.login ? ` · @${drawn.login}` : ""}
          </div>
        </Fold>
        <Fold open={!verified}>
          <p className="nt-set-note">{drawn.hidden}</p>
        </Fold>
        {proof.blocker && (
          <Fold arriving>
            <p className="nt-set-problem">{proof.blocker}</p>
          </Fold>
        )}
        {/* Shut while another press is on its way, holding the last answer; a
            new one is a new line, so it is announced even when it repeats. */}
        {proof.line && (
          <Fold arriving open={!!proof.said}>
            <p
              key={proof.line.n}
              role={proof.line.problem ? "alert" : "status"}
              className={`nt-set-outcome ${proof.line.problem ? "nt-set-problem" : "nt-set-note"}`}
            >
              <span>{proof.line.text}</span>
            </p>
          </Fold>
        )}
      </div>
      {proof.action && (
        <div className="nt-set-actions">
          <button
            ref={pressRef}
            type="button"
            onClick={proof.action.run}
            // Not `disabled`: a disabled button drops the focus that pressed it.
            aria-disabled={proof.action.busy}
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

const RETRY = "Try again, or contact support if it keeps happening.";
const WHICH_ACCOUNT =
  "GitHub didn’t confirm you have access to that account. Check you’re signed in to the right GitHub account, then try again.";

const FAILED: Record<InstallFailure, string> = {
  state: "The install started in another browser or took too long. Press Install to try again.",
  no_code: `Nootles couldn’t finish setting up with GitHub. ${RETRY}`,
  no_installation: "GitHub came back without an installation. Try again.",
  verify: WHICH_ACCOUNT,
  unconfigured: `Nootles couldn’t finish setting up with GitHub. ${RETRY}`,
  unauthorised: "GitHub didn’t accept the authorisation it asked you for. Try again.",
  unreachable: WHICH_ACCOUNT,
  not_owner: "Only an owner of that organisation on GitHub can add it. Ask one of them to install it from this page.",
  not_holder: "Only the person whose GitHub account it is can add it.",
};

/**
 * How the round trip to GitHub ended, read once off the address the setup
 * route sent the browser back to (`?github=`), and the address cleaned at
 * once so a reload does not report it again — `useNotionOutcome`'s way.
 */
function useInstallOutcome(): { line: Line | null; dismiss: () => void } {
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

function describe(outcome: InstallOutcome, reason: string | null): Line {
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
        text: `The GitHub App wasn’t added. ${why ?? "Try again."}`,
        problem: true,
      };
    }
  }
}
