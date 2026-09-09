import { EditorView, type NodeView } from "prosemirror-view";
import type { Node as PmNode } from "prosemirror-model";
import type { NmlBlock } from "../schema";
import type { EditableNmlBridge, NmlViewBridge, PlainTextNmlBridge, ReadOnlyNmlBridge } from "./bridge";
import { loadKatex } from "@/app/components/editor/math/katex";
import { FILE_DOC_PATHS } from "@/app/components/Icons";

export type DomainMount = { update: (block: NmlBlock) => void; destroy: () => void };
export type DomainRenderer = (host: HTMLElement, block: NmlBlock) => DomainMount;
export const DOMAIN_TYPES = new Set(["codeBlock", "mathBlock", "canvas", "album", "storyboard", "location", "image", "video", "audio", "file"]);

function mountNmlView(host: HTMLElement, bridge: NmlViewBridge, renderDomain?: DomainRenderer): { view: EditorView; destroy: () => void } {
  const domainViews = new Map<string, DomainMount>();
  let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;
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
      "aria-label": bridge.supportsRichEditing() ? "Rich document editor" : bridge.isEditable() ? "Plain-text document editor" : "Read-only document",
      "aria-readonly": String(!bridge.isEditable()),
      ...(bridge.isEditable() ? { "aria-multiline": "true" } : {}),
    },
    dispatchTransaction: (transaction) => { if (!bridge.dispatch(transaction)) view.updateState(bridge.state); },
    handleKeyDown: (_view, event) => {
      if (!bridge.isEditable()) return false;
      if (event.key === "Enter" && bridge.supportsRichEditing()) return bridge.splitSelection();
      if (event.key === "Backspace" && bridge.supportsRichEditing()) return bridge.joinBackward();
      if (event.key === "Tab" && bridge.supportsRichEditing()) return bridge.indentSelection(event.shiftKey);
      if ((event.metaKey || event.ctrlKey) && event.altKey && event.key === "ArrowUp") return bridge.moveSelection(-1);
      if ((event.metaKey || event.ctrlKey) && event.altKey && event.key === "ArrowDown") return bridge.moveSelection(1);
      if (!bridge.supportsRichEditing() || !(event.metaKey || event.ctrlKey)) return false;
      if (event.key.toLowerCase() === "b") return bridge.toggleMark("bold");
      if (event.key.toLowerCase() === "i") return bridge.toggleMark("italic");
      if (event.key.toLowerCase() === "u") return bridge.toggleMark("underline");
      if (event.shiftKey && event.key.toLowerCase() === "x") return bridge.toggleMark("strike");
      if (event.key === "`") return bridge.toggleMark("code");
      return false;
    },
    handlePaste: (_view, event) => {
      if (!bridge.supportsRichEditing()) return true;
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined) return true;
      event.preventDefault();
      return bridge.pasteText(text);
    },
    handleDrop: (_view, event) => {
      if (!bridge.supportsRichEditing()) return true;
      const text = event.dataTransfer?.getData("text/plain");
      if (text === undefined) return true;
      event.preventDefault();
      return bridge.pasteText(text);
    },
    handleDOMEvents: {
      beforeinput: (_view, event) => {
        if (bridge.isEditable()) return false;
        event.preventDefault();
        return true;
      },
      compositionstart: () => {
        if (!bridge.isEditable()) return false;
        return !bridge.beginComposition();
      },
      compositionend: () => {
        if (!bridge.isEditable()) return false;
        if (compositionEndTimer) clearTimeout(compositionEndTimer);
        // ProseMirror flushes the final DOM mutation in a microtask after this event.
        compositionEndTimer = setTimeout(() => {
          compositionEndTimer = null;
          bridge.endComposition();
        }, 0);
        return false;
      },
    },
  });
  const notice = host.ownerDocument.createElement("div");
  notice.setAttribute("role", "status");
  notice.className = "nt-nml-view-notice";
  host.appendChild(notice);
  const recovery = host.ownerDocument.createElement("div");
  recovery.className = "nt-nml-composition-recovery";
  recovery.setAttribute("role", "alert");
  const recoveryLabel = host.ownerDocument.createElement("p");
  recoveryLabel.textContent = "A collaborator removed the block you were typing in. Your unfinished text is preserved below.";
  const recoveryText = host.ownerDocument.createElement("textarea");
  recoveryText.readOnly = true;
  recoveryText.setAttribute("aria-label", "Recovered unfinished text");
  const dismissRecovery = host.ownerDocument.createElement("button");
  dismissRecovery.type = "button";
  dismissRecovery.textContent = "Dismiss";
  dismissRecovery.onclick = () => bridge.clearCompositionRecovery();
  recovery.append(recoveryLabel, recoveryText, dismissRecovery);
  host.appendChild(recovery);
  const showStatus = () => {
    host.dataset.nmlStatus = bridge.status();
    notice.hidden = bridge.status() !== "frozen";
    notice.textContent = bridge.status() === "frozen" ? "This preview is unavailable or out of date. Reopen with a compatible client. Your document has been preserved." : "";
    view.dom.setAttribute("aria-label", bridge.status() === "frozen"
      ? "Document preview unavailable or out of date. Reopen with a compatible client."
      : bridge.supportsRichEditing() ? "Rich document editor" : bridge.isEditable() ? "Plain-text document editor" : "Read-only document");
    const preserved = bridge.compositionRecovery();
    recovery.hidden = !preserved;
    recoveryText.value = preserved?.text ?? "";
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
  return { view, destroy: () => {
    if (compositionEndTimer) clearTimeout(compositionEndTimer);
    stop();
    view.destroy();
    notice.remove();
    recovery.remove();
    delete host.dataset.nmlStatus;
  } };
}

export function mountReadOnlyNmlView(host: HTMLElement, bridge: ReadOnlyNmlBridge, renderDomain?: DomainRenderer): { view: EditorView; destroy: () => void } {
  return mountNmlView(host, bridge, renderDomain);
}

export function mountPlainTextNmlView(host: HTMLElement, bridge: PlainTextNmlBridge, renderDomain?: DomainRenderer): { view: EditorView; destroy: () => void } {
  return mountNmlView(host, bridge, renderDomain);
}

export function mountEditableNmlView(host: HTMLElement, bridge: EditableNmlBridge | PlainTextNmlBridge, renderDomain?: DomainRenderer): { view: EditorView; destroy: () => void } {
  return mountNmlView(host, bridge, renderDomain);
}
