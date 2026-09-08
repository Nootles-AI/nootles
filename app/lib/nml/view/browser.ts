import { EditorView, type NodeView } from "prosemirror-view";
import type { Node as PmNode } from "prosemirror-model";
import type { NmlBlock } from "../schema";
import type { NmlViewBridge, PlainTextNmlBridge, ReadOnlyNmlBridge } from "./bridge";
import { loadKatex } from "@/app/components/editor/math/katex";
import { FILE_DOC_PATHS } from "@/app/components/Icons";

export type DomainMount = { update: (block: NmlBlock) => void; destroy: () => void };
export type DomainRenderer = (host: HTMLElement, block: NmlBlock) => DomainMount;
export const DOMAIN_TYPES = new Set(["codeBlock", "mathBlock", "canvas", "album", "storyboard", "location", "image", "video", "audio", "file"]);

function mountNmlView(host: HTMLElement, bridge: NmlViewBridge, renderDomain?: DomainRenderer): { view: EditorView; destroy: () => void } {
  const domainViews = new Map<string, DomainMount>();
  const nodeViews: Record<string, (node: PmNode) => NodeView> = {};
  const toggle = bridge.projection.registry.get("toggleListItem");
  if (toggle) nodeViews[toggle.pmNodeType] = (node) => {
    const dom = host.ownerDocument.createElement("div");
    dom.dataset.nmlId = node.attrs.nmlId;
    dom.dataset.contentType = "toggleListItem";
    dom.dataset.open = "false";
    const button = host.ownerDocument.createElement("button");
    button.type = "button";
    button.contentEditable = "false";
    button.className = "nt-nml-toggle";
    button.textContent = "▸";
    button.setAttribute("aria-label", "Expand content");
    button.setAttribute("aria-expanded", "false");
    button.onclick = () => {
      const open = dom.dataset.open !== "true";
      dom.dataset.open = String(open);
      button.textContent = open ? "▾" : "▸";
      button.setAttribute("aria-expanded", String(open));
      button.setAttribute("aria-label", open ? "Collapse content" : "Expand content");
    };
    const contentDOM = host.ownerDocument.createElement("div");
    contentDOM.className = "nt-nml-toggle-content";
    dom.append(button, contentDOM);
    return { dom, contentDOM,
      update: (next) => next.type === node.type && next.attrs.nmlId === node.attrs.nmlId,
      stopEvent: (event) => button.contains(event.target as globalThis.Node),
      ignoreMutation: (mutation) => mutation.type !== "selection" && (mutation.target === dom || button.contains(mutation.target)),
    };
  };
  nodeViews.math = (node) => {
    const dom = host.ownerDocument.createElement("span");
    dom.dataset.nmlId = node.attrs.nmlId;
    dom.className = "nt-math-inline";
    dom.contentEditable = "false";
    let generation = 0;
    const render = (next: PmNode) => {
      const mine = ++generation;
      dom.textContent = next.attrs.latex;
      void Promise.resolve(loadKatex()).then((katex) => { if (mine === generation) dom.innerHTML = katex(next.attrs.latex); }).catch(() => {});
    };
    render(node);
    return { dom, update: (next) => { if (next.type !== node.type || next.attrs.nmlId !== node.attrs.nmlId) return false; render(next); return true; }, ignoreMutation: () => true, destroy: () => { generation++; } };
  };
  nodeViews.pageRef = (node) => {
    const dom = host.ownerDocument.createElement("span");
    dom.dataset.nmlId = node.attrs.nmlId;
    dom.dataset.pageId = node.attrs.pageId;
    dom.className = "nt-ref";
    dom.contentEditable = "false";
    const icon = host.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("class", "nt-ref-icon");
    for (const value of FILE_DOC_PATHS) {
      const path = host.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", value);
      icon.appendChild(path);
    }
    const label = host.ownerDocument.createTextNode(node.attrs.fallbackTitle);
    dom.append(icon, label);
    return {
      dom,
      update: (next) => {
        if (next.type !== node.type || next.attrs.nmlId !== node.attrs.nmlId) return false;
        dom.dataset.pageId = next.attrs.pageId;
        label.data = next.attrs.fallbackTitle;
        return true;
      },
      ignoreMutation: () => true,
    };
  };
  if (renderDomain) for (const adapter of bridge.projection.registry.values()) {
    if (!DOMAIN_TYPES.has(adapter.nmlType)) continue;
    nodeViews[adapter.pmNodeType] = (node) => {
      const id = node.attrs.nmlId as string;
      const dom = host.ownerDocument.createElement("div");
      dom.dataset.nmlId = id;
      dom.dataset.contentType = adapter.nmlType;
      dom.className = "bn-block-content";
      dom.contentEditable = "false";
      const block = bridge.getBlock(id);
      if (!block) throw new Error("Missing canonical domain");
      const mounted = renderDomain(dom, block);
      domainViews.set(id, mounted);
      return {
        dom,
        update: (next) => next.type === node.type && next.attrs.nmlId === id,
        ignoreMutation: () => true,
        stopEvent: () => true,
        destroy: () => { if (domainViews.get(id) === mounted) domainViews.delete(id); mounted.destroy(); },
      };
    };
  }
  const view = new EditorView(host, {
    state: bridge.state, nodeViews, editable: () => bridge.isEditable(),
    // BlockNote's global plugins treat every .bn-editor as their own schema.
    attributes: {
      class: "bn-default-styles nt-nml-view",
      role: bridge.isEditable() ? "textbox" : "document",
      "aria-label": bridge.isEditable() ? "Plain-text document editor" : "Read-only document",
      "aria-readonly": String(!bridge.isEditable()),
      ...(bridge.isEditable() ? { "aria-multiline": "true" } : {}),
    },
    dispatchTransaction: (transaction) => { if (!bridge.dispatch(transaction)) view.updateState(bridge.state); },
    handlePaste: () => true,
    handleDrop: () => true,
    handleDOMEvents: { beforeinput: (_view, event) => {
      if (bridge.isEditable()) return false;
      event.preventDefault();
      return true;
    } },
  });
  const notice = host.ownerDocument.createElement("div");
  notice.setAttribute("role", "status");
  notice.className = "nt-nml-view-notice";
  host.appendChild(notice);
  const showStatus = () => {
    host.dataset.nmlStatus = bridge.status();
    notice.hidden = bridge.status() !== "frozen";
    notice.textContent = bridge.status() === "frozen" ? "This preview is unavailable or out of date. Reopen with a compatible client. Your document has been preserved." : "";
    view.dom.setAttribute("aria-label", bridge.status() === "frozen"
      ? "Document preview unavailable or out of date. Reopen with a compatible client."
      : bridge.isEditable() ? "Plain-text document editor" : "Read-only document");
  };
  showStatus();
  const stop = bridge.subscribe((update) => {
    if (view.state !== update.state) view.updateState(update.state);
    for (const id of update.changedNodeIds) {
      const block = bridge.getBlock(id);
      if (block) domainViews.get(id)?.update(block);
    }
    showStatus();
  });
  return { view, destroy: () => { stop(); view.destroy(); notice.remove(); delete host.dataset.nmlStatus; } };
}

export function mountReadOnlyNmlView(host: HTMLElement, bridge: ReadOnlyNmlBridge, renderDomain?: DomainRenderer): { view: EditorView; destroy: () => void } {
  return mountNmlView(host, bridge, renderDomain);
}

export function mountPlainTextNmlView(host: HTMLElement, bridge: PlainTextNmlBridge, renderDomain?: DomainRenderer): { view: EditorView; destroy: () => void } {
  return mountNmlView(host, bridge, renderDomain);
}
