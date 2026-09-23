"use client";

import { useContainer } from "../ContainerContext";

/** What a workspace is called and where it lives. */
export function GeneralSettings() {
  const container = useContainer();
  if (container.kind !== "workspace") return null;
  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-general">
      <h2 id="nt-ws-general" className="nt-set-label">
        Workspace
      </h2>
      <ul className="nt-set-list">
        <li className="nt-set-row">
          <div className="nt-set-body-col">
            <p className="nt-set-name">{container.name}</p>
            <p className="nt-set-meta">/w/{container.slug}</p>
          </div>
        </li>
      </ul>
    </section>
  );
}
