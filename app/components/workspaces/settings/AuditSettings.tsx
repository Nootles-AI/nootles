"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConvex, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { projectPath, settingsPath } from "@/app/lib/containerPaths";
import { Check, ChevronsUpDown, Download } from "../../Icons";
import { Menu, MenuItem } from "../../Menu";
import { Tooltip } from "../../Tooltip";
import { useMoment } from "../useMoment";
import { useContainer, type WorkspaceContainer } from "../ContainerContext";
import { actorName, ago, toCsv, whatParts, type AuditRow } from "../auditWords";
import { initial, useNaming } from "../people";
import { refusal } from "../refusal";
import { Bone } from "./MembersSettings";

type Event = FunctionReturnType<typeof api.audit.list>["page"][number];
type Member = NonNullable<FunctionReturnType<typeof api.members.list>>["members"][number];

/** Rows a page of the log asks for. */
const PAGE = 40;

const FULL = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A row's place in the batch it arrived with, for the staggered entrance. */
const nth = (i: number) => ({ "--i": i % PAGE }) as CSSProperties;

/**
 * Kinds of event, in the order an admin looks for them, each a kind the
 * server narrows by. Edits are a kind of their own on the server, so pages
 * moved or deleted are a page's other events. `none` finishes "No …" when
 * the log has nothing of the kind.
 */
const KINDS: readonly { id: string; label: string; none: string }[] = [
  { id: "member", label: "Members", none: "membership events" },
  { id: "share", label: "Sharing", none: "sharing events" },
  { id: "page.edit", label: "Page edits", none: "page edits" },
  { id: "page", label: "Pages moved or deleted", none: "pages moved or deleted" },
  { id: "folder", label: "Folders", none: "folder events" },
  { id: "file", label: "Files", none: "file events" },
  { id: "project", label: "Projects", none: "project events" },
  { id: "integration", label: "Integrations", none: "integration events" },
  { id: "billing", label: "Billing and plan", none: "billing or plan events" },
  { id: "workspace", label: "Workspace", none: "workspace changes" },
  { id: "operator", label: "Support access", none: "support access" },
];

type Span = "all" | "today" | "7" | "30" | "90";

const SPANS: readonly { id: Span; label: string; during: string }[] = [
  { id: "all", label: "Any time", during: "" },
  { id: "today", label: "Today", during: " today" },
  { id: "7", label: "Past 7 days", during: " in the past 7 days" },
  { id: "30", label: "Past 30 days", during: " in the past 30 days" },
  { id: "90", label: "Past 90 days", during: " in the past 90 days" },
];

/**
 * Where a span starts: the start of a day, so the query's arguments hold
 * still between renders and the pages already loaded are kept.
 */
function spanStart(span: Span): number | undefined {
  if (span === "all") return undefined;
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  if (span !== "today") day.setDate(day.getDate() - (Number(span) - 1));
  return day.getTime();
}

/**
 * A workspace's audit log: who did what, and when, newest first.
 *
 * Admins and owners only — the section is not in anyone else's nav, and an
 * address typed in goes to the settings' first page. On a plan without the
 * log, it says what brings it; the log has been written all along.
 */
export function AuditSettings() {
  const container = useContainer();
  if (container.kind !== "workspace") return null;
  return <Audit workspace={container} />;
}

function Audit({ workspace }: { workspace: WorkspaceContainer }) {
  const router = useRouter();
  const access = useQuery(api.audit.access, { workspaceId: workspace.workspaceId });

  useEffect(() => {
    if (access === null) router.replace(settingsPath(workspace.slug));
  }, [access, router, workspace.slug]);

  if (access === undefined) return <Loading />;
  if (access === null) return null;
  if (!access.included) return <NotIncluded workspace={workspace} />;
  return <Log workspace={workspace} />;
}

