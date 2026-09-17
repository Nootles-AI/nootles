# NML mirror identity lifecycle fix plan

**Status:** implemented and verified locally (2026-09-17)
**Written:** 2026-09-17
**Scope:** prevent authentication/profile hydration from interrupting AI generation or remounting the editor for every user and every document pipeline.
**Separate issue:** canonical duplication from stale queued mirror commands is tracked as [NT-54](https://linear.app/nootles/issue/NT-54/nml-compatibility-mirror-duplicates-queued-edits-compiled-from-a-stale) and is not part of this patch.

## Outcome

Changing the current user's identity metadata must not recreate the NML compatibility mirror, hide the editor, replace `EditorSurface`, reset selection/history, or abort an active completion. The implementation must be account-agnostic: no internal-owner, cohort, dogfood, allowlist, user-ID, or deployment-specific branch may be added.

The fix lives in the shared served-NML lifecycle. Current non-dogfood users do not enable that mirror today, but the corrected behavior must automatically apply to them if their documents are served later. Existing non-served Yjs and legacy paths must be regression-tested to ensure identity hydration remains non-disruptive there too.

## Verified failure

A real Chromium reproduction mounted the production completion hook over a served NML/BlockNote document and returned a deliberately slow `/api/complete` stream.

1. The editor first rendered with `userId = "anonymous"`.
2. Typing triggered an inline completion.
3. The streamed text ` continued` became visible as ghost text.
4. The identity changed to `real-user`, matching Clerk hydration after the page has mounted.
5. `EditorSurface` unmounted and mounted again.
6. The completion request closed and the visible suggestion disappeared.

Observed lifecycle counters:

```text
before identity hydration: mounts=1, unmounts=0, ghost=" continued"
after identity hydration:  mounts=2, unmounts=1, ghost=""
```

This does not require a second collaborator and is not caused by duplicate Yjs awareness rows. It is a local React ownership error: mutable user metadata is currently treated as ownership of the mirror.

## Regression origin

Both the compatibility mirror and the faulty identity dependency were introduced in PR #133:

- feature-branch commit `ec8b3b26b09651750c3ddca74fbde582b3ef1bb2`, **NML Phase 2.5: restore full served-editor parity**;
- squash merge on `main` `6a5a4b8a6ba1ff74d8628f3d43cb8390fd7efb72`, **NML Phase 2.5: full parity for selected dogfood users (#133)**.

For a `main`-branch bisect, `6a5a4b8` is the introducing commit. Before it, served documents used `NmlServedEditor`; the parity change routed them through the complete `YjsEditor`/`EditorSurface` and added `useNmlLegacyMirror`.

## Root cause

The failure spans three otherwise-correct lifecycles.

### 1. Authentication metadata changes after mount

`app/components/editor/Editor.tsx` calls:

```tsx
useNmlLegacyMirror(
  served,
  editor,
  provider,
  user?.id ?? "anonymous",
);
```

Clerk can initially expose no user and later hydrate the signed-in user. The value therefore legitimately changes from `"anonymous"` to the real user ID without the document, editor, provider, or permission boundary changing.

### 2. The mirror treats `userId` as an ownership dependency

`app/lib/nml/useNmlLegacyMirror.ts` includes `userId` in the construction effect:

```tsx
useEffect(() => {
  // ...
  setReady(false);
  const mirror = new NmlLegacyMirror(/* ... userId ... */).start();
  // ...
  return () => mirror.stop();
}, [convex, enabled, editor, provider, userId]);
```

An identity-only change consequently stops the existing mirror, sets `ready` false, creates another mirror over the same editor/Y.Doc, and later sets `ready` true.

### 3. Readiness owns the whole editor surface

`YjsEditor` returns the placeholder while `mirrorReady` is false:

```tsx
if (!editor || !mirrorReady) return placeholder;
```

That unmounts `EditorSurface`, including `useTabCompletion`. The completion cleanup correctly calls `abort?.abort()` because, from its point of view, its editor has genuinely disappeared. The completion hook is not the defect and should continue aborting on real document/editor unmounts.

## Required invariants

The implementation is complete only if all of these remain true:

1. A user-name, image, email, or user-ID hydration does not recreate the BlockNote editor.
2. A user-ID change does not stop or recreate the NML mirror.
3. A user-ID change does not transition `mirrorReady` back to false.
4. New mirror-originated canonical transactions use the latest available user ID.
5. AI-originated legacy transactions remain attributed with `actor.kind = "model"`.
6. Human-originated legacy transactions remain attributed with `actor.kind = "human"`.
7. Initial served-NML mount still waits for canonical projection and storage URL hydration before exposing the editor.
8. A real owner change—different editor, provider/Y.Doc, document, Convex client, or enabled/disabled serving state—still stops the old mirror and initializes the new one.
9. A real editor/document unmount still aborts its completion request.
10. No code path is conditioned on whether the current user is a dogfooder or belongs to an NML cohort.

## Implementation plan

### Step 1: add a failing browser regression before changing production code

Add a focused paired browser fixture, following the repository's `*.browser.tsx` + `*.browser.mjs` convention. A dedicated `tests/nml-mirror-identity.browser.tsx` and `.mjs` is preferable to expanding the already broad served-editor test because this regression needs precise stream and mount lifecycle instrumentation.

The fixture should use:

- the real BlockNote schema and production editor extensions;
- a real `Y.Doc` with both canonical NML and the `prosemirror` compatibility fragment;
- the real `NmlLegacyMirror` hook;
- the real `useTabCompletion` hook;
- an inert local `ConvexReactClient`/WebSocket, as used by the other offline browser fixtures;
- a local `/api/complete` response that writes one visible chunk and intentionally remains open;
- no paid provider and no production or development deployment.

Test sequence:

1. Mount with `userId = "anonymous"` and wait for `.bn-editor`.
2. Put the caret after enough text to pass the completion context gate.
3. Type once and wait for `.nt-ghost` to contain the streamed chunk.
4. Record the editor object, editor DOM node, selection, surface mount count, and request state.
5. update only `userId` to a signed-in ID;
6. wait beyond a React effect turn;
7. assert the editor object and DOM node are identical;
8. assert surface mounts remain `1` and unmounts remain `0`;
9. assert the request is still open and the ghost is still visible;
10. finish the response and assert the completion settles normally.

The test must fail against `6a5a4b8` before the production change is made.

### Step 2: separate mutable attribution from mirror ownership

In `app/lib/nml/useNmlLegacyMirror.ts`:

1. Add a ref that holds the latest `userId`.
2. Update that ref in its own effect whose only dependency is `userId`.
3. Declare the identity-update effect before the mirror-construction effect so initial and subsequent effect ordering is explicit.
4. Make `actorForChange` read `userIdRef.current` at the transaction boundary.
5. Remove `userId` from the mirror-construction effect's dependency array.

The intended shape is:

```tsx
const userIdRef = useRef(userId);
useEffect(() => {
  userIdRef.current = userId;
}, [userId]);

useEffect(() => {
  // Construct/stop the mirror only when its actual owners change.
  const mirror = new NmlLegacyMirror(/* ... */, {
    actor: {
      kind: "human",
      userId: userIdRef.current,
      clientId: String(provider.doc.clientID),
    },
    actorForChange: () => ({
      kind: isApplyingAi() ? "model" : "human",
      userId: userIdRef.current,
      clientId: String(provider.doc.clientID),
    }),
    // ...
  }).start();
  // ...
}, [convex, enabled, editor, provider]);
```

Do not capture `userId` anywhere inside the construction effect after removing it from the dependency array. That would trade the remount bug for permanently stale attribution.

`actorForChange` is already called synchronously when the host transaction is observed, which is the correct moment to capture identity and `isApplyingAi()`. No `NmlLegacyMirror` API change is expected.

### Step 3: retain the existing readiness boundary only for true initialization

Keep `mirrorReady` and the initial placeholder behavior. Canonical NML must still win the first render, and storage-backed media must still resolve before the surface is exposed.

Do not solve the bug by:

- always returning `true` from `useNmlLegacyMirror`;
- removing the initial `setReady(false)`;
- rendering `EditorSurface` before the first mirror settles;
- weakening the completion hook's unmount cleanup;
- suppressing Clerk updates;
- freezing attribution as `anonymous`;
- special-casing current dogfood user IDs.

The required change is narrower: an identity-only update must no longer rerun the construction effect, so it never reaches the readiness transition.

### Step 4: prove attribution advances without a restart

Extend the browser fixture or add a focused hook-level test:

1. Observe/count mirror construction or surface mounts.
2. Mount as `anonymous`.
3. hydrate to `real-user`;
4. perform a human BlockNote edit;
5. inspect the resulting canonical NML transaction origin;
6. assert `actor.kind === "human"` and `actor.userId === "real-user"`;
7. perform an edit inside `duringAiApply`/the normal AI apply boundary;
8. assert `actor.kind === "model"` while `actor.userId` is still current;
9. assert no extra mirror was constructed.

This test prevents a deceptively simple fix that preserves the stream but records every later edit as anonymous.

### Step 5: verify the all-user pipeline matrix

The fix must not be validated only under the current internal-owner cohort.

| Pipeline/user state | Mirror enabled | Completion available | Required result on identity hydration |
| --- | ---: | ---: | --- |
| Served canonical NML, signed-in dogfooder | Yes | Yes | Same editor/mirror; completion continues |
| Served canonical NML, any future signed-in user | Yes | Yes | Same behavior; no account-specific branch |
| Served canonical NML, initially anonymous then signed in | Yes | Yes after authoring access | Identity updates in place; no remount |
| Ordinary Yjs document, non-dogfood user | No | Yes | Existing stable editor remains stable |
| Legacy ProseMirror document | No | Yes | Existing editor/completion lifecycle is unchanged |
| Read-only/share viewer | Possibly, by document authority | No authoring completion | Surface remains mounted; role enforcement unchanged |

At minimum, automate the served-NML regression and one `served = false` control in the focused browser harness. Keep the legacy path covered by its existing editor/browser tests. If the harness can switch all three without importing the full application router, add explicit assertions for all three.

The production implementation must not query cohort membership or internal-owner status. `Editor` already decides whether a document is served; once `useNmlLegacyMirror` is enabled, its lifecycle rules must be identical for every account.

### Step 6: cover valid teardown separately

Add a negative control proving that the fix has not made the mirror immortal:

1. Begin a slow completion.
2. Replace the editor/provider or change to another document.
3. Assert the old surface unmounts exactly once.
4. Assert the old request aborts.
5. Assert the new document gets one fresh mirror and its own ready transition.

This distinguishes mutable user metadata from actual resource ownership.

### Step 7: run the verification gates

Use Node 22, matching the repository's working browser-test environment.

Targeted unit tests:

```bash
/Users/aryansingh/.nvm/versions/node/v22.22.1/bin/node node_modules/vitest/vitest.mjs run \
  app/lib/nml/mirror.test.ts \
  app/lib/nml/mirrorBlockNote.test.ts
```

Offline browser gates:

```bash
/Users/aryansingh/.nvm/versions/node/v22.22.1/bin/node tests/nml-mirror-identity.browser.mjs
/Users/aryansingh/.nvm/versions/node/v22.22.1/bin/node tests/nml-parity-mirror.browser.mjs
/Users/aryansingh/.nvm/versions/node/v22.22.1/bin/node tests/editor-review-undo.browser.mjs
```

Run `tests/nml-served-editor.browser.mjs` when its throwaway local Convex backend is available. It must remain a local/dev test; no production deployment or production data write is required for this fix.

Static gates:

```bash
/Users/aryansingh/.nvm/versions/node/v22.22.1/bin/node node_modules/typescript/bin/tsc --noEmit
npm run lint -- app/lib/nml/useNmlLegacyMirror.ts tests/nml-mirror-identity.browser.tsx
git diff --check
```

If the test filenames differ, substitute the final names without weakening the assertions.

## Expected files

Production change:

- `app/lib/nml/useNmlLegacyMirror.ts`

Regression coverage:

- `tests/nml-mirror-identity.browser.tsx`
- `tests/nml-mirror-identity.browser.mjs`

Files to inspect but not expected to require behavioral changes:

- `app/components/editor/Editor.tsx` — owns the `mirrorReady` gate;
- `app/lib/sync/useYjsEditor.ts` — already updates awareness identity without rebuilding the editor and is the pattern to preserve;
- `app/components/editor/ai/useTabCompletion.ts` — its cleanup is correct for real unmounts;
- `app/lib/nml/mirror.ts` — `actorForChange` already provides the required late-bound attribution seam;
- `tests/nml-served-editor.browser.tsx` and `.mjs` — broad served-route coverage;
- `tests/nml-parity-mirror.browser.tsx` and `.mjs` — mirror/browser parity coverage.

Avoid unrelated changes to Convex schema/functions, NML authority rows, cohort configuration, provider refcounting, awareness sessions, AI endpoints, or completion cancellation semantics.

## Review checklist

- [x] The regression fails before the fix and passes after it.
- [x] There is no dogfood/cohort/user-ID condition in the patch.
- [x] `userId` is absent from the mirror-construction effect dependencies.
- [x] `actorForChange` reads the latest identity rather than a stale closure.
- [x] Identity hydration produces no editor or surface unmount.
- [x] An already-visible completion remains visible and its request remains open.
- [x] The stream can finish after identity hydration.
- [x] A subsequent human edit carries the hydrated user ID.
- [x] A subsequent AI edit remains attributed as model-authored.
- [x] Ordinary non-served Yjs behavior is unchanged.
- [x] Legacy-editor behavior is unchanged.
- [x] Read-only permissions are unchanged.
- [x] A real document/editor change still tears down and aborts old work.
- [x] No paid AI provider or production deployment was needed for verification.
- [x] NT-54 is not accidentally bundled into this lifecycle patch.

Verification used the focused real-Chromium identity fixture, the existing mirror-parity and
editor undo/review browser suites, all 1,481 unit tests, TypeScript and ESLint, and the assembled
served-editor flow against a throwaway local Convex backend. The local flow migrated legacy content,
served canonical NML, and persisted a user-typed edit back to the canonical root with no browser
errors or paid requests.

## Rollout and rollback

This is a client lifecycle correction with no schema, migration, environment-variable, or backend deployment requirement. It should ship through the normal application release and immediately protect every currently served NML document. Because the code contains no cohort condition, the same protection applies automatically as NML serving expands to non-dogfood accounts.

The safest rollback is reverting only the `useNmlLegacyMirror` identity-lifetime change and its tests. Do not roll back NML parity, disable AI, or mutate serve/cohort data to manage this bug. If an unexpected attribution regression appears, pause expansion of NML serving while retaining the failing test and diagnose the late-bound actor value; do not restore identity-triggered editor remounts as a workaround.

## Definition of done

The issue is fixed when a completion can begin before identity hydration and finish after it without an editor remount, the next canonical transaction records the hydrated user correctly, valid document changes still tear down safely, and the pipeline matrix demonstrates that the change is universal rather than dogfood-specific.
