import Link from "next/link";
import { Brandmark } from "./_kit/icons";
import { mockups } from "./_kit/data";
import "./index.css";

export default function EditorMockupIndex() {
  return (
    <main className="ex">
      <header>
        <Brandmark role="img" aria-label="Nootles" width={20} height={24} />
        <h1>The workspace, ten ways</h1>
      </header>
      <p className="ex-note">
        One project, one page, one diagram, one conversation — and every affordance of the real workspace, in the
        projects page’s materials and motion. What changes is where things live. 01–05 rearrange the shell; 06–10 go a step further out. Nothing here touches Convex or a
        model: the assistant’s reply is a script. Press <kbd>[</kbd> and <kbd>]</kbd> inside any of them to step
        through, <kbd>⌘K</kbd> to find, and click the diagram to enter it.
      </p>
      <ol>
        {mockups.map((m) => (
          <li key={m.n}>
            <Link href={`/editor-mockup/${m.n}`}>
              <span className="ex-n">{String(m.n).padStart(2, "0")}</span>
              <span className="ex-name">{m.name}</span>
              <span className="ex-what">{m.note}</span>
            </Link>
          </li>
        ))}
      </ol>
    </main>
  );
}
