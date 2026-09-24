/**
 * What a workspace's audit log says, in words: who acted, what they did as a
 * sentence that finishes their name, when, and the same as a CSV file.
 *
 * Pure, so the screen and the export say one thing and a test can read it.
 * One rule for names: a thing's current name is a part of its own — a
 * project, which the screen links while it still leads somewhere, or any
 * other name, which it sets as a noun — and a former name is quoted text.
 */

type Person = { name: string | null; email: string | null } | null;

/** One event as `audit.list` and `audit.exportRows` hand it over. */
export type AuditRow = {
  at: number;
  action: string;
  actorId: string;
  actorKind: "user" | "operator" | "system";
  actor: Person;
  subjectKind: string | null;
  subjectId: string | null;
  subject: Person;
  meta: Record<string, string | number | boolean | null>;
  count: number | null;
};

export type Part = string | { project: string; title: string } | { name: string };

const SYSTEMS: Record<string, string> = { github: "GitHub", stripe: "Stripe" };

/** What the log calls whoever acted. `me` is the reader's own id. */
export function actorName(row: AuditRow, me: string | null): string {
  if (row.actorKind === "operator") return "Nootles support";
  if (row.actorKind === "system") return SYSTEMS[row.actorId] ?? "Nootles";
  if (row.actorId === me) return "You";
  return row.actor?.name ?? row.actor?.email ?? "Someone";
}

const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

const quoted = (value: unknown) => `“${String(value ?? "")}”`;
const noun = (value: unknown): Part => ({ name: String(value ?? "") });

