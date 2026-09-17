/**
 * The three Tab moments.
 *
 * A different seam from chat, deliberately. `tourDrive` carries a hard-won
 * comment: the completion lane was once scripted at the network layer and the
 * pipeline kept withdrawing the suggestion — superseded, unparsed, ungrounded,
 * nothing left after the block gate. A guide cannot promise "press Tab" on top
 * of machinery that is allowed to change its mind, and it kept changing it.
 *
 * So these are painted through the same ghost-text plugin the real lane paints
 * through, and Tab accepts through the same `acceptSuggestion`. What lands is
 * real document state, which is what keeps it in context for everything after.
 *
 * T-10 is the exception that also needs the server: accepting it runs the real
 * `<nt-build-diagram>` macro, which posts to `/api/diagram`. That one request
 * is staged at the route — there are no withdrawal gates on diagram expansion,
 * and staging it there means the canvas lands through the real adopt path into
 * Yjs rather than being painted on top of it.
 */

export type TabScript = {
  id: string;
  title: string;
  /** Matched against the last ~240 characters BEFORE the caret. */
  match: RegExp;
  /** Only fires inside a block of this type, when set. */
  inBlock?: "codeBlock" | "paragraph";
  /** Endings that must produce this suggestion. The regression corpus. */
  types: string[];
  /** The ghost text, in document grammar. */
  ghost: string;
};

export const TAB_SCRIPTS: TabScript[] = [
  {
    id: "T-10",
    title: "Tab builds a diagram",
    match:
      /(?:\b(?:looks|works|goes|runs|breaks down)|laid out|set up)\s+like\s+this\s*:?\s*$|\bas follows\s*:?\s*$|\blike so\s*:?\s*$/i,
    inBlock: "paragraph",
    types: [
      "The power path from the pack to the wheels looks like this:",
      "The power path works like this:",
      "It breaks down like this:",
      "The handoff goes like this:",
      "The sequence is as follows:",
      "It's laid out like this:",
    ],
    ghost:
      "<nt-build-diagram>a block diagram of the KR-1 power path: 8s4p pack → BMS → 48 V bus → " +
      "12 V DC-DC → compute; 48 V bus → 4× DRV8353 → 4× hub motor. Label every link with its " +
      "voltage and peak current. Left to right.</nt-build-diagram>",
  },
  {
    id: "T-07",
    title: "Firmware that obeys the page above it",
    match: /\/\/[^\n]*\b(clamp|limit|derate|cap|saturate|bound)\b[^\n]*\n?\s*$/i,
    inBlock: "codeBlock",
    types: [
      "// clamp the commanded current so we never exceed the BMS discharge limit",
      "// clamp iq to the pack limit",
      "// derate the current limit when the pack is hot",
      "// cap the commanded current at the discharge limit",
    ],
    ghost: `int16_t clamp_iq(int16_t iq_mA, const bms_state_t *bms) {
    int16_t lim = bms->discharge_limit_mA;
    if (bms->pack_temp_c > 45)                       /* thermal derate, see Power & Electrical */
        lim = (int16_t)((int32_t)lim * 70 / 100);
    if (iq_mA >  lim) return  lim;
    if (iq_mA < -lim) return -lim;
    return iq_mA;
}`,
  },
  {
    id: "T-20",
    title: "A completion that read the repo",
    match: /\b(lives in|is implemented in|is handled in|comes from|is set in|is defined in)\s*$/i,
    inBlock: "paragraph",
    types: [
      "The heartbeat timeout lives in ",
      "The timeout is defined in ",
      "That check is implemented in ",
      "The value comes from ",
    ],
    ghost:
      "<code>src/teleop/watchdog.c:7</code> — <code>HEARTBEAT_TIMEOUT_MS 300</code>, " +
      "the same 300 ms REQ-015 promises.",
  },
];

/** The canvas `/api/diagram` returns for T-10's brief, instead of calling a model. */
export const STAGED_DIAGRAM_BRIEF = /\bKR-1 power path\b|\b8s4p pack\b/i;
