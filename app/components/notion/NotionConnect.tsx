import { Brandmark } from "@/app/components/Brand";
import { NotionMark } from "@/app/components/NotionMark";

/**
 * Not connected yet: Notion's mark, ours, a line between them, and the one
 * button that joins them. Still, and nearly wordless — the picture and the
 * button's own label say all of it.
 *
 * The button does not take focus on arrival. This page is reached with Enter,
 * and a link that is focused while that key is still down wears its focus ring
 * before anyone has looked at it — and a held key could follow it straight out
 * to Notion. The page holds focus instead (see `PaletteShell`); Tab reaches the
 * button, and wears the ring then, when it means something.
 */
export function NotionConnect({
  titleId,
  stale,
  blocker,
  href,
  onConnect,
  title = "Bring your pages across from Notion",
}: {
  titleId: string;
  /** There was a connection and Notion has since withdrawn it. */
  stale: boolean;
  /** Why this deployment cannot hold a connection, when it cannot. */
  blocker: string | null;
  /** Where the button goes — the consent screen, leaving this page. */
  href?: string;
  /**
   * Instead of `href`: connect without leaving, in a window of its own — for a
   * page whose unfinished form would not survive the round trip.
   */
  onConnect?: () => void;
  title?: string;
}) {
  return (
    <div className="nt-nc">
      <div className="nt-nc-art" aria-hidden="true">
        <span className="nt-nc-tile">
          <NotionMark width={30} height={30} />
        </span>
        <span className="nt-nc-track" />
        <span className="nt-nc-tile is-ours">
          <Brandmark width={24} height={30} />
        </span>
      </div>

      <h2 id={titleId} className="nt-nc-title">
        {stale ? "Reconnect your Notion" : title}
      </h2>
      {/* Not decoration: it is why someone who already connected is being asked
          again. */}
      {stale && (
        <p className="nt-nc-note">
          Nootles no longer has access to this Notion account. Reconnecting takes a moment.
        </p>
      )}

      {/* No button to a connection this deployment cannot keep: the sentence
          says what is missing instead. */}
      {blocker ? (
        <p className="nt-note nt-nc-blocker">{blocker}</p>
      ) : (
        <a
          href={href ?? "#"}
          className="nt-nc-go"
          onClick={(e) => {
            if (!onConnect) return;
            e.preventDefault();
            onConnect();
          }}
        >
          <NotionMark width={16} height={16} />
          {stale ? "Reconnect Notion" : "Connect Notion"}
        </a>
      )}
    </div>
  );
}
