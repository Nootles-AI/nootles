---
name: ticket
description: Fix one Nootles ticket end to end with the operator present — read NT-{n} and its evidence, ask the questions the nightly routine has to decline over, build the fix, verify it in Chrome, and open the pull request. Use when handed a ticket number like NT-42 or "42".
---

# Fix a ticket, with someone in the room

`/ticket NT-42` — one ticket, named by a person rather than handed out by a queue.

This and the nightly `/implement` routine do the same job under opposite rules.
That one runs unattended against a repository with **no test suite**, so its
standing instruction is *when in doubt, decline*: it may not decide what the
product should do, and it cannot see its own change in a browser. You can do
both — there is someone here to answer, and a Chrome you can drive. So your rule
is **when in doubt, ask**, and your bar is **you watched it work**.

Which is also why you may take tickets the queue would never offer: under the
score threshold, marked `agentSkip`, already attempted, or a wish that has to be
decided before it can be built. The operator naming the ticket is the judgement
those gates stand in for.

## 1. Read the ticket

```
node scripts/implement.mjs show 42
```

Read-only: it opens no run and records no attempt, because this is not the
machine's night work and the Agent page should not say it was.

Stop and check with the operator, before any work, if it comes back with:

- **`prs` non-empty** — something is already filed against this ticket. Say what,
  and what state it is in.
- **`duplicateOf` set** — the fix belongs to the ticket it repeats.
- **`status` of `done` or `declined`** — someone settled this already.
- **`agentSkip` true** — it was deliberately kept away from the agent. Worth
  knowing why before you become the exception.

Then read the evidence for what each part of it is actually worth:

- **`text`** — the report. Test users write these; quality varies enormously.
- **`screenshot`** — a local path when one exists. Read it, and treat it with
  suspicion: it is a raster of a *reconstructed* DOM, so canvas content and some
  computed styles may differ from what the reporter saw. It corroborates; it
  never carries a conclusion alone.
- **`consoleLog`** — the tail of what the tab logged. An error here matching the
  description is the strongest evidence a ticket can carry.
- **`recentOps`** — what was done just before filing, tagged `human` or `ai`.
  Older reports carry only the AI's edits, or nothing: **absence is not
  evidence**.
- **`env.viewport` / `ua` / `sha`** — the conditions to reproduce at.
- **`triageScore` / `triageNotes`** — another agent's reading, from before anyone
  looked at the code. Useful, not binding.

## 2. Find the cause before you ask anything

A question you could have answered by reading the code is a question that makes
the operator do your work. So search for the surface the report names, read the
file and its neighbours, and arrive at a specific hypothesis — "the drag handler
recomputes the origin on every pointermove, so the shape jumps when the pointer
leaves the node" — not a topic.

