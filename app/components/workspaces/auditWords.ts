/**
 * What a workspace's audit log says, in words: who acted, what they did as a
 * sentence that finishes their name, when, and the same as a CSV file.
 *
 * Pure, so the screen and the export say one thing and a test can read it.
 * A project is a part of its own, so the screen can make it a link while it
 * still leads somewhere; everything else is text.
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

export type Part = string | { project: string; title: string };

const SYSTEMS: Record<string, string> = { github: "GitHub", stripe: "Stripe" };

/** What the log calls whoever acted. `me` is the reader's own id. */
export function actorName(row: AuditRow, me: string | null): string {
  if (row.actorKind === "operator") return "Nootles support";
  if (row.actorKind === "system") return SYSTEMS[row.actorId] ?? "Nootles";
  if (row.actorId === me) return "You";
  return row.actor?.name ?? row.actor?.email ?? "Someone";
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

const quoted = (value: unknown) => `“${String(value ?? "")}”`;

const ROLE: Record<string, string> = {
  owner: "an owner",
  admin: "an admin",
  member: "a member",
  guest: "a guest",
  editor: "an editor",
  viewer: "a viewer",
};
const roleWord = (role: unknown) => ROLE[String(role)] ?? String(role);
const Role = (role: unknown) => {
  const word = String(role ?? "");
  return word.charAt(0).toUpperCase() + word.slice(1);
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/** A Stripe status as a sentence says it: "past due", "no subscription". */
const statusWord = (status: unknown) =>
  status === "none" || status == null ? "none" : String(status).replaceAll("_", " ");

function subjectName(row: AuditRow): string {
  return row.subject?.name ?? row.subject?.email ?? "someone";
}

/**
 * What was done, as the rest of a sentence that starts with who did it:
 * "removed Tom from Acme", "edited “Roadmap” in Launch · 37 changes".
 */
export function whatParts(row: AuditRow, workspaceName: string): Part[] {
  const m = row.meta;
  const projectId = typeof m.projectId === "string" ? m.projectId : null;
  const projectTitle = String(m.project ?? "a project");
  const project: Part = projectId ? { project: projectId, title: projectTitle } : projectTitle;
  const link = String(m.role) === "editor" ? "edit link" : "view link";
  const who = subjectName(row);

  switch (row.action) {
    case "workspace.create":
      return [`created ${m.name ?? workspaceName}`];
    case "workspace.rename":
      return [`renamed the workspace from ${quoted(m.from)} to ${quoted(m.to)}`];
    case "workspace.slug":
      return [`moved the workspace’s address from /w/${m.from} to /w/${m.to}`];
    case "workspace.settings":
      return [setting(m)];
    case "workspace.delete":
      return [
        `deleted ${m.name ?? workspaceName}`,
        ...(typeof m.projects === "number" ? [`, with ${plural(m.projects, "project")}`] : []),
      ];

    case "member.invite":
      return [
        m.renewed
          ? `renewed the invitation for ${m.email}`
          : `invited ${m.email} as ${roleWord(m.role)}`,
      ];
    case "member.invite.revoke":
      return [`revoked the invitation for ${m.email}`];
    case "member.join":
      return [
        `joined as ${roleWord(m.role)}`,
        m.via === "domain" ? " through their email’s domain" : " by invitation",
      ];
    case "member.role":
      return [`changed ${who}’s role from ${Role(m.from)} to ${Role(m.to)}`];
    case "member.remove":
      return [`removed ${who} from ${workspaceName}`];
    case "member.leave":
      return [`left ${workspaceName}`];

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
        ? [`set the ${link} for `, project, ` to run out on ${DATE.format(m.expiresAt)}`]
        : [`set the ${link} for `, project, " to never run out"];
    case "share.claim":
      return [m.renewed ? "came back to " : "opened ", project, ` with its ${link}`];
    case "share.claim.revoke":
      return [`took away ${who}’s access to `, project];
    case "share.code.grant":
      return [`let ${who} read the code of `, project];
    case "share.code.revoke":
      return [`stopped ${who} reading the code of `, project];
    case "share.request.grant":
      return [`let ${who} edit `, project];
    case "share.request.deny":
      return [`turned down ${who}’s request to edit `, project];

    case "project.create":
      return ["created ", project, ...(m.visibility === "private" ? [", as a private project"] : [])];
    case "project.rename":
      return [
        `renamed ${quoted(m.from)} to `,
        projectId ? { project: projectId, title: String(m.to) } : String(m.to),
      ];
    case "project.delete":
      return ["deleted ", project];
    case "project.restore":
      return ["restored ", project];

    case "page.edit":
      return [
        `edited ${quoted(m.page)} in `,
        project,
        ...(row.count && row.count > 1 ? [` · ${plural(row.count, "change")}`] : []),
      ];
    case "page.delete":
    case "folder.delete":
      return [`deleted the ${row.subjectKind} ${quoted(m[row.subjectKind ?? ""])} from `, project];
    case "page.restore":
    case "folder.restore":
      return [`restored the ${row.subjectKind} ${quoted(m[row.subjectKind ?? ""])} in `, project];
    case "page.carryOut":
    case "folder.carryOut":
      return [
        `${m.move ? "moved" : "copied"} the ${row.subjectKind} ${quoted(m[row.subjectKind ?? ""])} out of `,
        project,
        m.to === "personal" ? ", into a personal project" : ", into another workspace",
      ];

    case "file.add":
      return [`${m.replaced ? "replaced" : "added"} the file ${quoted(m.file)} in `, project];
    case "file.remove":
      return [`removed the file ${quoted(m.file)} from `, project];
    case "repo.link":
      return [
        `linked ${m.repo} to `,
        project,
        ...(m.via === "personal" ? [", with their own GitHub"] : []),
      ];
    case "repo.unlink":
      return [
        `unlinked ${m.repo} from `,
        project,
        ...(m.reason ? [`, as it was ${m.reason}`] : []),
      ];
    case "notion.link":
      return [`linked the Notion page ${quoted(m.page)} to `, project];
    case "notion.unlink":
      return [`unlinked the Notion page ${quoted(m.page)} from `, project];

    case "github.installation.record":
      return [
        `${m.reinstalled ? "reconnected" : "installed"} the GitHub App on ${m.account}`,
        ...(m.suspended ? [", suspended"] : []),
      ];
    case "github.installation.remove":
      return [
        `uninstalled the GitHub App from ${m.account}`,
        ...(typeof m.unlinked === "number" && m.unlinked > 0
          ? [`, unlinking ${plural(m.unlinked, "repository", "repositories")}`]
          : []),
      ];
    case "github.installation.suspend":
      return [`suspended the GitHub App on ${m.account}`];
    case "github.installation.unsuspend":
      return [`unsuspended the GitHub App on ${m.account}`];
    case "github.orgRule":
      return [
        m.to
          ? `required every member to belong to the GitHub organisation ${m.to}`
          : "stopped requiring a GitHub organisation",
      ];

    case "billing.checkout":
      return [
        "started checkout for the Team plan",
        ...(typeof m.seats === "number" ? [`, ${plural(m.seats, "seat")}`] : []),
      ];
    case "billing.subscription":
      return [`moved the subscription from ${statusWord(m.from)} to ${statusWord(m.to)}`];
    case "billing.seats":
      return [`changed the seats billed from ${m.from ?? 0} to ${m.to}`];

    case "entitlement.set":
      return [
        `set ${m.feature} to ${m.value} for this workspace`,
        ...(typeof m.expiresAt === "number" ? [`, until ${DATE.format(m.expiresAt)}`] : []),
      ];
    case "entitlement.clear":
      return [`cleared the override of ${m.feature}`];
    case "operator.standIn":
      return [`stood in for ${who}`, ...(m.reason ? [`: ${quoted(m.reason)}`] : [])];

    default:
      return [row.action];
  }
}

function setting(m: AuditRow["meta"]): string {
  const on = m.to === true;
  switch (m.setting) {
    case "linkSharing":
      return on ? "turned share links on" : "turned share links off";
    case "guestCodeAccess":
      return on ? "let guests be given code access" : "stopped guests being given code access";
    case "autoJoin":
      return on ? "turned joining by email domain on" : "turned joining by email domain off";
    case "joinDomains":
      return m.to ? `set the join domains to ${m.to}` : "removed every join domain";
    case "requireGithubOrg":
      return m.to
        ? `required every member to belong to the GitHub organisation ${m.to}`
        : "stopped requiring a GitHub organisation";
    case "allowPersonalTokens":
      return on ? "allowed personal GitHub connections" : "stopped personal GitHub connections";
    case "linkTtlDays":
      return typeof m.to === "number"
        ? `set new share links to run out after ${plural(m.to, "day")}`
        : "set new share links to never run out";
    default:
      return `changed the setting ${m.setting}`;
  }
}

/** The sentence as plain text, for the file and for a screen reader. */
export function whatText(row: AuditRow, workspaceName: string): string {
  return whatParts(row, workspaceName)
    .map((part) => (typeof part === "string" ? part : part.title))
    .join("");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** "now", "5m", "3h", "2d" within a week; then the date, with the year once it is another. */
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
  "time",
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
