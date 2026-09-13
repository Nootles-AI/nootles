# Canvas design workbench — delivery and acceptance

This PR implements a substantial first slice of [the parity roadmap](canvas-parity-roadmap.md), not the entire roadmap or a claim of complete Figma/enterprise parity. No renderer replacement, NML schema migration, backend deployment, or production AI run is included.

## Delivered

| Workflow | Implementation and acceptance |
|---|---|
| Click visible lower layers | Transparent/hollow interiors fall through; CSS paint mapping, adaptive cached curve contours, SVG fill rules, ellipse arcs/rings, rounded outlines, boolean result geometry, numeric stacking order, hidden/locked filtering, rectangular overflow clipping. Text/images deliberately retain object-box selection. |
| Overlapping/deep selection | Cmd/Ctrl-click reaches nested layers; existing Alt behavior remains. Context menu lists the selectable layers under the pointer, front to back, with stable IDs for ambiguous names. Menu is scrollable and viewport-bounded. |
| Screen color sampling | Reusable native EyeDropper in the existing color field: fills, strokes, text-color destinations, and bound variables keep their existing operation path. Explicit browser-unavailable state, cancellation, unmount abort, error feedback, and duplicate-request protection. Actual sRGB pixels, not an authored-fill approximation. |
| Expanded canvas | Expands the existing canvas DOM within the workspace column; keeps the same camera, scene store, and selection. Return button and unconsumed Escape leave it. Only one canvas can be expanded. No durable document changes. |
| Browser fullscreen | Fullscreens the document shell so inspectors and menus remain present. Browser availability/error handling and fullscreenchange tracking. |
| Flex layout | Wrap/wrap-reverse control; correct reverse-direction origin; independent row/column gaps and longhands; line alignment; per-item positional alignment; display:none exclusion; pinned children stay out of flow. Existing native CSS rendering remains the renderer. |
| Clipboard | Both HTML and plain-text NML payloads; inherited tokens/typography transferred locally instead of overwriting destination board variables; simple aliases resolved in their declaration scope; ordinary external text cannot accidentally paste a stale internal shape copy. |
| Export | Editable NML source; on-demand PNG at 1×/2×/3× using the existing lazy-loaded html-to-image dependency. Removes editor overlays from a separate DOM clone, ignores camera transform, bounds raster allocation to 16 MP, prevents duplicate exports, and reports failures. |
| Verification | Unit regressions, an isolated real-Chromium workflow, exact PNG pixel assertion, unchanged-scene/shape-DOM camera assertions, baseline source comparison, and CI execution. |

All document edits still use the existing semantic operations/store. Presentation, fullscreen, selection, and export are view/read operations. The camera implementation itself is unchanged. New caches are weakly keyed by immutable nodes or sibling arrays; camera movement does not invalidate them.

## Run the gates

```sh
npm ci
npx tsc --noEmit
npm run lint
npm test
npx playwright install chromium
CANVAS_BROWSER_CHANNEL=chromium npm run test:canvas:browser
```

The browser harness defaults to an installed Chrome. `CANVAS_CHROME_PATH` can select an executable, and `CANVAS_PLAYWRIGHT_MODULE` can select an operator-provided Playwright module. It prints its temporary artifact directory containing screenshots, source/PNG exports, and `results.json`.

The harness builds a production-mode fixture with the actual canvas components. It does not start Next, sign into an account, load application secrets, connect to Convex, or call AI. Every non-local HTTP request is blocked, and unexpected external requests fail the test. The screen sampler's operating-system permission UI is mocked; the actual React control and its success/cancel behavior are exercised.

For a comparable baseline, source the application modules from a pinned Git revision while keeping the exact same fixture, dependencies, engine, and synthetic workload:

```sh
CANVAS_BASELINE_REF=a1ea966bc96d80dc5f026377f933b3ef16f31a63 npm run test:canvas:browser
```

This reads Git objects without switching branches or changing working files. Baseline mode runs the camera workload only, since the old revision lacks the new controls.

## Observed acceptance — 2026-09-13

- Full suite: 642 passed, one existing skipped test. Typecheck passes. ESLint: zero errors; six existing warnings in `app/api/diagram/route.test.ts` and generated `figma-plugin/dist/code.js`.
- Chromium 152.0.7977.83, headless macOS, synthetic mouse input and camera commands. Real DOM/SVG/CSS canvas, 1,000 shapes, 120 animation frames.
- Baseline: frame interval p50 16.7 ms, p95 17.1 ms, p99 17.7 ms; camera call p95 approximately 0.1 ms.
- Branch confirmation: p50 16.6 ms, p95 17.3 ms, p99 17.7 ms; camera call p95 approximately 0.1 ms. The p95 difference is about 1.2%, within the proposed 5% paired envelope for this run. Timer quantization and machine load make sub-millisecond comparisons noisy.
- Both runs: zero scene notifications, identical scene object, identical shape DOM throughout camera movement. Overlay counter-scaling may change its own markup.
- Browser workflow: lower-layer picking, border picking, Cmd deep selection, context-menu targeting, drag/undo, expansion/return, flex geometry within 0.5 CSS px of browser layout, source download, PNG download and exact pixel, sampler success/cancel, fullscreen enter/exit. Desktop and 700px compact captures visually inspected.
- PNG inspection caught and fixed a computed logical-inset bug that produced a blank image; the exact-color regression now prevents it.

These are synthetic observations, not physical-trackpad, 120 Hz, Safari/Firefox, mobile-touch, or large-enterprise-file certification. A named timing budget is not a universal performance guarantee.

## Explicit remaining scope and limits

The roadmap remains necessary. Components/instances/variants, typed token modes/libraries, full typography/IME qualification, responsive constraints, rich grid placement, grow/shrink/min-max layout, vector networks, comprehensive masks, on-canvas gradient editing, prototype runtime, full `.fig` interchange, PDF/vector export, collaborative-history migration, and scale qualification are not implemented here.

Selection uses geometric paint approximations, not arbitrary browser compositing. Per-corner CSS radius lists, stroke dash gaps/caps, CSS mask/clip-path intricacies, transparency hidden behind variable expressions or complex gradient stacks, blend effects, and arbitrary CSS transforms need further fidelity work. Curve flattening is adaptive to 0.05 scene px, bounded to 12 subdivisions per segment. This is not an unlimited SVG geometry engine or a spatial-index implementation.

Flex remains a deliberate pixel-sized subset. Baseline alignment requires font metrics; CSS Grid and other unsupported layout expressions retain their prior limitations. Imported unsupported declarations remain data, not a promise of editor geometry agreement. The wrapping work does not complete the roadmap's unified browser-measured geometry service.

Clipboard carries root-level design dependencies. Ancestor-scoped values for a copied nested subtree and complex custom-property fallback expressions still need a complete dependency resolver. A transferred token is localized to avoid a destination-name collision; it is not converted into a shared-library reference.

PNG is a browser raster snapshot, not a vector interchange format. It crops to top-level geometric bounds plus 32px padding; unusually large effects, overflow descendants, and routed edges outside those bounds may need a larger explicit export region. Cross-origin images/fonts and complex CSS effects require additional fidelity qualification; source export is the lossless editable fallback. Multi-frame/selection export and asset packaging are not included. Do not market PNG as universally pixel-identical to Figma.

The existing renderer, snapshot history, per-shape Yjs binding, and canonical NML migration boundary are preserved. Their broader collaboration/concurrency acceptance remains a separate roadmap gate. No production deployment, package audit remediation, or unrelated Figma-plugin changes were made.