Reproducing it in Chrome (step 5's tooling, used early) is usually the fastest
way there. A report you can trigger yourself needs far fewer questions than one
you are reasoning about from a distance.

Come out of this step with a cause you believe, the change you would make, and a
short list of what you genuinely cannot settle alone.

## 3. Ask — once, and only what changes the diff

Put your reading in front of the operator first: a short paragraph on what you
take the report to mean, what you found, and what you would do about it. An
answer to a question they had to reconstruct the context for is a worse answer.

Then ask everything at once. A session that asks, works, asks again spends the
one thing this lane has that the nightly one doesn't.

Worth asking — these are precisely the nightly routine's decline conditions:

- **What the correct behaviour is.** Two defensible fixes exist and choosing
  between them is a product decision. Give the options and what each implies.
- **Which reading is right**, where the text supports more than one and the
  evidence does not settle it.
- **How wide to go** — the reported symptom, the cause under it, or the same
  cause everywhere else it appears.
- **Whether to build it at all**, for a wish. "Not now" is a real option, and
  cheaper here than after the diff exists.

Not worth asking: anything the code answers, permission to start, what to name
things, whether to run the checks.

Two or three concrete questions, each with options and consequences. And if the
report, the code and the evidence all agree on one reading — don't ask. State the
assumption you are making and build.

## 4. Build it

Branch with the name the script computes; never invent one. The slug is three or
four words describing the fix, not the ticket:

```
node scripts/implement.mjs name 42 origin_recomputed_on_drag   # → NT-42_origin_recomputed_on_drag
git checkout -b NT-42_origin_recomputed_on_drag
```

That title is how `convex/prs.ts` finds the ticket again. A title assembled by
hand is a link silently not made.

Then the house rules — `CLAUDE.md` is the long form:

- The smallest change that fixes the reported thing. Fix the cause, not the
  symptom.
- **Match the surrounding code**: its comment density, naming, idiom. This
  codebase has a strong voice and a diff that ignores it gets rejected on sight.
- No refactors, no new dependencies, no deleted files, no reformatted lines you
  did not otherwise have to touch.
- Comments explain non-obvious *why*, never *what*.

`docs/agent-allowlist.md` does not bind you — that list stands in for a reviewer
who isn't there at 3am, and tonight one is. The reasons behind it still hold:
`convex/schema.ts` still wants the optional → backfill → tighten dance,
`convex/auth.ts` is still the entire tenancy boundary. If the fix truly lives in
one of those, say so before you go there, keep it surgical, and argue it in the
pull request body.

## 5. Verify it in Chrome

This is what the attended lane is *for*. Don't skip it because the change looks
obvious — "it compiles" is the nightly bar only because it is the only bar
available unattended.

You are driving the operator's own Chrome through Claude in Chrome: their real
browser, already signed in, no fixture and no test profile. So **work in a local
tab and never against production** — the prod app and the ops dashboard hold real
users' documents, and a verification click in the wrong tab is an edit to
someone's work.

- Make sure the dev server is up (`npm run dev`, http://localhost:3000). If the
  port is already taken, ask before starting a second one.
- **Reproduce the bug first, before your fix is in play** — stash it, or start
  here from `main`. A bug you cannot reproduce is a bug you have not understood,
  and the fix that follows is a guess. If it will not reproduce, go back to step
  2 or ask. Do not file.
- Match the conditions that matter: the reporter's `env.viewport`, the surface
  they named, the sequence in `recentOps`.
- Then, with the fix in: repeat that exact sequence, confirm what changed, and
  look at what should *not* have — the neighbouring interaction, and the console.
- Keep what you saw. The before/after and the console are what the body's
  verification line is made of.

Never write that you verified something you inferred.

## 6. File it

Commit first — the check and the pull request both read committed history, so
uncommitted work reads as no work at all.

```
node scripts/implement.mjs check 42 body.md
```

It prints `blocking` and `advisory`. **Blocking** — `tsc`, `eslint`, an empty
diff — is not negotiable: fix it or don't file. **Advisory** — a denied path, a
diff wider than one ticket, an unargued canvas round-trip — is the operator's to
wave through knowingly. Raise it; never route around it.

Write the body to a file first, then:

```
gh pr create --title "$(node scripts/implement.mjs name 42 origin_recomputed_on_drag)" --body-file body.md
```

The body says, briefly: what the ticket reported, what was actually wrong, what
you changed, **what you did in the browser and what you saw**, and how the
reviewer can check it themselves. End with `Fixes NT-42`. If you touched
`scene/serialize.ts`, `scene/parse.ts` or the shape of `SceneNode`, add a
paragraph on how `serialize(parse(html)) === html` still holds — nothing tests
it.

Nothing to write back afterwards: the poller links the pull request to its ticket
on its next pass, moves the ticket to `pr_filed`, and to `done` when it merges.
Do **not** file through `implement.mjs file`, and do not record an agent attempt
— that ledger belongs to the nightly routine, and attended work inside it makes
the Agent page lie about what the machine did.

## 7. Report

- What you asked, and what the answers changed. If an answer changed nothing,
  that was a question not worth asking; ask fewer next time.
- What you verified, under what conditions — and anything you could not.
- What you deliberately left alone.

## Rules

- **One ticket, one branch, one pull request.** Never combine tickets.
- **Never push to `main`**, never merge, never touch another pull request.
- **Never edit the nightly routine's leash** — `.claude/commands/`,
  `docs/agent-allowlist.md`, `docs/triage-rubric.md`, `scripts/` — as a side
  effect of a ticket. Changing those is its own conversation.
- **Never enable the agent or move a threshold** to get a ticket through. You
  don't need to; this lane never reads them.
- **If verification fails, don't file.** That is the trade for being allowed to
  take work the nightly routine cannot.
- **Report honestly.** "Verified in Chrome: …" and "compiles and lints; not run"
  are different sentences, and only one of them may describe a change you did not
  watch work.
