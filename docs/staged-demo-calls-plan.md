# Staged demo calls

**Built.** `tsc`, `eslint` and 1411 tests green. Implements the top 15 from `../../demo-staged-calls-engineering-team.md`, plus the two calls
they depend on. **17 staged calls.**

Nothing in the demo depends on an unstaged call: C-09 and C-10 need a diagram on the page, so
**C-07** is staged; C-14 reads a roadmap, so **C-13** is staged. Both were going to be seeded
instead — staging them is better, because the audience sees the canvas build itself *and* the
shape ids C-09/C-10/C-14 read are ones our own canned payload wrote.

## The constraint

> Even if the response is canned, it all stays in context.

That rules out the obvious implementation (intercept in the UI, paint a canned answer) and
decides the whole design:

**Stage the model, not the app. Everything below the model boundary runs for real.**

A staged turn is a turn where `streamText` is handed a scripted `LanguageModelV4` instead of
OpenAI/OpenRouter. Nothing else changes. Which means, for free and with no new code paths:

| Runs for real | Why it matters here |
|---|---|
| The tool loop in `streamText` | Step counting, `stopWhen`, `activeTools`, abort, tool-input validation |
| Client tools (`edit_page`, `read_page`, `create_page`, `album_edit`) | The document **actually changes**, through the same applier a human edit takes |
| `persist()` → `chatMessages` | The staged turn is in the transcript, with its tool calls and results |
| Review / fork / checkpoint / ⌘Z | A staged edit is accepted or rejected like any other |
| `recordAiCall` → `aiCalls` | Ops still sees the turn |

So the next turn — staged **or real** — sends the full history to `/api/chat` and the real model
sees every canned answer, every tool call and every result that came before it. Context is not
something we maintain; it is something we never break.

The corollary is the acceptance test for this whole feature: **at any point in the demo the
presenter can ask something unscripted, and the real model picks up mid-conversation with a
correct picture of the document and the conversation.**

## Seam

`app/lib/ai/chat/provider.ts` already returns a `ModelCall` bundle per request. One branch:

```ts
// app/api/chat/route.ts
const staged = matchStaged({ messages, projectId, pageId });   // null when nothing matches
const { model, providerOptions } = staged ? stagedModel(staged) : chatModel();
```

Everything else in the route is untouched. `matchStaged` returning `null` is the fallthrough,
and it is the only failure mode worth designing for: **when in doubt, the real model runs.**

### Why not a hand-written UI message stream

`createUIMessageStream` + `writer.write(...)` would bypass `streamText`, and with it the step
budget, tool-input validation against the real Zod schemas, the ledger and the approval
machinery. We would be reimplementing the loop in order to lie to it. The mock model lies to
the loop from outside and the loop stays honest.

### The resume problem

A client tool ends the request that carried it; the browser resumes the turn with a new
request, and `streamText` starts counting steps at zero again (already documented at
`route.ts:stepsTaken`). So the staged model cannot use `streamText`'s step counter to find its
place in the script. It uses the same thing the route already uses:

```ts
/** Which step of the script this request is for. */
function cursor(messages: AbMessage[]): number {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return 0;
  return last.parts.filter((p) => p.type === "step-start").length;
}
```

A script is therefore a **list of steps**, each either text, tool calls, or both, and
`stagedModel` emits step `cursor(messages)`. Falling off the end of the list is a `finish`.

## Shape of a script

```ts
export type StagedStep =
  | { say: string; delayMs?: number }
  | { call: StagedCall[]; delayMs?: number }
  | { say: string; call: StagedCall[]; delayMs?: number };

export type StagedCall<N extends ToolName = ToolName> = {
  tool: N;
  /** A literal, or resolved against the live document at request time. */
  input: z.infer<(typeof TOOLS)[N]["inputSchema"]> | ((ctx: StageContext) => ...);
  /** Server tools only: canned output instead of executing. Omit to run for real. */
  output?: unknown;
};

export type StagedCallScript = {
  id: string;                 // "C-16"
  match: RegExp;
  /** Must all hold, or we fall through to the real model. */
  requires?: (ctx: StageContext) => boolean;
  steps: StagedStep[];
};
```

