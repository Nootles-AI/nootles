"use client";

import { Kit } from "../_kit/store";
import { Facepile } from "../_kit/Shell";
import { Doc } from "../_kit/Doc";
import { Chrome } from "../_kit/Extras";
import { Dock } from "./parts";
import "./style.css";

/*
  THESIS: no rails. The page has the whole window, and the chrome is one ink
  bar that becomes what the moment needs — the projects page's New project
  button, which turns into its own menu, promoted to the entire shell. Refuses
  the three-column editor.
  OWN-WORLD: paper edge to edge; a single graphite surface with a 16px corner
  and a deep soft shadow; paper-coloured marks and keys on it; light trays only
  where a panel has to be read as a document (layers, design). Everything that
  changes size travels on the damped spring; everything inside crossfades.
  STORY: you write; when you need pages, the assistant or tools, you reach for
  the same place every time, and it answers in the shape of the need.
  FIRST VIEWPORT: the document column centred on bare paper, presence top
  right, the dock bottom centre at 720px: page name · Ask field · find · share
  · you. Pages and the conversation grow upward out of it; entering the diagram
  turns it into the toolbar, with Layers and Design rising from its two ends.
  FORM: structure 3 of 5 — one surface, four states.
*/

export default function OneBar() {
  return (
    <Kit className="b">
      <div className="b-presence">
        <Facepile />
      </div>
      <main className="b-page">
        <Doc />
      </main>
      <Dock />
      <Chrome />
    </Kit>
  );
}
