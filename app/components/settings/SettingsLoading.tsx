import Link from "next/link";
import { Wordmark } from "../Brand";
import { Bone } from "../workspaces/settings/parts";
import "./settings.css";
import "../workspaces/workspaces.css";

/**
 * A settings page before it can be drawn — the account is still signing in,
 * or a workspace's address has not said which workspace it is: the page's own
 * chrome on its own surface, with the way back and the title held as bars,
 * so arriving never passes through a white page. A workspace's settings also
 * hold the row of sections and a card under them.
 */
export function SettingsLoading({ workspace }: { workspace?: boolean }) {
  return (
    <div className="nt-set-page">
      <header className="nt-set-topbar">
        <Link href="/" aria-label="Nootles">
          <Wordmark height={18} />
        </Link>
        <span className="nt-skeleton nt-ws-bone-sunk h-3.5 w-36" aria-hidden="true" />
      </header>
      <main className="nt-set-body" aria-busy="true">
        {workspace ? (
          <h1 className="nt-set-title">Workspace settings</h1>
        ) : (
          <div className="flex h-[34.5px] items-center" aria-hidden="true">
            <span className="nt-skeleton nt-ws-bone-sunk h-7 w-64" />
          </div>
        )}
        {workspace && (
          <div className="nt-ws-set-nav" aria-hidden="true">
            {["w-14", "w-16", "w-20", "w-12"].map((width) => (
              <span key={width} className="flex h-8 items-center px-2">
                <span className={`nt-skeleton nt-ws-bone-sunk h-3.5 ${width}`} />
              </span>
            ))}
          </div>
        )}
        <section className="nt-set-section" aria-hidden="true">
          <Bone bar="h-3.5 w-20" className="mb-2" />
          <ul className="nt-set-list">
            {(workspace ? [0, 1] : [0]).map((i) => (
              <li key={i}>
                <div className="nt-set-row">
                  <span className="nt-set-glyph">
                    <span className="nt-skeleton h-5 w-5" />
                  </span>
                  <div className="nt-set-body-col">
                    <div className="flex h-5 items-center">
                      <div className="nt-skeleton h-3.5 w-32" />
                    </div>
                    <Bone bar="h-3 w-full" className="mt-0.5" />
                    <Bone bar="h-3 w-2/5" />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