Two details carry most of the value:

**1. `input` is typed by `TOOLS[name].inputSchema`.** A scripted `edit_page` batch is
type-checked at build time against the same schema the runtime validates against, and a
malformed one is a `tsc` failure rather than a dead moment on stage.

**2. `output` is optional, and omitting it is the default.** Server tools run for real unless
we say otherwise. Only the paid, slow or networked ones get canned:

| Canned | Runs for real |
|---|---|
| `search_web`, `find_images`, `find_places`, `find_songs`, `draw` | `list_repo_files`, `search_repo_code`, `read_repo_file`, `list_pages` |

Client tools are never canned — they are the document changing.

This matters most for the flagship. **C-16 is almost entirely real**: `read_page` is a *client*
tool, so it reads the live requirements page off the editor; `search_repo_code` and
`read_repo_file` hit the team's actual GitHub. Only the closing analysis is scripted. The
demo's best moment is a real investigation with a scripted conclusion, which is also the only
honest way to guarantee it.

## Chaining and drift

The scripts that read something a previous script wrote are where a live demo breaks.

**Late binding.** `input` may be a function of the live document rather than a literal. C-09
("add a retry branch") resolves the node ids it edits from the page's real shapes at request
time, so it still lands correctly if the presenter dragged a box first. Literals for the
simple ones, resolvers for the four that chain.

**Preconditions.** `requires` runs before the script is claimed. When the diagram C-09 wants
isn't on the page, we do not emit a broken edit — we fall through to the real model, which
will do something reasonable. No staged call ever produces a tool call against something that
does not exist.

**The three chains, all staged end to end:**

| Chain | Reads what | Ids come from |
|---|---|---|
| C-07 → C-09 → C-10 | The power-path diagram | C-07's canned canvas payload |
| C-13 → C-14 | The roadmap swimlanes | C-13's canned canvas payload |
| C-06 → everything after | The page list | Real `create_page` results |

Because the prerequisite is staged, the ids downstream scripts read are ours and deterministic
— the same guarantee seeding would have given, without giving up the moment.

Belt and braces on top of that, because a presenter will skip a beat:

- **`requires`** — C-09 checks the shapes exist before claiming the message. They don't (C-07
  was skipped), we fall through to the real model rather than emitting a broken edit.
- **Late binding** — C-09's node ids resolve from the live page at request time, not from a
  literal, so the edit still lands if the presenter dragged a box first.
- **C-06 changes the project**, so `list_pages` returns five more pages after it. Run it late,
  or accept that C-05 and C-16 see them.

## The tab lane

Different seam, deliberately. `tourDrive.ts` carries a hard-won comment: the completion lane
was once scripted at the network layer and the pipeline kept withdrawing the suggestion —
superseded, unparsed, ungrounded, nothing left after the block gate. A guide cannot promise
"press Tab" on top of machinery allowed to change its mind. **We do not script `/api/complete`.**

Instead, exactly as `Hints.tsx` already does:

1. A stage director watches the editor, matches the tab regexes against `before.slice(-240)`.
2. `suspendCompletions(true)`, then `reveal()` the canned ghost text through `setGhost` — the
   same plugin the real lane paints through.
3. Tab accepts through the real `acceptSuggestion`, which inserts into the document and calls
   `onAccept`. Neither knows who wrote the suggestion. **The text that lands is real document
   state**, so it is in context for everything after it.

For **T-10** (`<nt-build-diagram>`), accepting runs the real macro expansion, which POSTs to
`/api/diagram`. That one *is* staged at the route — there are no withdrawal gates on diagram
expansion, it is a single request, and staging it there means the canvas lands through the
real `adopt`/`serialize` path into Yjs rather than being painted on top of it.

So: three tab calls, two mechanisms.

- **T-07** (firmware C) and **T-20** (repo citation) — painted ghost text only.
- **T-10** (tab builds a diagram) — painted ghost text **+** staged `/api/diagram` response.

## Gating

Staging must be impossible to reach by accident.

```
STAGED_DEMO=1                      # server, off in production builds
STAGED_DEMO_PROJECTS=<projectId>   # allowlist; matchStaged returns null for any other project
```