function NotIncluded({ workspace }: { workspace: WorkspaceContainer }) {
  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-audit">
      <div className="nt-ws-set-head">
        <h2 id="nt-ws-audit" className="nt-set-label">
          Audit log
        </h2>
      </div>
      <ul className="nt-set-list">
        <li className="nt-set-row">
          <div className="nt-set-body-col">
            <p className="nt-set-name">The audit log comes with the Team plan</p>
            <p className="nt-set-note">
              {workspace.name} has been keeping one all along — who joined, who shared what, who
              edited which page. On Team, the past year of it is here to read and export.
            </p>
          </div>
          <div className="nt-set-actions">
            <Link href={settingsPath(workspace.slug, "billing")} className="nt-row px-2.5">
              See billing
            </Link>
          </div>
        </li>
      </ul>
    </section>
  );
}

function Log({ workspace }: { workspace: WorkspaceContainer }) {
  const [person, setPerson] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [span, setSpan] = useState<{ id: Span; from?: number }>({ id: "all" });
  const [problem, setProblem] = useState<string | null>(null);
  const people = useQuery(api.members.list, { workspaceId: workspace.workspaceId });
  const projects = useQuery(api.workspaces.projectsFor, { workspaceId: workspace.workspaceId });
  const members = people?.members ?? [];
  const me = members.find((m) => m.isMe)?.userId ?? null;
  const live = new Set(projects?.map((p) => p._id as string));

  const filters = {
    ...(person ? { actorId: person } : {}),
    ...(kind ? { action: kind } : {}),
    ...(span.from !== undefined ? { from: span.from } : {}),
  };
  const { results, status, loadMore } = usePaginatedQuery(
    api.audit.list,
    { workspaceId: workspace.workspaceId, filters },
    { initialNumItems: PAGE },
  );
  const filtered = !!(person || kind || span.from !== undefined);
  const choices = usePersonChoices(members, person);
  const said = filtered
    ? nothingFor(
        KINDS.find((k) => k.id === kind),
        person ? choices.find((c) => c.id === person)?.label : undefined,
        SPANS.find((s) => s.id === span.id),
      )
    : null;

  // A new filter is a new query, which starts from no rows: the last ones
  // stay on screen, dimmed, until the first page of the new one lands.
  const settled = status !== "LoadingFirstPage";
  const [held, setHeld] = useState<{ results: Event[]; said: string | null } | null>(null);
  if (settled && held?.results !== results) setHeld({ results, said });
  const shown = settled ? { results, said } : held;
  const stale = !settled && held !== null;

  const clear = () => {
    setPerson(null);
    setKind(null);
    setSpan({ id: "all" });
  };

  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-audit">
      <div className="nt-ws-set-head">
        <h2 id="nt-ws-audit" className="nt-set-label">
          Audit log
        </h2>
        <Export
          workspace={workspace}
          me={me}
          person={person}
          kind={kind}
          from={span.from}
          onProblem={setProblem}
        />
      </div>
      <p className="nt-set-note nt-ws-audit-note">
        Events are kept for a year. One person’s edits to a page within ten minutes show as a
        single row.
      </p>
      {problem && (
        <p role="alert" className="nt-set-problem mb-2">
          {problem}
        </p>
      )}
      <div className="nt-ws-filters" role="group" aria-label="Filter the log">
        <Picker label="Person" value={person} choices={choices} onChange={setPerson} />
        <Picker
          label="Kind of event"
          value={kind}
          choices={[{ id: null, label: "All events" }, ...KINDS]}
          onChange={setKind}
        />
        <Picker
          label="When"
          value={span.id}
          choices={SPANS}
          onChange={(id: Span) => setSpan({ id, from: spanStart(id) })}
        />
      </div>
      <div className="nt-ws-table" data-stale={stale || undefined} aria-busy={stale || undefined}>
        <Head />
        {shown === null ? (
          <Bones />
        ) : shown.results.length === 0 ? (
          shown.said ? (
            <div className="nt-ws-empty">
              <p className="text-[13px] font-medium">{shown.said}</p>
              <div className="mt-3 flex justify-center">
                <button type="button" onClick={clear} className="nt-row px-2.5">
                  Clear filters
                </button>
              </div>
            </div>
          ) : (
            <div className="nt-ws-empty">
              <p className="text-[13px] font-medium">Nothing here yet</p>
              <p className="mt-1 text-[13px] text-muted">
                Joins, sharing, projects and edits are written here as they happen.
              </p>
            </div>
          )
        ) : (
          <Events
            workspace={workspace}
            events={shown.results}
            me={me}
            live={live}
            more={status === "CanLoadMore" ? () => loadMore(PAGE) : null}
            loading={status === "LoadingMore"}
          />
        )}
      </div>
    </section>
  );
}

