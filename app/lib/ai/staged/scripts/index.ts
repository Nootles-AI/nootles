import type { StagedScript } from "../types";
import { C05 } from "./c05";
import { C06 } from "./c06";
import { C07 } from "./c07";
import { C09 } from "./c09";
import { C10 } from "./c10";
import { C11 } from "./c11";
import { C12 } from "./c12";
import { C13 } from "./c13";
import { C14 } from "./c14";
import { C16 } from "./c16";
import { C18 } from "./c18";
import { C21 } from "./c21";
import { C22 } from "./c22";
import { C26 } from "./c26";

/**
 * The fourteen chat calls, in run order.
 *
 * Order is presentation, not precedence. `matchScript` requires exactly one
 * regex to fire and treats two as none, because a demo that answers the wrong
 * canned question is worse than one that answers honestly — and the separation
 * test asserts that branch is unreachable for every phrasing in every corpus.
 */
export const SCRIPTS: StagedScript[] = [
  C16, // 1  does the firmware do what REQ-015 says
  C11, // 2  architecture from the repo
  C07, // 3  diagram the power path          ─┐
  C09, // 4  add a retry branch               ├ chain
  C10, // 5  colour the safety-critical path ─┘
  C13, // 6  roadmap                          ─┐
  C14, // 7  what's the critical path          ┘ chain
  C05, // 8  which requirements have no test
  C21, // 9  FMEA
  C18, // 10 does this motor meet REQ-014
  C22, // 11 ICD
  C12, // 12 wireframe the teleop screen
  C06, // 13 split into pages  — changes the project, so it goes late
  C26, // 14 two chassis layouts
];