`matchStaged` returns `null` unless both hold. No flag, no allowlist, no staging — in a
production build the module's regex table is never consulted.

**Ledger and limits.** Staged turns skip `refuseIfLimited` and `beginChat` (a demo must not
throttle or run out of allowance mid-sentence) but still `recordAiCall` with
`model: "staged/<id>"` and zero cost, so ops sees the turn happened and nobody later mistakes
demo traffic for real spend. Flagging this as a decision — the alternative is keeping
`beginChat` for fidelity and pre-topping-up the demo account.

## Validation

The thing that makes a live demo safe is that its canned payloads cannot be wrong at run time.
One vitest over the script table asserts, for all 15:

- every `input` literal parses under `TOOLS[tool].inputSchema`
- every `edit_page` batch parses under `convex/ai/operations.ts` `parseBatch`
- every canvas HTML payload round-trips through the canvas parser and serializer unchanged
- every `output` on a canned server tool matches that tool's declared result shape
- every regex matches its own documented trigger phrase, and **no regex matches another
  script's trigger phrase** — the match-order conflicts from the demo doc, asserted rather
  than commented
- `requires` is present on every script that references an id it did not create

Plus a rehearsal harness: drive all 15 in order against a seeded project, headless, asserting
the document state after each. That is the run-of-show as a test.

## Phases

**1 · Foundations.** `stagedModel` (a `LanguageModelV4` whose `doStream` replays a script with
`reveal`-style jitter), `matchStaged`, the route branch, the flag and allowlist, the
fallthrough. Prove it on **C-16** with every tool real and only the conclusion scripted. One
call working end to end, with a real question asked after it, settles the whole design.

**2 · Seed the demo project.** Pages, the linked repo, the two PDFs — the standing assets, not
the diagrams, which the staged calls now draw. Extends `app/lib/onboarding/` — same template
shape, a seventh template that never appears in the survey.

**3 · The document calls.** C-05, C-06, C-18, C-21, C-26 — `edit_page` and `create_page`, all
literal inputs, no chaining. The bulk of the 15 and the least risky.

**4 · The canvas calls.** C-07, C-09, C-10, C-11, C-12, C-13, C-14, C-22. Both chains and all
the late-binding resolvers land here — build C-07 and C-13 first, since three calls read what
they draw.

**5 · The tab lane.** The stage director, T-07 and T-20 painted, T-10 with the staged
`/api/diagram`.

**6 · Rehearsal.** The validation test, the headless run-of-show, and a dry run on the real
machine with the real network — including deliberately going off-script to confirm the real
model picks up cleanly.

Phases 1 and 2 are the risk. 3–5 are volume, and parallelisable once the shape is fixed.

## What I'd want decided before phase 1

1. ~~C-14's roadmap~~ — settled: C-07 and C-13 are staged calls in their own right.
2. **Entitlement** — skip `beginChat` for staged turns, or keep it and top up the demo account?
3. **Canned server-tool results become fiction the real model later believes.** For the 15 this
   is only `search_web` (not used) and `find_images` (not used) — so in practice, none. Worth
   keeping it that way: I'd propose a rule that no staged call in this set cans a server tool.


---

# What was built

| File | What it is |
|---|---|
| `app/lib/ai/staged/types.ts` | `StagedScript` / `StagedStep` / `StagedCall`, with `input` typed by `TOOLS[name].inputSchema` |
| `app/lib/ai/staged/model.ts` | The `LanguageModelV4` that replays a script, with `tourDrive`-style jitter |
| `app/lib/ai/staged/stage.ts` | The gate, the matcher, the cursor, the context |
| `app/lib/ai/staged/scripts/*.ts` | Fourteen chat calls, one file each, plus shared resolvers |
| `app/lib/ai/staged/scenes.ts` | The power-path canvas, shared by C-07 and T-10 so they cannot drift |
| `app/lib/ai/staged/tab.ts` | The three Tab scripts |
| `app/lib/ai/staged/diagram.ts` | T-10's `/api/diagram` response, streamed shape by shape |
| `app/components/editor/ai/StageDirector.tsx` | Paints the Tab lane through the real ghost-text plugin |
| `app/lib/ai/staged/*.test.ts` | 40 tests — separation, payloads, degradation, SDK conformance |