const ROLE: Record<string, string> = {
  owner: "an owner",
  admin: "an admin",
  member: "a member",
  guest: "a guest",
  editor: "an editor",
  viewer: "a viewer",
};
const roleWord = (role: unknown) => ROLE[String(role)] ?? String(role);
const Title = (role: unknown) => {
  const word = String(role ?? "");
  return word.charAt(0).toUpperCase() + word.slice(1);
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

const unsubscribed = (status: unknown) => status === "none" || status == null;

/** Stripe statuses that start a subscription's life, before it is paid for. */
const opening = (status: unknown) => unsubscribed(status) || status === "incomplete";

/**
 * A change of Stripe status, said as what it means for the workspace:
 * "marked the subscription past due after a failed payment".
 */
function subscription(from: unknown, to: unknown): string {
  if (unsubscribed(to) || to === "canceled" || to === "incomplete_expired") {
    return "ended the subscription";
  }
  switch (to) {
    case "incomplete":
      return "opened the subscription, waiting on its first payment";
    case "trialing":
      return opening(from)
        ? "started a trial of the subscription"
        : "put the subscription on a trial";
    case "active":
      if (opening(from)) return "started the subscription";
      if (from === "trialing") return "started paying for the subscription after its trial";
      if (from === "paused") return "resumed the subscription";
      return "marked the subscription paid up";
    case "past_due":
      return "marked the subscription past due after a failed payment";
    case "unpaid":
      return "marked the subscription unpaid after its payments failed";
    case "paused":
      return "paused the subscription";
  }
  return `marked the subscription ${String(to).replaceAll("_", " ")}`;
}

/** What a plan override is called in a sentence, for the features a plan sets. */
const FEATURE: Record<string, string> = {
  auditLog: "the audit log",
  unmetered: "unmetered AI",
  guestDailyAiUsd: "the guests’ daily AI allowance",
};
const featureName = (feature: unknown) => FEATURE[String(feature)] ?? "a plan feature";
const dollars = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

function override(feature: unknown, value: unknown): string {
  if (feature === "plan") return `put this workspace on the ${Title(value)} plan`;
  const name = featureName(feature);
  if (typeof value === "boolean") return `turned ${value ? "on" : "off"} ${name} for this workspace`;
  if (typeof value === "number" && feature === "guestDailyAiUsd") {
    return `set ${name} to ${dollars(value)}`;
  }
  return `set ${name} to ${value}`;
}

/** A page or folder as a sentence names it: the page Launch. */
const nameOf = (row: AuditRow): Part[] => [
  `the ${row.subjectKind} `,
  noun(row.meta[row.subjectKind ?? ""]),
];

/** A folder's pages, when it carried any. */
const withPages = (m: AuditRow["meta"]) =>
  typeof m.pages === "number" && m.pages > 0 ? [`, with ${plural(m.pages, "page")}`] : [];

/** Who an event was done to: a name, or "someone" when the log no longer knows. */
function subjectPart(row: AuditRow): Part {
  const name = row.subject?.name ?? row.subject?.email;
  return name ? noun(name) : "someone";
}

/**
 * What was done, as the rest of a sentence that starts with who did it:
 * "removed Tom from Acme", "edited Roadmap in Launch · 37 changes".
 */
export function whatParts(row: AuditRow, workspaceName: string): Part[] {
  const m = row.meta;
  const projectId = typeof m.projectId === "string" ? m.projectId : null;
  const projectTitle = String(m.project ?? "a project");
  const project: Part = projectId ? { project: projectId, title: projectTitle } : projectTitle;
  const link = String(m.role) === "editor" ? "editor link" : "viewer link";
  const who = subjectPart(row);
  const workspace = noun(workspaceName);

  switch (row.action) {
    case "workspace.create":
      return ["created the workspace ", noun(m.name ?? workspaceName)];
    case "workspace.rename":
      return [`renamed the workspace from ${quoted(m.from)} to `, noun(m.to)];
    case "workspace.slug":
      return [`moved the workspace’s address from /w/${m.from} to /w/${m.to}`];
    case "workspace.settings":
      return setting(m);
    case "workspace.delete":
      return [
        "deleted the workspace ",
        noun(m.name ?? workspaceName),
        ...(typeof m.projects === "number" ? [`, with ${plural(m.projects, "project")}`] : []),
      ];

    case "member.invite":
      return m.renewed
        ? ["renewed the invitation for ", noun(m.email)]
        : ["invited ", noun(m.email), ` as ${roleWord(m.role)}`];
    case "member.invite.revoke":
      return ["revoked the invitation for ", noun(m.email)];
    case "member.join":
      return [
        `joined as ${roleWord(m.role)}`,
        m.via === "domain" ? " by email domain" : " by invitation",
      ];
    case "member.role":
      return ["changed ", who, `’s role from ${m.from} to ${m.to}`];
    case "member.remove":
      return ["removed ", who, " from ", workspace];
    case "member.leave":
      return ["left ", workspace];

    case "share.link.on":
      return [
        `turned on the ${link} for `,
        project,
        ...(typeof m.expiresAt === "number" ? [`, until ${DATE.format(m.expiresAt)}`] : []),
      ];
    case "share.link.off":
      return [`turned off the ${link} for `, project];
    case "share.link.expiry":
      return typeof m.expiresAt === "number"
        ? [`set the ${link} for `, project, ` to expire on ${DATE.format(m.expiresAt)}`]
        : [`set the ${link} for `, project, " to never expire"];
    case "share.claim":
      return [m.renewed ? "came back to " : "opened ", project, ` with its ${link}`];
    case "share.claim.revoke":
      return ["took away ", who, "’s access to ", project];
    case "share.code.grant":
      return ["let ", who, " read the code of ", project];
    case "share.code.revoke":
      return ["stopped letting ", who, " read the code of ", project];
    case "share.request.grant":
      return ["let ", who, " edit ", project];
    case "share.request.deny":
      return ["turned down ", who, "’s request to edit ", project];

    case "project.create":
      return [m.visibility === "private" ? "created the private project " : "created the project ", project];
    case "project.rename":
      return [
        `renamed the project from ${quoted(m.from)} to `,
        projectId ? { project: projectId, title: String(m.to) } : noun(m.to),
      ];
    case "project.delete":
      return [m.discarded ? "discarded the new project " : "deleted the project ", project];
    case "project.restore":
      return ["restored the project ", project];

    case "page.edit":
      return [
        "edited ",
        noun(m.page),
        " in ",
        project,
        ...(row.count && row.count > 1 ? [` · ${plural(row.count, "change")}`] : []),
      ];
    case "page.delete":
    case "folder.delete":
      return ["deleted ", ...nameOf(row), " from ", project, ...withPages(m)];
    case "page.restore":
    case "folder.restore":
      return ["restored ", ...nameOf(row), " in ", project, ...withPages(m)];
    case "page.move":
    case "folder.move":
      return [
        "moved ",
        ...nameOf(row),
        " from ",
        project,
        " to ",
        typeof m.toProjectId === "string"
          ? { project: m.toProjectId, title: String(m.toProject ?? "a project") }
          : String(m.toProject ?? "another project"),
        ...withPages(m),
      ];
    case "page.carryOut":
    case "folder.carryOut":
      return [
        m.move ? "moved " : "copied ",
        ...nameOf(row),
        " out of ",
        project,
        m.to === "personal" ? ", into a personal project" : ", into another workspace",
        ...withPages(m),
      ];

    case "file.add":
      return [m.replaced ? "replaced the file " : "added the file ", noun(m.file), " in ", project];
    case "file.remove":
      return ["removed the file ", noun(m.file), " from ", project];
    case "repo.link":
      return [
        "linked ",
        noun(m.repo),
        " to ",
        project,
        ...(m.via === "personal" ? [", with their own GitHub"] : []),
      ];
    case "repo.unlink":
      return [
        "unlinked ",
        noun(m.repo),
        " from ",
        project,
        ...(m.reason ? [`, as it was ${m.reason}`] : []),
      ];
    case "notion.link":
      return ["linked the Notion page ", noun(m.page), " to ", project];
    case "notion.unlink":
      return [
        "unlinked the Notion page ",
        noun(m.page),
        " from ",
        project,
        ...(m.reason ? [`, as it was ${m.reason}`] : []),
      ];

    case "github.installation.record":
      return [
        m.reinstalled ? "reconnected the GitHub App on " : "installed the GitHub App on ",
        noun(m.account),
        ...(m.suspended ? [" (it’s suspended)"] : []),
      ];
    case "github.installation.remove":
      return [
        "uninstalled the GitHub App from ",
        noun(m.account),
        ...(typeof m.unlinked === "number" && m.unlinked > 0
          ? [`, unlinking ${plural(m.unlinked, "repository", "repositories")}`]
          : []),
      ];
    case "github.installation.suspend":
      return ["suspended the GitHub App on ", noun(m.account)];
    case "github.installation.unsuspend":
      return ["unsuspended the GitHub App on ", noun(m.account)];
    case "github.orgRule":
      return orgRule(m.to);

    case "billing.checkout":
      return [
        "started checkout for the Team plan",
        ...(typeof m.seats === "number" ? [`, ${plural(m.seats, "seat")}`] : []),
      ];
    case "billing.subscription":
      return [subscription(m.from, m.to)];
    case "billing.seats":
      return [`changed the seats billed from ${m.from ?? 0} to ${m.to}`];

    case "entitlement.set":
      return [
        override(m.feature, m.value),
        ...(typeof m.expiresAt === "number" ? [`, until ${DATE.format(m.expiresAt)}`] : []),
      ];
    case "entitlement.clear":
      return [
        m.feature === "plan"
          ? "removed the plan Nootles support had set for this workspace"
          : `reset ${featureName(m.feature)} to what the plan includes`,
      ];
    case "operator.standIn":
      return ["viewed the workspace as ", who];

    default:
      return [`made a change (${row.action})`];
  }
}

const orgRule = (org: unknown): Part[] =>
  org
    ? ["required every member to belong to the GitHub organisation ", noun(org)]
    : ["stopped requiring a GitHub organisation"];

function setting(m: AuditRow["meta"]): Part[] {
  const on = m.to === true;
  switch (m.setting) {
    case "linkSharing":
      return [on ? "turned share links on" : "turned share links off"];
    case "guestCodeAccess":
      return [on ? "let guests be given code access" : "stopped letting guests be given code access"];
    case "autoJoin":
      return [on ? "turned joining by email domain on" : "turned joining by email domain off"];
    case "joinDomains":
      return [m.to ? `set the join domains to ${m.to}` : "removed every join domain"];
    case "requireGithubOrg":
      return orgRule(m.to);
    case "allowPersonalTokens":
      return [on ? "allowed personal GitHub connections" : "stopped personal GitHub connections"];
    case "linkTtlDays":
      return [
        typeof m.to === "number"
          ? `set new share links to expire after ${plural(m.to, "day")}`
          : "set new share links to never expire",
      ];
    default:
      return [`changed a setting (${m.setting})`];
  }
}

/** The sentence as plain text, for the file and for a screen reader. */
export function whatText(row: AuditRow, workspaceName: string): string {
  return whatParts(row, workspaceName)
    .map((part) => (typeof part === "string" ? part : "project" in part ? part.title : part.name))
    .join("");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SHORT = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/**
 * "now", "5m", "3h", "2d" within a week; then the day, and the year too once
 * it is another — "Sep 3, 2025", never a month and year that reads as a day.
 */
export function ago(at: number, now: number): string {
  const since = Math.max(0, now - at);
  if (since < MINUTE) return "now";
  if (since < HOUR) return `${Math.floor(since / MINUTE)}m`;
  if (since < DAY) return `${Math.floor(since / HOUR)}h`;
  if (since < 7 * DAY) return `${Math.floor(since / DAY)}d`;
  return new Date(at).getFullYear() === new Date(now).getFullYear()
    ? SHORT.format(at)
    : DATE.format(at);
}

// ---- The file ----------------------------------------------------------------

const COLUMNS = [
  "time_utc",
  "actor",
  "actor_email",
  "actor_kind",
  "action",
  "description",
  "subject_kind",
  "subject_id",
  "project_id",
  "count",
] as const;

/**
 * One field: quoted where it has to be, and a leading = + - @ neutralised, so
 * a project someone titled like a formula opens in a spreadsheet as text.
 */
function field(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The log as a CSV file, one row per event, in the order given. */
export function toCsv(rows: AuditRow[], workspaceName: string): string {
  const lines = rows.map((row) => {
    const who = actorName(row, null);
    return [
      new Date(row.at).toISOString(),
      who,
      row.actorKind === "user" ? (row.actor?.email ?? null) : null,
      row.actorKind,
      row.action,
      `${who} ${whatText(row, workspaceName)}`,
      row.subjectKind,
      row.subjectId,
      typeof row.meta.projectId === "string" ? row.meta.projectId : null,
      row.count,
    ]
      .map(field)
      .join(",");
  });
  return [COLUMNS.join(","), ...lines].join("\r\n") + "\r\n";
}