function Head() {
  return (
    <div className="nt-list-head nt-ws-ev-head" aria-hidden="true">
      <span className="nt-ws-ev-when">When</span>
      <span className="nt-ws-ev-who">Who</span>
      <span className="nt-ws-ev-what">What</span>
    </div>
  );
}

function Events({
  workspace,
  events,
  me,
  live,
  more,
  loading,
}: {
  workspace: WorkspaceContainer;
  events: Event[];
  me: string | null;
  /** Projects a link can still open. */
  live: Set<string>;
  /** Loads the next page; null when there is none to ask for yet. */
  more: (() => void) | null;
  loading: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const naming = useNaming();
  const end = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const target = end.current;
    if (!more || !target) return;
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) more();
      },
      { rootMargin: "240px" },
    );
    watch.observe(target);
    return () => watch.disconnect();
  }, [more]);

  return (
    <ul className="nt-ws-rows" aria-label={`What happened in ${workspace.name}`} aria-busy={loading}>
      {events.map((event, i) => {
        const self = event.actorKind === "user" && event.actorId === me;
        const name = actorName(event, me);
        // "You" in words; your own initial on the face, as the account menu draws you.
        const letter = self
          ? naming({ name: event.actor?.name ?? null, email: event.actor?.email ?? null, isMe: true })
              .name
          : name;
        return (
          <li key={event._id} style={nth(i)} className="nt-list-row nt-ws-event">
            <span className="nt-ws-ev-when nt-meta">
              <Tooltip label={FULL.format(event.at)}>
                <time dateTime={new Date(event.at).toISOString()}>{ago(event.at, now)}</time>
              </Tooltip>
            </span>
            <span className="nt-ws-ev-who">
              <Face event={event} name={letter} self={self} />
              <span className="nt-ws-ev-name">{name}</span>
            </span>
            <p className="nt-ws-ev-what">
              {whatParts(event, workspace.name).map((part, n) =>
                typeof part === "string" ? (
                  part
                ) : live.has(part.project) ? (
                  <Link
                    key={n}
                    href={projectPath(workspace.slug, part.project)}
                    className="nt-ws-aside-link nt-ws-ev-link"
                  >
                    {part.title}
                  </Link>
                ) : (
                  <span key={n} className="nt-ws-ev-gone">
                    {part.title}
                  </span>
                ),
              )}
            </p>
          </li>
        );
      })}
      {loading && <BoneRows count={3} />}
      <li ref={end} aria-hidden="true" className="nt-ws-ev-end" />
    </ul>
  );
}

/** Other people by their photo; you, support and the systems as a letter. */
function Face({ event, name, self }: { event: Event; name: string; self: boolean }) {
  const photo = event.actorKind === "user" && !self ? event.actor?.imageUrl : null;
  if (photo) {
    // Not next/image: Clerk's avatar hosts are not the optimizer's to fetch.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={photo} alt="" className="h-5 w-5 shrink-0 rounded-full" />;
  }
  return (
    <span className="nt-monogram shrink-0" aria-hidden="true">
      {initial(name)}
    </span>
  );
}

// ---- Filters -----------------------------------------------------------------

type Choice<T> = { id: T; label: string };