Three lines changed outside the module: the branch in `app/api/chat/route.ts`, the
branch in `app/api/diagram/route.ts`, and the mount in `app/components/editor/Editor.tsx`.

## Switching it on

```
STAGED_DEMO=1
STAGED_DEMO_USERS=user_xxx      # Clerk subjects. Empty means NOBODY, never everybody.
NEXT_PUBLIC_STAGED_DEMO=1       # the Tab lane only
```

The allowlist is of **people**, not projects: a project id can be shared, guessed or
inherited, where the Clerk subject is who is actually signed in. `stagingOn` refuses an
anonymous caller, an empty allowlist, and anything that is not an exact match — no
prefixes, no case-folding. With `STAGED_DEMO` unset it returns before `stageTurn` queries
anything and the regex table is never consulted. Staged turns skip `refuseIfLimited` and `beginChat` — a demo must
not throttle or run out of chats mid-sentence — and still write an `aiCalls` row as
`staged/C-16`, so ops can tell demo traffic from unexplained free traffic.

## The regexes

Each script keys on the distinctive **noun** — "power path", "critical path", "FMEA",
"ICD", "wireframe" — because the verb is what a presenter varies and the noun is what they
keep. Fourteen phrasings per script are asserted to route home, and three separate checks
assert none of them reaches anywhere else:

- no phrasing fires two scripts (`matchScript` treats two matches as none, and the test
  makes that branch unreachable)
- no script's regex reaches into another's corpus — 2,548 cross-checks
- 32 ordinary and near-miss phrases fire nothing at all

Four near-misses had to be designed out, and each one is now a test case: *"does the
firmware actually work?"* is not a conformance check, *"can we schedule a meeting"* is the
verb not the noun, *"make the text red"* is not a diagram restyle, and *"colour the
safety-critical path red"* contains the literal substring "critical path", which is why
C-14 carries a `not`.

## What the tests caught

Worth recording, because these are the failures that would have happened live:

- `"It's laid out like this:"` did not match T-10 — the alternation demanded a literal "is".
- `"any requirements we haven't tested"` and `"does the motor make the torque requirement"`
  matched nothing.
- C-06 wrote `Power & Electrical` into a link unescaped.
- The staged model's `finishReason` is a pair, not a string.

## The seed

`app/lib/demo/kestrel.ts` is the KR-1 project — six pages, every number in it load-bearing
somewhere. The 300 ms in REQ-015 is what C-16 checks the firmware against; the 45 °C in the
thermal budget is what T-07's completion picks up; REQ-008, 012, 018 and 020 are the four
C-05 finds uncovered. `buildSeed.test.ts` asserts all of that, so a well-meaning edit to the
seed fails the build rather than making a staged answer untrue.

The five discipline sections live **inside** the brief, because C-06 is what splits them
out. Test & Validation is a page from the start, because C-05 runs at call 8 and C-06 at
call 13 — so C-06 makes four pages and says out loud that it left the fifth alone.

Built headlessly: `seedUpdate` stands up a BlockNote editor with no DOM, which the probe
confirmed, so the Yjs updates can be made in a test and handed to the mutation.

```
SEED_OUT=.ntcheck/kestrel.json SEED_OWNER=user_xxx \
  npx vitest run app/lib/demo/buildSeed.test.ts
npx convex run --prod demoSeed:seedKestrel "$(cat .ntcheck/kestrel.json)"
```

`convex/demoSeed.ts` is an `internalMutation` — unreachable from a browser. It refuses to
run twice for the same owner without `replace: true`, and returns the owner it wrote to
plus how many projects that account already had, so a mistyped subject is visible in the
terminal instead of silent.

## Still to do

1. **The two facts needed for prod** — alihosseini2006's Clerk subject, and prod access.
2. **A headless run-of-show** driving all seventeen in order against the seeded project.
3. **A dry run on the real machine**, including going off-script deliberately to confirm
   the real model picks up cleanly.
