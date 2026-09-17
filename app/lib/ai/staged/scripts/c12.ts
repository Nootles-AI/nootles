import type { StagedScript } from "../types";
import { openPage } from "./resolve";

/**
 * C-12 — wireframe the teleop screen.
 *
 * Real draggable shapes, and the E-STOP is 44 px because the safety policy in
 * the project says so — a design grounded in a document, with the clause cited
 * under the frame.
 */
export const C12: StagedScript = {
  id: "C-12",
  title: "Wireframe the teleop screen",
  match:
    /\b(wireframe|wire frame|wireframes)\b|\bmock ?ups?\b|\b(design|sketch|lay ?out|draw)\b[^.?]{0,60}\b(teleop|operator|driver)\b[^.?]{0,40}\b(screen|ui|console|panel|interface|dashboard|hmi)\b/i,
  says: [
    "wireframe the teleop operator screen",
    "wireframe the operator screen",
    "can you mock up the teleop screen",
    "mockup the operator console",
    "design the teleop operator interface",
    "sketch the operator screen",
    "give me a wireframe of the console",
    "wireframe the driver ui",
    "Wireframe the teleop operator screen",
    "can you wireframe the operator screen",
    "let's mock up the teleop console",
    "I'd like a wireframe of the operator ui",
    "mock up the driver screen",
    "wireframe it",
  ],
  steps: [
    {
      say: "Laying it out at 1280×800. The E-stop is sized from the safety policy, not from taste.",
      delayMs: 900,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = openPage(ctx);
            if (!pageId) return null;
            return {
              pageId,
              html: `<h2>Teleop operator screen</h2>
<nt-diagram w="1340" h="880">
  <nt-rect id="tw-frame" x="30" y="30" w="1280" h="800" style="background:#fbfbfd;border:2px solid #c3c9d4;border-radius:10px"></nt-rect>
  <nt-rect id="tw-status" x="30" y="30" w="1280" h="56" style="background:#2b3446;border:1px solid #2b3446;border-radius:10px 10px 0 0;display:flex;align-items:center;justify-content:center;color:#eef2f8;font-size:13px">KR-1-03 · link 42 ms · pack 71% · AUTONOMOUS</nt-rect>
  <nt-rect id="tw-video" x="56" y="112" w="760" h="470" style="background:#e7eaf0;border:1px solid #9aa5b8;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#6b7689;font-size:14px">Forward camera · 1080p · 42 ms</nt-rect>
  <nt-rect id="tw-map" x="844" y="112" w="440" h="300" style="background:#e7eaf0;border:1px solid #9aa5b8;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#6b7689;font-size:14px">Route map</nt-rect>
  <nt-rect id="tw-log" x="844" y="440" w="440" h="142" style="background:#f2f4f8;border:1px solid #9aa5b8;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#6b7689;font-size:13px">Event log</nt-rect>
  <nt-rect id="tw-estop" x="56" y="616" w="240" h="176" style="background:#c0392b;border:3px solid #8e2a20;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:26px;font-weight:700">E-STOP</nt-rect>
  <nt-rect id="tw-take" x="324" y="616" w="240" h="176" style="background:#f6e9d8;border:2px solid #a8702a;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600">TAKE CONTROL</nt-rect>
  <nt-rect id="tw-speed" x="592" y="616" w="224" h="176" style="background:#eef2f8;border:1px solid #3f5d84;border-radius:8px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:14px">Speed limit<br/>1.5 m/s</nt-rect>
  <nt-rect id="tw-queue" x="844" y="616" w="440" h="176" style="background:#f2f4f8;border:1px solid #9aa5b8;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#6b7689;font-size:13px">Delivery queue · 3 pending</nt-rect>
</nt-diagram>
<blockquote><p>The E-stop is 240×176 px and sits in the bottom-left corner, hard against the frame. <em>Campus Safety Ops Policy §4.2: an emergency stop control shall be no smaller than 44 px on its shortest edge and shall not be adjacent to any control that changes vehicle mode.</em> That is why TAKE CONTROL is a full 84 px away rather than beside it.</p></blockquote>`,
            };
          },
        },
      ],
    },
  ],
};
