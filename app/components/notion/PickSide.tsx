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
  return (
    <aside className="nt-pal-side nt-pal-pickside" aria-hidden="true">
      {node ? (
        <div className="nt-pal-card nt-pal-tpl">
          <div className="nt-pal-sheet" key={node.id}>
            <Opening node={node} />
          </div>
          <p className="nt-pal-card-line">{path.length ? path.join(" › ") : "Top level"}</p>
          <dl className="nt-pal-facts">
            <div>
              <dt>Pages inside</dt>
              <dd className="nt-meta">{inside}</dd>
            </div>
            <div>
              <dt>Importing</dt>
              <dd className="nt-meta">
                {state === "on" ? (inside ? "All of it" : "Yes") : state === "partial" ? "Part of it" : "No"}
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="nt-pal-pickhint">
          Ticking a page takes everything inside it. The arrow keys move through the list, and
          Space ticks.
        </p>
      )}

      <div className="nt-pal-tally" data-on={count > 0}>
        <p className="nt-pal-tally-n">{count}</p>
        <p className="nt-pal-tally-line">
          {count === 1 ? "page" : "pages"} chosen
          {lands && <span>{lands}</span>}
        </p>
      </div>
    </aside>
  );
}

/**
 * The page's opening under its own title, the way Notion heads a page. While it
 * is being read the sheet holds the title over a few ruled lines; a page that
 * cannot be read keeps the title alone, which is still the right page.
 */
function Opening({ node }: { node: NotionPageNode }) {
  const blocks = useOpening(node.id);
  const title = {
    id: `${node.id}.title`,
    type: "heading",
    props: { level: 1 },
    content: [{ type: "text", text: `${node.emoji ? `${node.emoji} ` : ""}${node.title}`, styles: {} }],
  };
  return (
    <div className="nt-pal-opening" data-reading={blocks === undefined || undefined}>
      <BlocksThumb blocks={[title, ...(blocks ?? [])]} />
    </div>
  );
}

const size = (node: NotionPageNode): number =>
  1 + node.children.reduce((total, child) => total + size(child), 0);
