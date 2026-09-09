/**
 * Run the built plugin once, outside Figma.
 *
 * `dist/code.js` executes in a Node `vm` with a stand-in `figma` global whose
 * selection is a frame holding a turned group holding a rectangle — the
 * placement the converter used to get wrong — and the markup and report the
 * UI would have received are printed. Build first: `npm run figma:build`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(resolve(here, "dist/code.js"), "utf8");

const at = (x, y) => [[1, 0, x], [0, 1, y]];
const turned = (deg, x, y) => {
  const r = (deg * Math.PI) / 180;
  return [[Math.cos(r), Math.sin(r), x], [-Math.sin(r), Math.cos(r), y]];
};
const mul = (o, i) => [
  [o[0][0] * i[0][0] + o[0][1] * i[1][0], o[0][0] * i[0][1] + o[0][1] * i[1][1], o[0][0] * i[0][2] + o[0][1] * i[1][2] + o[0][2]],
  [o[1][0] * i[0][0] + o[1][1] * i[1][0], o[1][0] * i[0][1] + o[1][1] * i[1][1], o[1][0] * i[0][2] + o[1][1] * i[1][2] + o[1][2]],
];
const grey = { type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 }, opacity: 1 };

const groupAbs = turned(30, 120, 100);
const rectAbs = mul(groupAbs, at(10, 10));
const selection = [
  {
    id: "1:1", name: "Frame 1", type: "FRAME", x: 100, y: 80, width: 300, height: 200,
    absoluteTransform: at(100, 80), relativeTransform: at(100, 80), fills: [], strokes: [], effects: [],
    children: [
      {
        id: "1:2", name: "Group 1", type: "GROUP", x: 20, y: 20, width: 100, height: 60, rotation: 30,
        absoluteTransform: groupAbs, relativeTransform: turned(30, 20, 20),
        children: [
          {
            id: "1:3", name: "Rectangle 1", type: "RECTANGLE", x: 30, y: 30, width: 40, height: 20,
            absoluteTransform: rectAbs, relativeTransform: mul(at(-100, -80), rectAbs), fills: [grey], strokes: [], effects: [],
          },
        ],
      },
    ],
  },
];

const ready = new Promise((done, fail) => {
  const figma = {
    ui: {
      postMessage(message) {
        if (message.type === "ready") done(message);
        if (message.type === "failed") fail(new Error(message.message));
      },
      onmessage: null,
    },
    showUI() {},
    on() {},
    closePlugin() {},
    currentPage: { selection },
    getImageByHash: () => null,
    base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
  };
  vm.runInNewContext(code, { figma, __html__: "", console });
  figma.ui.onmessage({ type: "copy" });
});

const { html, count, report } = await ready;
console.log(html);
console.log(`\n${count} shapes, ${report.length} report line(s)${report.length ? ":" : ""}`);
for (const line of report) console.log(`  ${line.code} ${line.name} (${line.nodeId}): ${line.message}`);
