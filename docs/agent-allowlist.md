# What the agent may edit

The implement routine opens pull requests unattended, overnight, against a
codebase with **no test suite**. `tsc --noEmit` and ESLint are the entire
automated bar — they prove a change compiles, never that it works.

So the rule is not "avoid obvious danger". It is: the agent may only touch code
where *a human reading the diff over coffee* is a sufficient review. Everywhere
else, it may still triage, score, and comment — it just may not write.

## Off limits

| Path | Why |
|---|---|
| `app/components/editor/canvas/**` | `CLAUDE.md` holds the canvas to a higher bar than anything else in the product. It is the thing being sold. |
| `convex/schema.ts` | Schema changes need the optional → backfill → tighten dance and a deliberate prod push. Not an overnight job. |
| `convex/migrations.ts` | Same reason, one step worse: it writes to every row. |
| `convex/auth.ts` | Four functions are the whole tenancy boundary. A subtle change here leaks other people's documents. |
| `convex/admin.ts` | The agent authenticates through these. It should not be able to widen its own access. |
| `app/lib/ai/apply.ts` | The applier every AI feature routes through, including the agent's own future edits. |
| `app/lib/ai/review/**` | The accept/reject pipeline — the user's undo affordance for AI work. |
| `.github/workflows/**` | The gate. Nothing that must pass a check may edit the check. |
| `instrumentation*.ts`, `proxy.ts` | Boot and edge paths; a mistake takes the app down rather than degrading it. |

## Fair game

Everything else, in practice mostly: `app/components/**` outside the canvas,
`app/lib/onboarding/**`, styling in `app/globals.css`, copy, and self-contained
bug fixes with an obvious blast radius.

## Rules that hold everywhere

- One ticket per pull request, titled `NT-{n}_short_slug`.
- No dependency added or upgraded.
- No file deleted.
- If the fix needs a path above, the agent records `declined` on the ticket with
  its reasoning and files nothing. A refused ticket is a good outcome; a
  plausible-looking PR against `auth.ts` is not.

This list starts deliberately narrow. Widen it when the PRs have earned it —
not before.
