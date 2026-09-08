"use client";

import { Component, lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { NmlBlock } from "@/app/lib/nml/schema";
import type { NmlViewBridge, PlainTextNmlBridge, ReadOnlyNmlBridge } from "@/app/lib/nml/view";
import { mountPlainTextNmlView, mountReadOnlyNmlView, type DomainRenderer } from "@/app/lib/nml/view/browser";
import { ReadOnlyContext } from "../readOnly";
import "@blocknote/core/style.css";
import "../editor.css";
import "./view.css";

const DomainContent = lazy(() => import("./ReadOnlyDomainContent"));
type Slot = { host: HTMLElement; block: NmlBlock; key: number };

class DomainBoundary extends Component<{ bridge: NmlViewBridge; nodeId: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.bridge.reportViewFailure(this.props.nodeId); }
  render() { return this.state.failed ? <span role="note">This block could not be displayed. Its content has been preserved.</span> : this.props.children; }
}

class DomainPortals {
  private slots: Slot[] = [];
  private listeners = new Set<() => void>();
  private key = 0;
  snapshot = () => this.slots;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  mount: DomainRenderer = (host, block) => {
    const key = ++this.key;
    this.slots = [...this.slots, { host, block, key }];
    this.emit();
    return {
      update: (next) => { this.slots = this.slots.map((slot) => slot.key === key ? { ...slot, block: next } : slot); this.emit(); },
      destroy: () => { this.slots = this.slots.filter((slot) => slot.key !== key); this.emit(); },
    };
  };
}

function NmlView({ bridge, editable, resolveStorageUrl }: {
  bridge: ReadOnlyNmlBridge | PlainTextNmlBridge;
  editable: boolean;
  resolveStorageUrl?: (storageId: string) => string | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [portals] = useState(() => new DomainPortals());
  const slots = useSyncExternalStore(portals.subscribe, portals.snapshot, portals.snapshot);
  useEffect(() => {
    if (!host.current) return;
    const mounted = editable
      ? mountPlainTextNmlView(host.current, bridge as PlainTextNmlBridge, portals.mount)
      : mountReadOnlyNmlView(host.current, bridge as ReadOnlyNmlBridge, portals.mount);
    return () => mounted.destroy();
  }, [bridge, editable, portals]);
  return <ReadOnlyContext.Provider value={true}>
    <div className={`nt-editor ${editable ? "nt-nml-plain-text-editor" : "nt-nml-reader"}`} ref={host} />
    {slots.map(({ host: target, block, key }) => createPortal(
      <DomainBoundary bridge={bridge} nodeId={block.id}><Suspense fallback={<span>Loading {block.type}…</span>}><DomainContent block={block} resolveStorageUrl={resolveStorageUrl} /></Suspense></DomainBoundary>, target, key,
    ))}
  </ReadOnlyContext.Provider>;
}

/** Mount inside the existing application providers; portals retain their context. */
export function NmlReadOnlyView({ bridge, resolveStorageUrl }: {
  bridge: ReadOnlyNmlBridge;
  resolveStorageUrl?: (storageId: string) => string | undefined;
}) {
  return <NmlView bridge={bridge} editable={false} resolveStorageUrl={resolveStorageUrl} />;
}

/** Step-7 editor: only unmarked paragraph, heading, and quote text is mutable. */
export function NmlPlainTextView({ bridge, resolveStorageUrl }: {
  bridge: PlainTextNmlBridge;
  resolveStorageUrl?: (storageId: string) => string | undefined;
}) {
  return <NmlView bridge={bridge} editable resolveStorageUrl={resolveStorageUrl} />;
}
