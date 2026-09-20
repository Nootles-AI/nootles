import { Check, FileDoc, Folder } from "@/app/components/Icons";
import { BlocksThumb } from "@/app/components/PagePreview";
import type { NotionPageNode } from "@/app/lib/notion/plan";
import { useOpening } from "./useOpening";

/**
 * The palette's side pane while choosing pages: the page under the highlight on
 * top, and what the import will do below.
 *
 * It answers the two questions the list cannot. Where is this? — a Notion tree
 * shown flat loses its place, so the page's path is written out. And what am I
 * about to do? — how many pages, and the name of the project they become, kept
 * in view the whole time rather than appearing in a sentence once something is
 * ticked.
 *
 * On top of both is the page itself: its opening, read from Notion once the
 * highlight rests, and drawn by the project thumbnail's renderer from the
 * blocks the import would write — so it is a picture of what arrives.
 */
export function PickSide({
  node,
  path,
  state,
  count,
  lands,
}: {
  /** The page under the highlight, if there is one. */
  node: NotionPageNode | null;
  /** Its ancestors, outermost first. */
  path: string[];
  state: "on" | "partial" | "off";
  /** Pages ticked, across the whole tree. */
  count: number;
  /** Where they go, as a sentence; absent until something is ticked. */
  lands: string | null;
}) {
  const inside = node ? size(node) - 1 : 0;
  const importing =
    state === "on" ? (inside ? "Importing all of it" : "Importing") : state === "partial" ? "Importing part of it" : "Not chosen";
  return (
    <aside className="nt-pal-side" aria-hidden="true">
      {/* The template pane's own arrangement: the page on top, taking what
          height there is, and what is known about it in rows underneath. */}
      <div className="nt-pal-card nt-pal-tpl">
        {node ? (
          <div className="nt-pal-sheet" key={node.id}>
            <Opening node={node} />
          </div>
        ) : (
          <p className="nt-pal-pickhint">
            Ticking a page takes everything inside it. The arrow keys move through the list, and
            Space ticks.
          </p>
        )}
        <ul className="nt-pal-files">
          {node && (
            <>
              <li className="nt-pal-file">
                <Folder width={14} height={14} />
                <span>{path.length ? path.join(" › ") : "Top level"}</span>
              </li>
              <li className="nt-pal-file">
                <FileDoc width={14} height={14} />
                <span>
                  {inside} {inside === 1 ? "page" : "pages"} inside
                </span>
              </li>
              <li className="nt-pal-file" data-lit={state !== "off"}>
                <Check width={14} height={14} />
                <span>{importing}</span>
              </li>
            </>
          )}
          <li className="nt-pal-file is-sum" data-lit={count > 0}>
            <span>
              {count} {count === 1 ? "page" : "pages"} chosen
            </span>
          </li>
          {lands && (
            <li className="nt-pal-file">
              <span>{lands}</span>
            </li>
          )}
        </ul>
      </div>
    </aside>
  );
}

/**
 * The page's opening under its own title, the way Notion heads a page. While it
 * is being read the sheet holds only ruled lines; a page that cannot be read
 * keeps the title alone, which is still the right page.
 */
function Opening({ node }: { node: NotionPageNode }) {
  const blocks = useOpening(node.id);
  const title = {
    id: `${node.id}.title`,
    type: "heading",
    props: { level: 1 },
    content: [{ type: "text", text: `${node.emoji ? `${node.emoji} ` : ""}${node.title}`, styles: {} }],
  };
  // No title while it is being read: a title over nothing is a picture of an
  // empty page, which is a claim about this one.
  if (blocks === undefined) {
    return (
      <div className="nt-thumb nt-pal-reading-sheet">
        <span />
        <span />
        <span />
        <span />
      </div>
    );
  }
  return <BlocksThumb blocks={[title, ...(blocks ?? [])]} />;
}

const size = (node: NotionPageNode): number =>
  1 + node.children.reduce((total, child) => total + size(child), 0);
