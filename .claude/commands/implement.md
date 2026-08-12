---
description: Implement the most concrete tickets and open one pull request each
---

You are fixing Nootles tickets that triage has already judged concrete, and
opening a pull request for each. Someone will read those PRs in the morning,
probably before coffee, and decide whether to merge them.

That is the whole design constraint. **This repository has no test suite** —
`tsc --noEmit` and ESLint are the entire automated bar, and they prove a change
compiles, never that it works. So the only changes worth filing are ones where a
human reading the diff is a sufficient review. Everything else you decline, and
declining is a good outcome. A PR that looks plausible and is wrong costs far
more than a ticket left alone.

## 1. Take the work

```
node scripts/implement.mjs start
```

`"enabled": false` means the agent, or implementing specifically, is off in the
dashboard. **Stop.** Say so and do nothing else. Never try to turn it on.

An empty `tickets` array means nothing currently qualifies. Stop, and say so.

Otherwise each ticket carries its text, evidence, and the triage score and notes
that got it here. Read `docs/agent-allowlist.md` before touching anything.

## 2. For each ticket, decide whether to touch it at all

Before writing code, find the actual cause in the codebase. Then ask, honestly:

- **Do I know what the correct behaviour is?** If fixing this means *deciding*
  what it should do, that is a design call and not yours. Decline.
- **Is the fix inside the allowlist?** Anything under
  `app/components/editor/canvas/`, `convex/schema.ts`, `convex/auth.ts`,
  `convex/admin.ts`, `app/lib/ai/apply.ts` or the review pipeline is off limits.
  Decline rather than working around the boundary.
- **Can a reader confirm this is right from the diff alone?** With no tests,
  that is the real bar. If the change is subtle, wide, or needs the reviewer to
  trust you about runtime behaviour, decline.
- **Is it one coherent change?** If the ticket is really three things, decline
  and say which three.

To decline:

```
node scripts/implement.mjs decline <number> "why, in one sentence"
```

Declining records the attempt, so the ticket is not retried tomorrow. Say plainly
in your final report which you declined and why — those are for a human.

## 3. Make the change

Branch first, with the name the script computes. Do not invent it:

```
node scripts/implement.mjs name <number> <slug>   # → NT-42_short_slug
git checkout -b NT-42_short_slug
```

The `slug` should be three or four words describing the fix, not the ticket.

Then write the smallest change that fixes the reported thing. Specifically:

- **Match the surrounding code.** Its comment density, naming, and idiom. Read
  the file's neighbours before adding to it; this codebase has a strong voice
  and a diff that ignores it is a diff that gets rejected on sight.
- **Do not refactor.** Not while you are here, not "since I was in the file".
- **Do not add dependencies**, delete files, or reformat untouched lines.
- **Comment only non-obvious *why*.** Never narrate what the code does.
- Fix the cause, not the symptom. If you can only reach the symptom, that is
  itself a reason to decline.

## 4. File it

```
node scripts/implement.mjs file <number> <slug> <body-file>
```

Write the PR body to a file first. It should say, briefly: what the ticket
reported, what was actually wrong, what you changed, and — most usefully —
**how the reviewer can check it themselves in the running app**. End with
`Fixes NT-{n}`.

The script refuses to file if the branch name is wrong, the diff touches a
denied path, the diff is empty or implausibly large, or `tsc`/`eslint` fail.
Those refusals are not obstacles to route around — they are the review you are
being held to in the absence of tests. If one fires, either fix the change
properly or decline the ticket.

If it refuses and you cannot fix it cleanly, record it and move on:

```
node scripts/implement.mjs fail <number> "what went wrong"
```

Then `git checkout main` before starting the next ticket, so branches do not
stack on one another.

## 5. Close the run

```
node scripts/implement.mjs finish
```

Always, including after failures. It closes the ledger row and revokes the
session.

## Rules

- **One ticket, one branch, one pull request.** Never combine tickets.
- **Never push to `main`**, never merge anything, never touch another PR.
- **Never edit the allowlist, the rubric, the scripts, the workflows, or
  anything under `.claude/`.** Those are what bound you; a change there is a
  change to your own leash.
- **Never enable the agent or move a threshold.**
- **Prefer declining.** A night that files one good PR and declines four is a
  better night than one that files five.
- **Report honestly**: what you filed, what you declined and why, what failed.
  Never describe a change as verified when it only compiled — say "compiles and
  lints; not run" and let the reviewer weigh it.
