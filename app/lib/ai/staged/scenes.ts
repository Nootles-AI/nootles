/**
 * Canned canvases, in one place because two lanes draw the same board.
 *
 * C-07 writes the power path through `edit_page`; T-10 arrives at the same
 * board through the Tab lane's `<nt-build-diagram>` macro and `/api/diagram`.
 * Written twice they would drift, and C-09 and C-10 read shape ids off
 * whichever one actually ran.
 */

export const POWER_PATH = `<nt-diagram h="420" wide>
  <nt-rect id="pp-pack" x="-240" y="160" w="150" h="76" style="background:#e8eef7;border:2px solid #3f5d84;border-radius:6px;display:flex;align-items:center;justify-content:center;text-align:center">8s4p pack<br/>991 Wh</nt-rect>
  <nt-rect id="pp-bms" x="20" y="160" w="130" h="76" style="background:#e8eef7;border:2px solid #3f5d84;border-radius:6px;display:flex;align-items:center;justify-content:center;text-align:center">BMS</nt-rect>
  <nt-rect id="pp-bus" x="260" y="160" w="130" h="76" style="background:#dce9dc;border:2px solid #4a7a4a;border-radius:6px;display:flex;align-items:center;justify-content:center;text-align:center">48 V bus</nt-rect>
  <nt-rect id="pp-dcdc" x="510" y="52" w="150" h="70" style="background:#e8eef7;border:2px solid #3f5d84;border-radius:6px;display:flex;align-items:center;justify-content:center;text-align:center">12 V DC-DC</nt-rect>
  <nt-rect id="pp-compute" x="810" y="52" w="150" h="70" style="background:#e8eef7;border:2px solid #3f5d84;border-radius:6px;display:flex;align-items:center;justify-content:center;text-align:center">Compute</nt-rect>
  <nt-rect id="pp-drv" x="510" y="230" w="150" h="76" style="background:#f6e9d8;border:2px solid #a8702a;border-radius:6px;display:flex;align-items:center;justify-content:center;text-align:center">4× DRV8353<br/>gate driver</nt-rect>
  <nt-rect id="pp-motor" x="810" y="230" w="150" h="76" style="background:#f6e9d8;border:2px solid #a8702a;border-radius:6px;display:flex;align-items:center;justify-content:center;text-align:center">4× hub motor</nt-rect>
  <nt-rect id="pp-estop" x="260" y="320" w="130" h="62" style="background:#f7dede;border:2px solid #a33;border-radius:6px;display:flex;align-items:center;justify-content:center;text-align:center">E-stop<br/>contactor</nt-rect>
  <nt-text id="pp-title" x="-240" y="24" w="420" h="30" style="font-size:18px;font-weight:600;color:#33415c">KR-1 power path</nt-text>
  <nt-edge id="pp-e1" from="pp-pack" to="pp-bms">33.6 V nom</nt-edge>
  <nt-edge id="pp-e2" from="pp-bms" to="pp-bus">48 V · 60 A pk</nt-edge>
  <nt-edge id="pp-e3" from="pp-bus" to="pp-dcdc">48 V · 4 A</nt-edge>
  <nt-edge id="pp-e4" from="pp-dcdc" to="pp-compute">12 V · 6 A</nt-edge>
  <nt-edge id="pp-e5" from="pp-bus" to="pp-drv">48 V · 48 A pk</nt-edge>
  <nt-edge id="pp-e6" from="pp-drv" to="pp-motor">3φ · 12 A/motor</nt-edge>
  <nt-edge id="pp-e7" from="pp-bus" to="pp-estop">interrupts</nt-edge>
  <nt-edge id="pp-e8" from="pp-estop" to="pp-drv">latch open</nt-edge>
</nt-diagram>`;
