"use client";

import { Dialog } from "./Dialog";
import {
  SHORTCUTS,
  SHORTCUTS_BY_ID,
  SHORTCUT_GROUPS,
  isApplePlatform,
  shortcutHint,
  type ShortcutId,
} from "./editor/canvas/engine/shortcuts";

/**
 * The keys, written down. The diagram half is not a copy: it is read off the
 * same table the diagrams bind from, so a shortcut cannot be listed here and
 * missing there. The rest are the few the shell and the page own.
 */

const mod = (apple: boolean) => (apple ? "⌘" : "Ctrl+");
const alt = (apple: boolean) => (apple ? "⌘⌥" : "Ctrl+Alt+");

/** The page's, listed in the table so their labels and keys live in one place. */
const PAGE_ZOOM: readonly ShortcutId[] = ["view.zoomIn", "view.zoomOut", "view.zoomReset"];

const ELSEWHERE = (apple: boolean): [group: string, rows: [label: string, keys: string][]][] => [
  [
    "Anywhere",
    [
      ["Find a page", `${mod(apple)}K`],
      ["Undo", `${mod(apple)}Z`],
      ["Redo", apple ? "⌘⇧Z" : "Ctrl+Shift+Z"],
      ["Pick a tool", `${apple ? "⌥⇧" : "Alt+Shift+"} + letter`],
      ...PAGE_ZOOM.map((id) => [SHORTCUTS_BY_ID[id].label, shortcutHint(id, apple)] as [string, string]),
      ["This list", "?"],
    ],
  ],
  [
    "Writing",
    [
      ["Insert a block", "/"],
      ["Select the diagram above or below", "↑  ↓"],
      ["Paste shapes: makes a diagram", apple ? "⌘V" : "Ctrl+V"],
      ["Link to a page", "@"],
      ["Accept a suggestion", "Tab"],
      ["Next / previous reformat", apple ? "⌥→  ⌥←" : "Alt+→  Alt+←"],
      ["Link the selection", `${mod(apple)}K`],
      ["Turn into text, heading 1–3", `${alt(apple)}0–3`],
      ["Turn into to-do, bullet, numbered, toggle", `${alt(apple)}4–7`],
      ["Tick a to-do, fold a toggle", apple ? "⌘↵" : "Ctrl+Enter"],
      ["Strikethrough", apple ? "⌘⇧X" : "Ctrl+Shift+X"],
      ["Inline equation", apple ? "⌘⇧E" : "Ctrl+Shift+E"],
    ],
  ],
  [
    "Pages list",
    [
      ["Select all", `${mod(apple)}A`],
      ["Cut, copy, paste", apple ? "⌘X  ⌘C  ⌘V" : "Ctrl+X  C  V"],
      ["Clear the selection", "Esc"],
    ],
  ],
];

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  // Only ever mounted from a key press or a click, so this is the client.
  const apple = isApplePlatform();
  const canvas = SHORTCUT_GROUPS.map(
    (group) =>
      [
        group,
        SHORTCUTS.filter((s) => s.group === group && !PAGE_ZOOM.includes(s.id))
          .map((s) => [s.label, shortcutHint(s.id, apple)] as [string, string])
          .filter(([, keys]) => keys),
      ] as [string, [string, string][]],
  );

  return (
    <Dialog label="Keyboard shortcuts" className="nt-keys" onClose={onClose}>
      <div className="nt-dialog-head">
        <p className="text-sm font-medium">Keyboard shortcuts</p>
      </div>
      <div className="nt-dialog-body nt-keys-body">
        <div className="nt-keys-cols">
        {[...ELSEWHERE(apple), ...canvas.filter(([, rows]) => rows.length).map(([g, rows]) => [`Diagram · ${g}`, rows] as [string, [string, string][]])].map(
          ([group, rows]) => (
            <section key={group} className="nt-keys-group">
              <h3 className="nt-section-label">{group}</h3>
              <dl>
                {rows.map(([label, keys]) => (
                  <div key={label} className="nt-keys-row">
                    <dt>{label}</dt>
                    <dd>{keys}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ),
        )}
        </div>
      </div>
    </Dialog>
  );
}
