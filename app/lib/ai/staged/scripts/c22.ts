import type { StagedScript } from "../types";
import { openPage } from "./resolve";

/** C-22 — the ICD: the table and the picture of the table, from one ask. */
export const C22: StagedScript = {
  id: "C-22",
  title: "ICD for compute ↔ motor controller",
  match:
    /\b(icd|interface control|interface spec)\b|\bcan[\s-](bus|matrix|table|dbc|message|frame|id)\b|\bmessage (map|matrix|table)\b|\bprotocol table\b/i,
  says: [
    "write the ICD for compute to motor controller",
    "give me the ICD",
    "write the interface control document",
    "can you do the CAN matrix",
    "show me the CAN bus topology",
    "build the CAN message table",
    "I need a message map for the bus",
    "write the interface spec between compute and the MCUs",
    "Write the ICD for compute to motor controller",
    "let's write the ICD",
    "can you draft the interface control document",
    "give me the CAN message table",
    "I need the CAN matrix",
    "write the interface spec",
  ],
  steps: [
    {
      say: "Six messages, and the topology drawn underneath so the two can't drift apart.",
      delayMs: 900,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = openPage(ctx);
            if (!pageId) return null;
            return {
              pageId,
              html: `<h2>ICD — Compute ↔ Motor controller</h2>
<p>CAN 2.0B at 500 kbit/s. Every cyclic message has a deadline and a defined action when it is missed; a message with no timeout action is a message that fails silently.</p>
<table>
<tr><th>ID</th><th>Name</th><th>DLC</th><th>Rate</th><th>Layout</th><th>From → to</th><th>On timeout</th></tr>
<tr><td>0x201</td><td>MotorCmd</td><td>8</td><td>100 Hz</td><td><code>[iq_mA:i16][mode:u8][seq:u8][crc:u16][rsvd:u16]</code></td><td>Compute → 4× MCU</td><td>Coast after 15 ms</td></tr>
<tr><td>0x202</td><td>MotorState</td><td>8</td><td>100 Hz</td><td><code>[rpm:i16][iq_mA:i16][temp_c:i8][flags:u8][crc:u16]</code></td><td>MCU → Compute</td><td>Fault after 30 ms</td></tr>
<tr><td>0x203</td><td>Heartbeat</td><td>2</td><td>20 Hz</td><td><code>[seq:u8][health:u8]</code></td><td>Compute → all</td><td><strong>Safe stop after 300 ms</strong></td></tr>
<tr><td>0x204</td><td>PackState</td><td>8</td><td>10 Hz</td><td><code>[v_mV:u16][i_mA:i16][soc:u8][temp_c:i8][flags:u16]</code></td><td>BMS → Compute</td><td>Derate to 50% after 500 ms</td></tr>
<tr><td>0x205</td><td>Limits</td><td>6</td><td>on change</td><td><code>[i_max_mA:u16][v_min_mV:u16][temp_max_c:i8][rsvd:u8]</code></td><td>BMS → MCU</td><td>Hold last, alarm</td></tr>
<tr><td>0x7FF</td><td>Fault</td><td>4</td><td>on event</td><td><code>[node:u8][code:u8][ctx:u16]</code></td><td>any → all</td><td>—</td></tr>
</table>
<p>Bus topology, with both terminations:</p>
<nt-diagram w="1100" h="320">
  <nt-rect id="icd-bus" x="120" y="150" w="860" h="10" style="background:#33415c;border:1px solid #33415c"></nt-rect>
  <nt-rect id="icd-t1" x="60" y="128" w="60" h="54" style="background:#f2f4f8;border:1px solid #9aa5b8;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">120 Ω</nt-rect>
  <nt-rect id="icd-t2" x="980" y="128" w="60" h="54" style="background:#f2f4f8;border:1px solid #9aa5b8;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:12px">120 Ω</nt-rect>
  <nt-rect id="icd-compute" x="180" y="30" w="180" h="70" style="background:#e8eef7;border:2px solid #3f5d84;border-radius:6px;display:flex;align-items:center;justify-content:center">Compute</nt-rect>
  <nt-rect id="icd-bms" x="700" y="30" w="180" h="70" style="background:#e8eef7;border:2px solid #3f5d84;border-radius:6px;display:flex;align-items:center;justify-content:center">BMS</nt-rect>
  <nt-rect id="icd-m1" x="160" y="220" w="140" h="66" style="background:#f6e9d8;border:1px solid #a8702a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px">MCU FL</nt-rect>
  <nt-rect id="icd-m2" x="340" y="220" w="140" h="66" style="background:#f6e9d8;border:1px solid #a8702a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px">MCU FR</nt-rect>
  <nt-rect id="icd-m3" x="600" y="220" w="140" h="66" style="background:#f6e9d8;border:1px solid #a8702a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px">MCU RL</nt-rect>
  <nt-rect id="icd-m4" x="780" y="220" w="140" h="66" style="background:#f6e9d8;border:1px solid #a8702a;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px">MCU RR</nt-rect>
  <nt-edge id="icd-e1" from="icd-compute" to="icd-bus"></nt-edge>
  <nt-edge id="icd-e2" from="icd-bms" to="icd-bus"></nt-edge>
  <nt-edge id="icd-e3" from="icd-m1" to="icd-bus"></nt-edge>
  <nt-edge id="icd-e4" from="icd-m2" to="icd-bus"></nt-edge>
  <nt-edge id="icd-e5" from="icd-m3" to="icd-bus"></nt-edge>
  <nt-edge id="icd-e6" from="icd-m4" to="icd-bus"></nt-edge>
</nt-diagram>`,
            };
          },
        },
      ],
    },
  ],
};