/** A filter's trigger: what it is set to, and the invite row's up-down glyph. */
function Picker<T extends string | null>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: readonly Choice<T>[];
  onChange: (id: T) => void;
}) {
  const current = choices.find((c) => c.id === value) ?? choices[0];
  return (
    <Menu
      label={label}
      side="bottom"
      align="start"
      className="nt-ws-filter-menu"
      trigger={(t) => (
        <button
          {...t}
          type="button"
          aria-label={`${label}: ${current.label}`}
          className="nt-row nt-ws-pick gap-1.5 px-2"
        >
          <span className="nt-ws-filter-value">{current.label}</span>
          <ChevronsUpDown width={14} height={14} aria-hidden="true" className="nt-ws-pick-glyph" />
        </button>
      )}
    >
      {(close) =>
        choices.map((choice) => (
          <MenuItem
            key={choice.id ?? ""}
            onClick={() => {
              onChange(choice.id);
              close();
            }}
          >
            <span className="nt-ws-filter-value">{choice.label}</span>
            <Check
              width={14}
              height={14}
              aria-hidden="true"
              className={`nt-menu-check${choice.id === value ? " is-on" : ""}`}
            />
          </MenuItem>
        ))
      }
    </Menu>
  );
}

/**
 * Everyone, or one member: you as the rows call you, first; the rest as the
 * members list calls them.
 */
function usePersonChoices(members: Member[], value: string | null): Choice<string | null>[] {
  const naming = useNaming();
  const choices: Choice<string | null>[] = [
    { id: null, label: "Everyone" },
    ...members.filter((m) => m.isMe).map((m) => ({ id: m.userId, label: "You" })),
    ...members.filter((m) => !m.isMe).map((m) => ({ id: m.userId, label: naming(m).name })),
  ];
  // Someone chosen who has since left is still who the log is narrowed to.
  if (value && !members.some((m) => m.userId === value)) {
    choices.push({ id: value, label: "Former member" });
  }
  return choices;
}

/** What an empty, narrowed log says: only the filters that narrow it. */
function nothingFor(
  kind: { none: string } | undefined,
  person: string | undefined,
  span: { during: string } | undefined,
): string {
  const who = person === undefined ? "" : person === "You" ? " from you" : ` from ${person}`;
  return `${kind ? `No ${kind.none}` : "Nothing"}${who}${span?.during ?? ""}`;
}

// ---- Export ------------------------------------------------------------------

/**
 * The log as a CSV file, for the span on screen and narrowed as the screen
 * is: read a page at a time, oldest first, built here, and handed to the
 * browser as a download.
 */
