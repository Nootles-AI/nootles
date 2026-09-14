/**
 * The NML inputs `toHtml.test.ts`'s vitest goldens and `tests/canvas-compile
 * .browser.tsx`'s fixture page both compile — one source, so the two cannot
 * silently test different pictures (COMPILE, build-plan §1, §5).
 *
 * Every entry is canonical canvas HTML, exactly as a `<nt-diagram>` block
 * stores it. Keys match the case names in `toHtml.ts`'s own spec (§4.4).
 */
export const COMPILE_FIXTURES: Record<string, string> = {
  "rect-var": `<nt-diagram id="c1" w="320" h="200" style="background: #fff; --brand: #6366f1">
  <nt-rect id="s1" x="40" y="24" w="160" h="72" rot="15" style="background: var(--brand); border-radius: 12px; color: #fff; display: flex; align-items: center; justify-content: center">Ingest</nt-rect>
</nt-diagram>`,

  "ellipse-border": `<nt-diagram w="120" h="80">
  <nt-ellipse id="e1" x="10" y="10" w="100" h="60" style="background: #eee; border: 2px solid #333"></nt-ellipse>
</nt-diagram>`,

  "arc-ring": `<nt-diagram w="100" h="100">
  <nt-ellipse id="r1" x="0" y="0" w="100" h="100" start="0" sweep="270" inner="0.5" style="background: #f59e0b"></nt-ellipse>
</nt-diagram>`,

  "diamond-gradient": `<nt-diagram w="200" h="140">
  <nt-polygon id="d1" x="20" y="20" w="140" h="96" sides="4" style="background: linear-gradient(90deg, #000, #fff); border: 2px solid #111; display: flex; align-items: center; justify-content: center">Yes?</nt-polygon>
</nt-diagram>`,

  "path-bare": `<nt-diagram w="100" h="60">
  <nt-path id="p1" x="10" y="10" w="80" h="40" d="M 0 0 C 20 40 60 40 80 0"></nt-path>
</nt-diagram>`,

  "path-shadow": `<nt-diagram w="100" h="60">
  <nt-path id="p2" x="10" y="10" w="80" h="40" d="M 0 0 C 20 40 60 40 80 0" style="box-shadow: 0 2px 4px rgba(0,0,0,0.3)"></nt-path>
</nt-diagram>`,

  "group-flex-hug": `<nt-diagram w="300" h="200">
  <nt-group id="g1" x="0" y="0" w="192" h="104" style="display: flex; gap: 8px; padding: 12px; width: fit-content; height: fit-content; background: #f4f4f5">
    <nt-rect id="a" w="100" h="50" style="background: #ddd">A</nt-rect>
    <nt-rect id="b" w="60" h="80" hidden="true" style="background: #ccc">B</nt-rect>
  </nt-group>
</nt-diagram>`,

  "edge-two-rects": `<nt-diagram id="c2" w="400" h="200">
  <nt-rect id="a" x="20" y="60" w="100" h="60" style="background: #eee">A</nt-rect>
  <nt-rect id="b" x="280" y="60" w="100" h="60" style="background: #eee">B</nt-rect>
  <nt-edge id="e1" from="a" to="b" style="stroke: #111">deploys</nt-edge>
</nt-diagram>`,

  "text-rich-clamp": `<nt-diagram w="240" h="120">
  <nt-rect id="t1" x="0" y="0" w="240" h="120" style="background: #fff; -webkit-line-clamp: 2"><p style="margin-bottom: 8px"><b>Plan</b> <a href="https://x.test">go</a></p><ul><li>one</li><li>two</li></ul></nt-rect>
</nt-diagram>`,

  // -- Further fixtures (§4.4's "derive and pin" list) ----------------------

  "polygon-rounded-solid": `<nt-diagram w="160" h="160">
  <nt-polygon id="p1" x="10" y="10" w="140" h="140" sides="6" style="background: #22c55e; border-radius: 12px"></nt-polygon>
</nt-diagram>`,

  "path-gradient": `<nt-diagram w="120" h="60">
  <nt-path id="p1" x="0" y="0" w="120" h="60" d="M 0 30 L 120 30" style="background: linear-gradient(90deg, red, blue); border: 3px solid #000"></nt-path>
</nt-diagram>`,

  // A real (if tiny) data URI, never a network URL — a browser test must
  // spend nothing and reach nothing outside the fixture.
  "image-cover": `<nt-diagram w="200" h="120">
  <nt-image id="i1" x="0" y="0" w="200" h="120" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7" style="object-fit: cover; border-radius: 8px"></nt-image>
</nt-diagram>`,

  "group-plain-nested": `<nt-diagram w="300" h="200">
  <nt-group id="g1" x="10" y="10" w="200" h="150">
    <nt-rect id="a" x="0" y="0" w="80" h="40" style="background: #eee">A</nt-rect>
    <nt-group id="g2" x="20" y="60" w="120" h="80">
      <nt-rect id="b" x="0" y="0" w="60" h="30" style="background: #ddd">B</nt-rect>
    </nt-group>
  </nt-group>
</nt-diagram>`,

  "flex-column-stretch": `<nt-diagram w="240" h="200">
  <nt-group id="g1" x="10" y="10" w="200" h="160" style="display: flex; flex-direction: column; align-items: stretch; gap: 8px">
    <nt-rect id="a" w="100" h="40" style="background: #eee">A</nt-rect>
    <nt-rect id="b" w="80" h="40" style="background: #ddd">B</nt-rect>
  </nt-group>
</nt-diagram>`,

  "grid-3": `<nt-diagram w="320" h="140">
  <nt-group id="g1" x="10" y="10" w="300" h="100" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px">
    <nt-rect id="a" w="80" h="40" style="background: #eee">A</nt-rect>
    <nt-rect id="b" w="80" h="40" style="background: #ddd">B</nt-rect>
    <nt-rect id="c" w="80" h="40" style="background: #ccc">C</nt-rect>
  </nt-group>
</nt-diagram>`,

  "flex-pinned-child": `<nt-diagram w="260" h="160">
  <nt-group id="g1" x="10" y="10" w="220" h="120" style="display: flex; gap: 8px">
    <nt-rect id="a" w="80" h="40" style="background: #eee">A</nt-rect>
    <nt-rect id="b" x="150" y="60" w="40" h="40" style="background: #ddd; position: absolute">B</nt-rect>
  </nt-group>
</nt-diagram>`,

  "boolean-subtract": `<nt-diagram w="160" h="160">
  <nt-group id="bg" x="10" y="10" w="140" h="140" op="subtract" style="background: #6366f1">
    <nt-rect id="a" x="0" y="0" w="140" h="140" style="background: #000"></nt-rect>
    <nt-ellipse id="b" x="30" y="30" w="80" h="80" style="background: #000"></nt-ellipse>
  </nt-group>
</nt-diagram>`,

  "edges-shared-marker": `<nt-diagram w="400" h="240">
  <nt-rect id="a" x="20" y="20" w="100" h="60" style="background: #eee">A</nt-rect>
  <nt-rect id="b" x="280" y="20" w="100" h="60" style="background: #eee">B</nt-rect>
  <nt-rect id="c" x="150" y="160" w="100" h="60" style="background: #eee">C</nt-rect>
  <nt-edge id="e1" from="a" to="c" style="stroke: #111"></nt-edge>
  <nt-edge id="e2" from="b" to="c" style="stroke: #111"></nt-edge>
</nt-diagram>`,

  "edge-dangling": `<nt-diagram w="200" h="120">
  <nt-rect id="a" x="20" y="20" w="80" h="40" style="background: #eee">A</nt-rect>
  <nt-edge id="e1" from="a" to="ghost" style="stroke: #111"></nt-edge>
</nt-diagram>`,

  "label-ref": `<nt-diagram w="240" h="100">
  <nt-rect id="t1" x="0" y="0" w="240" h="100" style="background: #fff"><nt-ref page="p1">Roadmap</nt-ref></nt-rect>
</nt-diagram>`,

  "text-auto": `<nt-diagram w="300" h="120">
  <nt-text id="t1" x="10" y="10" w="0" h="0" style="width: max-content; height: auto">Hello</nt-text>
</nt-diagram>`,

  "selection-rotated-group": `<nt-diagram id="c3" w="300" h="300">
  <nt-group id="g1" x="40" y="40" w="160" h="100" rot="30">
    <nt-rect id="a" x="10" y="10" w="80" h="40" style="background: #eee">A</nt-rect>
    <nt-rect id="b" x="10" y="60" w="80" h="30" style="background: #ddd">B</nt-rect>
  </nt-group>
</nt-diagram>`,

  "scene-w0": `<nt-diagram w="0" h="0">
  <nt-rect id="a" x="10" y="10" w="80" h="40" style="background: #eee">A</nt-rect>
  <nt-rect id="b" x="120" y="60" w="60" h="30" style="background: #ddd">B</nt-rect>
</nt-diagram>`,
};

export type CompileFixtureName = keyof typeof COMPILE_FIXTURES;
