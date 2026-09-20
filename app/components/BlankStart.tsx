import {
  Album,
  CodeBlock,
  Diagram,
  Heading1,
  Location,
  MathBlock,
  Storyboard,
  Table,
  TodoList,
} from "./Icons";

/**
 * A blank project, pictured: an empty page with one keystroke on it, and every
 * tool that keystroke offers.
 *
 * Not a toolbar. A Nootles page is a column of blocks, and on a blank one the
 * way to all of them is "/" — so the honest picture of "everything is
 * possible" is the page, the slash, and the menu it opens, under the names and
 * glyphs the real menu uses. The sheet runs off the pane, like the template
 * wall beside it: a piece of something larger.
 *
 * Decorative, and marked so: the row it sits beside says what it is.
 */
const TOOLS = [
  { icon: Heading1, name: "Heading" },
  { icon: TodoList, name: "To-do list" },
  { icon: Table, name: "Table" },
  { icon: Diagram, name: "Diagram" },
  { icon: CodeBlock, name: "Code block" },
  { icon: MathBlock, name: "Math block" },
  { icon: Album, name: "Album" },
  { icon: Location, name: "Location" },
  { icon: Storyboard, name: "Storyboard" },
];

export function BlankStart() {
  return (
    <div className="nt-blank" aria-hidden="true">
      <div className="nt-blank-sheet">
        <p className="nt-blank-title">Untitled</p>
        <p className="nt-blank-line">
          /<i className="nt-blank-caret" />
        </p>
        <div className="nt-blank-menu">
          <span className="nt-blank-pick" />
          {TOOLS.map(({ icon: Icon, name }) => (
            <div key={name} className="nt-blank-tool">
              <Icon width={15} height={15} />
              {name}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