function Export({
  workspace,
  me,
  person,
  kind,
  from,
  onProblem,
}: {
  workspace: WorkspaceContainer;
  me: string | null;
  person: string | null;
  kind: string | null;
  from: number | undefined;
  onProblem: (text: string | null) => void;
}) {
  const convex = useConvex();
  const naming = useNaming();
  const [running, setRunning] = useState(false);
  // How many rows so far, said only once an export is slow enough to wait on.
  const [count, setCount] = useState<number | null>(null);
  const [done, flash] = useMoment();
  const slow = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(slow.current), []);

  // The file names you as the screen and the members list do, even while
  // your profile has not caught up with your sign-in.
  const yours = (person: AuditRow["actor"]): AuditRow["actor"] => {
    const named = naming({ name: person?.name ?? null, email: person?.email ?? null, isMe: true });
    if (!named.known) return person;
    return {
      name: named.name,
      email: named.mail ?? person?.email ?? (named.name.includes("@") ? named.name : null),
    };
  };
  const known = (row: AuditRow): AuditRow => ({
    ...row,
    actor: row.actorKind === "user" && row.actorId === me ? yours(row.actor) : row.actor,
    subject: row.subjectKind === "user" && row.subjectId === me ? yours(row.subject) : row.subject,
  });

  const run = async () => {
    if (running) return;
    onProblem(null);
    setRunning(true);
    const to = Date.now();
    const rows: AuditRow[] = [];
    slow.current = setTimeout(() => setCount(rows.length), 400);
    try {
      let cursor: string | null = null;
      for (;;) {
        const page: FunctionReturnType<typeof api.audit.exportRows> = await convex.query(
          api.audit.exportRows,
          {
            workspaceId: workspace.workspaceId,
            from: from ?? 0,
            to,
            filters: {
              ...(person ? { actorId: person } : {}),
              ...(kind ? { action: kind } : {}),
            },
            cursor,
          },
        );
        rows.push(...page.rows.map(known));
        setCount((shown) => (shown === null ? null : rows.length));
        if (page.done) break;
        cursor = page.cursor;
      }
      save(
        `${workspace.slug}-audit-${new Date(to).toISOString().slice(0, 10)}.csv`,
        toCsv(rows, workspace.name),
      );
      flash();
    } catch (error) {
      onProblem(refusal(error, "Couldn’t export the log. Try again in a moment."));
    } finally {
      clearTimeout(slow.current);
      setRunning(false);
      setCount(null);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void run()}
        aria-disabled={running || undefined}
        data-done={done || undefined}
        className="nt-row nt-ws-export gap-1.5 px-2"
      >
        <span className="nt-swap" aria-hidden="true">
          <Download width={14} height={14} />
          <Check width={14} height={14} />
        </span>
        {count !== null ? (
          <span>
            Exporting… <span className="tabular-nums">{count.toLocaleString()}</span>
          </span>
        ) : done ? (
          "Exported"
        ) : (
          "Export CSV"
        )}
      </button>
      <span role="status" className="sr-only">
        {running ? "Exporting the log" : done ? "Exported" : ""}
      </span>
    </>
  );
}

/** Hands a file to the browser to save, with a byte-order mark so Excel reads it as UTF-8. */
function save(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- While it loads ----------------------------------------------------------

/** The page's shape before the log arrives: its head, the filters, the table. */
function Loading() {
  return (
    <section className="nt-set-section" aria-busy="true" aria-label="Audit log">
      <div className="nt-ws-set-head">
        <Bone bar="h-3.5 w-20" />
        <div className="nt-ws-export flex h-8 items-center gap-1.5 px-2" aria-hidden="true">
          <div className="nt-skeleton h-3.5 w-3.5" />
          <div className="nt-skeleton h-3.5 w-16" />
        </div>
      </div>
      <Bone bar="h-3.5 w-[26rem] max-w-full" className="nt-ws-audit-note" />
      <div className="nt-ws-filters" aria-hidden="true">
        {["w-16", "w-16", "w-14"].map((w, i) => (
          <div key={i} className="flex h-8 items-center gap-1.5 px-2">
            <div className={`nt-skeleton h-3.5 ${w}`} />
            <div className="nt-skeleton h-3.5 w-3.5" />
          </div>
        ))}
      </div>
      <div className="nt-ws-table">
        <Head />
        <Bones />
      </div>
    </section>
  );
}

function Bones() {
  return (
    <ul className="nt-ws-rows" aria-hidden="true">
      <BoneRows count={6} />
    </ul>
  );
}

const SENTENCES = ["w-3/5", "w-4/5", "w-1/2", "w-2/3", "w-3/4", "w-2/5"];

/** Rows the size of an event's, each a different length of sentence. */
function BoneRows({ count }: { count: number }) {
  return Array.from({ length: count }, (_, i) => (
    <li key={`bone-${i}`} className="nt-ws-event" aria-hidden="true">
      <span className="nt-ws-ev-when">
        <Bone bar="h-3 w-7" />
      </span>
      <span className="nt-ws-ev-who">
        <span className="nt-skeleton h-5 w-5 shrink-0 rounded-full" />
        <Bone bar="h-3.5 w-20" />
      </span>
      <span className="nt-ws-ev-what">
        <Bone bar={`h-3.5 ${SENTENCES[i % SENTENCES.length]}`} className="w-full" />
      </span>
    </li>
  ));
}
