# What the agent may edit

The implement routine opens pull requests unattended, against a codebase with
**no test suite**. `tsc --noEmit` and ESLint are the entire automated bar — they
prove a change compiles, never that it works.

The rule that follows from that is *not* "keep away from the important code".
That was the first draft of this file and it was wrong: it fenced off the canvas,
which is where most of the backlog lives, so the routine spent its nightly budget
declining tickets it was never allowed to touch. Protecting the good code from
improvement is not protection.

The actual rule is narrower. **The agent may not change the things that decide
what it is allowed to do, or that fail in ways review cannot catch.** Everything
else — including the canvas — is fair game, and is governed by whether a human
reading the diff can tell it is right.

## Off limits

| Path | Why |
|---|---|
| `convex/schema.ts` | Schema changes need the optional → backfill → tighten dance and a deliberate prod push. Not an overnight job. |
| `convex/migrations.ts` | Same, one step worse: it writes to every row. |
| `convex/auth.ts` | Four functions are the whole tenancy boundary. A subtle mistake leaks other people's documents, and no reviewer reliably spots that in a diff. |
| `convex/admin.ts` | The agent authenticates through these. It must not be able to widen its own access. |
| `app/lib/ai/apply.ts`, `app/lib/ai/review/**` | The accept/reject pipeline is the user's undo affordance for AI edits. Break it and the damage is to their work, discovered later. |
| `.github/**`, `.claude/**`, `scripts/**`, `docs/agent-allowlist.md`, `docs/triage-rubric.md` | The gate, the prompts, the scripts and this file. Nothing that must pass a check may edit the check. |
| `package.json`, `package-lock.json` | No dependency added, removed or bumped unattended. |
| `instrumentation*.ts`, `proxy.ts` | Boot and edge paths: a mistake takes the app down rather than degrading it. |

## The canvas is allowed — with one invariant

`app/components/editor/canvas/**` is open. It is held to a higher bar than the
rest of the product, which means the *change* must be good, not that it must not
be attempted.

One thing there is load-bearing beyond what review will catch. Per `CLAUDE.md`:

> The canvas HTML round-trip is exact: `serialize(parse(html)) === html`. Keep it
> that way — it is the contract the AI layer edits diagrams through.

Nothing enforces that. So a change touching `scene/serialize.ts`, `scene/parse.ts`
or the shape of `SceneNode` must say in the PR body how the round-trip was
reasoned about — and if it cannot, it should be declined instead.

## Rules that hold everywhere

- One ticket per pull request, titled `NT-{n}_short_slug`.
- No dependency added or upgraded.
- No file deleted.
- If the fix needs a path above, record `declined` with the reasoning and file
  nothing. A refused ticket is a good outcome; a plausible-looking PR against
  `auth.ts` is not.
