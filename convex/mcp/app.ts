/**
 * The MCP App (SEP-1865) that every Nootles tool result renders in:
 * one self-contained HTML document, served as a `ui://` resource and drawn by
 * the host in a sandboxed iframe.
 *
 * Laid out from the "MCP Apps for Claude" Figma kit's inline card — the 52px
 * app header, the list-view rows, the loading skeleton and the footer link; an
 * edit's receipt from its "Confirmation actions" frame (heading, meta panel with
 * an ink button, a checked list) —
 * and styled only through the host's standard variables (`--color-*`,
 * `--font-*`, `--border-radius-*`), each with the kit's own light value as the
 * fallback, so the card takes on Claude's theme wherever it is shown and still
 * reads correctly where no theme is passed.
 *
 * It fetches nothing and loads nothing: every byte it shows arrives in a tool
 * result over postMessage, and links leave through the host's `ui/open-link`.
 */

export const MCP_APP_URI = "ui://nootles/documents.html";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

const LOGO = `<svg width="20" height="20" viewBox="0 0 80 80" aria-hidden="true"><g transform="translate(10.5 4)" fill="#718568"><path d="M41.9521 22.0449C41.952 17.6934 36.9445 8.0475 24.3408 7.83301C18.0937 7.9403 14.0472 10.485 11.5059 13.4551C8.82714 16.5857 7.83206 20.1749 7.83203 22.0459V67.8887C7.83203 70.0514 6.07875 71.8047 3.91602 71.8047C1.75328 71.8047 2.0616e-06 70.0514 0 67.8887V22.0459C2.64743e-05 18.1724 1.75305 12.8064 5.55469 8.36328C9.48603 3.7687 15.6354 0.127431 24.2832 0H24.3994C41.6097 0.253683 49.7841 13.697 49.7842 22.0449V60.5225C49.7748 65.0499 46.3231 71.5582 38.5068 71.8154C34.1545 71.9585 30.8618 70.3816 28.6621 68.0205C26.5837 65.7894 25.6644 63.064 25.4756 60.9814C25.2711 58.7259 25.7618 55.5899 27.5596 52.8867C29.4996 49.9696 32.8155 47.8035 37.5547 47.7266H37.627C39.1932 47.73 40.6466 48.0521 41.9521 48.5576V22.0449ZM37.6377 55.5586C35.5397 55.6038 34.6082 56.4295 34.0801 57.2236C33.4061 58.2373 33.2096 59.5381 33.2764 60.2744C33.3308 60.8745 33.6589 61.8931 34.3936 62.6816C35.0072 63.3402 36.0943 64.0591 38.249 63.9883C39.695 63.9407 40.5373 63.3749 41.0723 62.7373C41.6896 62.0014 41.9485 61.0942 41.9521 60.5146V58.1338C41.9275 58.0929 41.8987 58.0426 41.8604 57.9863C41.6416 57.6657 41.288 57.26 40.8125 56.8652C39.8395 56.0575 38.7033 55.5693 37.6377 55.5586Z"/></g></svg>`;

const STYLE = String.raw`
:root {
  --nt-bg: var(--color-background-primary, #ffffff);
  --nt-bg-2: var(--color-background-secondary, #f5f4ed);
  --nt-bg-3: var(--color-background-tertiary, #faf9f5);
  --nt-text: var(--color-text-primary, #141413);
  --nt-text-2: var(--color-text-secondary, #3d3d3a);
  --nt-text-3: var(--color-text-tertiary, #73726c);
  --nt-info: var(--color-text-info, #3266ad);
  --nt-danger-bg: var(--color-background-warning, #f6eedf);
  --nt-danger: var(--color-text-warning, #5a4815);
  --nt-line: var(--color-border-secondary, rgba(31, 30, 29, 0.3));
  --nt-line-3: var(--color-border-tertiary, rgba(31, 30, 29, 0.15));
  --nt-ring: var(--color-ring-primary, rgba(20, 20, 19, 0.7));
  --nt-hair: var(--border-width-regular, 0.5px);
  --nt-radius: var(--border-radius-lg, 10px);
  --nt-radius-md: var(--border-radius-md, 8px);
  --nt-radius-sm: var(--border-radius-sm, 6px);
  --nt-sans: var(--font-sans, "Anthropic Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  --nt-mono: var(--font-mono, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace);
  --nt-xs: var(--font-text-xs-size, 12px);
  --nt-xs-lh: var(--font-text-xs-line-height, 16.8px);
  --nt-sm: var(--font-text-sm-size, 14px);
  --nt-sm-lh: var(--font-heading-sm-line-height, 19.6px);
  --nt-semibold: var(--font-weight-semibold, 600);
}
:root[data-theme="dark"] {
  --nt-bg: var(--color-background-primary, #30302e);
  --nt-bg-2: var(--color-background-secondary, #262624);
  --nt-bg-3: var(--color-background-tertiary, #141413);
  --nt-text: var(--color-text-primary, #faf9f5);
  --nt-text-2: var(--color-text-secondary, #c2c0b6);
  --nt-text-3: var(--color-text-tertiary, #9c9a92);
  --nt-info: var(--color-text-info, #80aadd);
  --nt-danger-bg: var(--color-background-warning, #483a0f);
  --nt-danger: var(--color-text-warning, #d1a041);
  --nt-line: var(--color-border-secondary, rgba(222, 220, 209, 0.3));
  --nt-line-3: var(--color-border-tertiary, rgba(222, 220, 209, 0.15));
  --nt-ring: var(--color-ring-primary, rgba(250, 249, 245, 0.7));
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
/* On the body, not the root: a framed document whose root scheme differs from
   its host page's is painted opaque, which shows at the card's corners. */
body { color-scheme: light; }
:root[data-theme="dark"] body { color-scheme: dark; }
body { font-family: var(--nt-sans); color: var(--nt-text); -webkit-font-smoothing: antialiased; font-feature-settings: "salt" 1; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--nt-ring); outline-offset: -2px; border-radius: var(--nt-radius-sm); }

.card { background: var(--nt-bg); border: var(--nt-hair) solid var(--nt-line); border-radius: var(--nt-radius); overflow: hidden; }
.header { height: 52px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border-bottom: var(--nt-hair) solid var(--nt-line-3); }
.app { display: flex; align-items: center; gap: 8px; min-width: 0; }
.app .logo { width: 20px; height: 20px; flex: none; display: grid; place-items: center; }
.app .name { font-size: var(--nt-sm); line-height: var(--nt-sm-lh); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.app .crumb { color: var(--nt-text-3); }
.icons { display: flex; align-items: center; }
.icon-btn { width: 32px; height: 32px; border-radius: var(--nt-radius-md); display: grid; place-items: center; color: var(--nt-text-2); }
.icon-btn:hover { background: var(--nt-bg-2); }
.icon-btn svg { width: 20px; height: 20px; }

.item { display: flex; gap: 12px; align-items: flex-start; width: 100%; padding: 16px 24px; border-bottom: var(--nt-hair) solid var(--nt-line); }
button.item:hover { background: var(--nt-bg-3); }
.avatar { width: 32px; height: 32px; border-radius: 20px; flex: none; display: grid; place-items: center; background: var(--nt-bg-2); color: var(--nt-text-2); }
.avatar svg { width: 16px; height: 16px; }
.content { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; white-space: nowrap; }
.who { display: flex; align-items: center; gap: 8px; min-width: 0; }
.title { font-size: var(--nt-sm); line-height: var(--nt-sm-lh); font-weight: var(--nt-semibold); overflow: hidden; text-overflow: ellipsis; }
.tag, .when { font-size: var(--nt-xs); line-height: var(--nt-xs-lh); color: var(--nt-text-3); opacity: 0.75; overflow: hidden; text-overflow: ellipsis; }
.when { flex: none; }
.snippet { font-size: var(--nt-sm); line-height: var(--nt-sm-lh); color: var(--nt-text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

.footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; }
.count { font-size: var(--nt-xs); line-height: var(--nt-xs-lh); color: var(--nt-text-3); }
.link { display: inline-flex; align-items: center; gap: 4px; font-size: var(--nt-xs); line-height: var(--nt-xs-lh); color: var(--nt-info); text-decoration: none; }
.link:hover { text-decoration: underline; }
.link svg { width: 16px; height: 16px; }

.doc-head { padding: 16px 24px 12px; border-bottom: var(--nt-hair) solid var(--nt-line-3); }
.doc-title { margin: 0; font-size: var(--font-heading-md-size, 16px); line-height: var(--font-heading-md-line-height, 22.4px); font-weight: var(--nt-semibold); }
.meta { margin-top: 4px; font-size: var(--nt-xs); line-height: var(--nt-xs-lh); color: var(--nt-text-3); }
.body { padding: 12px 24px 16px; max-height: 440px; overflow: auto; font-size: var(--nt-sm); line-height: var(--nt-sm-lh); color: var(--nt-text-2); }
:root[data-mode="fullscreen"] .body { max-height: none; }
.b { margin: 0 0 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.b.h { color: var(--nt-text); font-weight: var(--nt-semibold); margin-top: 12px; }
.b.h1 { font-size: var(--font-heading-lg-size, 20px); line-height: var(--font-heading-lg-line-height, 25px); }
.b.h2 { font-size: var(--font-heading-md-size, 16px); line-height: var(--font-heading-md-line-height, 22.4px); }
.b.h3 { font-size: var(--nt-sm); }
.b.li { display: flex; gap: 8px; }
.b.li .mark { flex: none; min-width: 14px; color: var(--nt-text-3); }
.b.done .text { text-decoration: line-through; color: var(--nt-text-3); }
.b.quote { border-left: 2px solid var(--nt-line); padding-left: 12px; }
.b.code { font-family: var(--nt-mono); font-size: var(--nt-xs); line-height: var(--nt-xs-lh); background: var(--nt-bg-2); border-radius: var(--nt-radius-sm); padding: 8px 10px; overflow-x: auto; white-space: pre; }
.b.table { font-family: var(--nt-mono); font-size: var(--nt-xs); line-height: var(--nt-xs-lh); white-space: pre; overflow-x: auto; }
.b.divider { border: 0; border-top: var(--nt-hair) solid var(--nt-line); margin: 10px 0; }
.b.chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: var(--nt-hair) solid var(--nt-line-3); border-radius: 999px; font-size: var(--nt-xs); color: var(--nt-text-3); }
.more { font-size: var(--nt-xs); color: var(--nt-text-3); margin-top: 8px; }

.confirm { padding: 24px; display: flex; flex-direction: column; gap: 24px; }
.confirm-title { margin: 0; font-size: var(--font-heading-lg-size, 20px); line-height: var(--font-heading-lg-line-height, 25px); font-weight: var(--nt-semibold); overflow-wrap: anywhere; }
.panel { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px; border: var(--nt-hair) solid var(--nt-line); border-radius: 12px; }
.panel-who { display: flex; align-items: center; gap: 12px; min-width: 0; }
.panel .avatar { width: 40px; height: 40px; border-radius: 24px; }
.panel .avatar svg { width: 20px; height: 20px; }
.panel-text { display: flex; flex-direction: column; min-width: 0; }
.panel-name { font-size: var(--nt-sm); line-height: var(--nt-sm-lh); font-weight: var(--nt-semibold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel-sub { font-size: var(--nt-sm); line-height: var(--nt-sm-lh); color: var(--nt-text-3); opacity: 0.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.btn { flex: none; height: 36px; padding: 0 16px; border-radius: var(--nt-radius-md); display: inline-flex; align-items: center; font-size: var(--nt-sm); line-height: var(--nt-sm-lh); font-weight: var(--nt-semibold); white-space: nowrap; }
.btn.ink { background: var(--color-background-inverse, var(--nt-text)); color: var(--color-text-inverse, var(--nt-bg)); }
.btn.ink:hover { opacity: 0.88; }
.btn:disabled { opacity: 0.55; cursor: wait; }
.section { display: flex; flex-direction: column; gap: 16px; }
.section-label { font-size: var(--nt-sm); line-height: var(--nt-sm-lh); font-weight: var(--nt-semibold); }
.checks { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
.check { display: flex; gap: 8px; align-items: flex-start; font-size: var(--nt-sm); line-height: var(--nt-sm-lh); color: var(--nt-text-3); }
.check svg { flex: none; width: 20px; height: 20px; }
.check .what { color: var(--nt-text-2); }
.check .text { overflow-wrap: anywhere; }
.footer .link.quiet { color: var(--nt-text-3); }
.footer .link.quiet:hover { color: var(--nt-text); }
.note { padding: 20px 24px; font-size: var(--nt-sm); line-height: var(--nt-sm-lh); color: var(--nt-text-2); }
.note.warn { background: var(--nt-danger-bg); color: var(--nt-danger); }

.skeleton { padding: 8px 24px 16px; display: grid; gap: 12px; }
.skeleton .row { display: flex; gap: 12px; align-items: center; }
.skeleton .dot { width: 32px; height: 32px; border-radius: 20px; }
.skeleton .bar { height: 32px; border-radius: var(--nt-radius-md); flex: 1; }
.shimmer { background: linear-gradient(90deg, var(--nt-bg-2) 0%, var(--nt-bg-3) 50%, var(--nt-bg-2) 100%); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
@keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .shimmer { animation: none; } }
`;

const SCRIPT = String.raw`
(() => {
  const root = document.getElementById("root");
  const ICON = {
    page: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 1.75h5.2L12.25 4.8v9.45H4z"/><path d="M9 1.75V5h3.25"/><path d="M6 8h4M6 10.5h4"/></svg>',
    open: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4h5v5"/><path d="M16 4l-7 7"/><path d="M14 11.5V15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3.5"/></svg>',
    back: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5l-5 5 5 5"/></svg>',
    expand: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4h4v4M8 16H4v-4M16 4l-5 5M4 16l5-5"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
    // The kit's own Check glyph, filled with the list's text colour.
    folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.75 4.25h4.5l1.5 1.5h6.5v7.5H1.75z"/></svg>',
    check: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M15.1883 5.10908C15.3699 4.96398 15.6346 4.96153 15.8202 5.11592C16.0056 5.27067 16.0504 5.53125 15.9403 5.73605L15.8837 5.82003L8.38355 14.8202C8.29362 14.9279 8.16243 14.9925 8.02222 14.9989C7.88204 15.0051 7.74546 14.9526 7.64624 14.8534L4.14618 11.3533L4.08173 11.2752C3.95385 11.0811 3.97543 10.817 4.14618 10.6463C4.31694 10.4755 4.58106 10.4539 4.7751 10.5818L4.85323 10.6463L7.96558 13.7586L15.1161 5.1794L15.1883 5.10908Z" fill="currentColor"/></svg>',
  };
  const LOGO = ${JSON.stringify(LOGO)};

  let nextId = 1;
  const pending = new Map();
  let host = { capabilities: {}, displayModes: [], mode: "inline" };
  let listState = null;

  const send = (message) => window.parent.postMessage(message, "*");
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params: params || {} });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params: params || {} });
  });

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function relative(at) {
    const diff = Date.now() - at;
    const minute = 60000, hour = 60 * minute, day = 24 * hour;
    if (diff < minute) return "just now";
    if (diff < hour) return Math.floor(diff / minute) + "m ago";
    if (diff < day) return Math.floor(diff / hour) + "h ago";
    if (diff < 7 * day) return Math.floor(diff / day) + "d ago";
    const d = new Date(at);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  }

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
    const vars = ctx.styles && ctx.styles.variables;
    if (vars) for (const [name, value] of Object.entries(vars)) if (value) document.documentElement.style.setProperty(name, value);
    const fonts = ctx.styles && ctx.styles.css && ctx.styles.css.fonts;
    if (fonts && !document.getElementById("host-fonts")) {
      const style = document.createElement("style");
      style.id = "host-fonts";
      style.textContent = fonts;
      document.head.appendChild(style);
    }
    if (ctx.availableDisplayModes) host.displayModes = ctx.availableDisplayModes;
    if (ctx.displayMode) {
      host.mode = ctx.displayMode;
      document.documentElement.dataset.mode = ctx.displayMode;
    }
  }

  function openLink(url) {
    if (!url) return;
    request("ui/open-link", { url }).catch(() => window.open(url, "_blank", "noopener"));
  }

  function header({ crumb, back, url }) {
    const expand = host.displayModes.includes("fullscreen") && host.mode !== "fullscreen"
      ? '<button class="icon-btn" data-act="expand" aria-label="Expand" title="Expand">' + ICON.expand + "</button>"
      : "";
    return '<div class="header">' +
      '<div class="app">' +
        (back ? '<button class="icon-btn" data-act="back" aria-label="Back to documents" title="Back">' + ICON.back + "</button>" : "") +
        '<span class="logo">' + LOGO + '</span><span class="name">Nootles' + (crumb ? ' <span class="crumb">/ ' + esc(crumb) + "</span>" : "") + "</span>" +
      "</div>" +
      '<div class="icons">' + expand +
        (url ? '<button class="icon-btn" data-act="open" data-url="' + esc(url) + '" aria-label="Open in Nootles" title="Open in Nootles">' + ICON.open + "</button>" : "") +
      "</div></div>";
  }

  function footer(left, url, label) {
    return '<div class="footer"><span class="count">' + esc(left) + "</span>" +
      (url ? '<a class="link" href="#" data-act="open" data-url="' + esc(url) + '">' + esc(label) + ICON.arrow + "</a>" : "") + "</div>";
  }

  function renderLoading(label) {
    root.innerHTML = '<div class="card">' + header({ crumb: label }) +
      '<div class="skeleton" aria-busy="true" aria-label="Loading">' +
      [0, 1, 2, 3].map(() => '<div class="row"><div class="dot shimmer"></div><div class="bar shimmer"></div></div>').join("") +
      "</div></div>";
  }

  function renderNote(text, warn, crumb) {
    root.innerHTML = '<div class="card">' + header({ crumb, back: !!listState && crumb !== undefined }) +
      '<div class="note' + (warn ? " warn" : "") + '">' + esc(text) + "</div></div>";
  }

  function renderList(data) {
    listState = data;
    const rows = data.docs.map((d) =>
      '<button class="item" data-act="read" data-doc="' + esc(d.docId) + '" data-url="' + esc(d.url || "") + '" data-title="' + esc(d.title || "Untitled") + '">' +
        '<span class="avatar">' + ICON.page + "</span>" +
        '<span class="content">' +
          '<span class="top"><span class="who"><span class="title">' + esc(d.title || "Untitled") + '</span><span class="tag">' + esc(d.projectTitle || "") + "</span></span>" +
          '<span class="when" title="' + esc(new Date(d.updatedAt).toLocaleString()) + '">' + esc(relative(d.updatedAt)) + "</span></span>" +
          (d.snippet ? '<span class="snippet">' + esc(d.snippet) + "</span>" : "") +
        "</span></button>").join("");
    const empty = data.total === 0
      ? '<div class="note">' + (data.query ? "No served documents match “" + esc(data.query) + "”." : "No documents are served over MCP yet.") + "</div>"
      : "";
    const noun = data.total === 1 ? "document" : "documents";
    root.innerHTML = '<div class="card">' + header({ url: data.appUrl }) + empty + rows +
      footer(data.total ? "Showing " + data.docs.length + " of " + data.total + " " + noun : "", data.appUrl, "Open Nootles") + "</div>";
  }

  function blockHtml(b, counters) {
    const pad = b.depth ? ' style="margin-left:' + (b.depth * 20) + 'px"' : "";
    const text = esc(b.text);
    if (b.type !== "numberedListItem") counters[b.depth] = 0;
    switch (b.type) {
      case "heading":
        return '<p class="b h h' + Math.min(3, b.level || 1) + '"' + pad + ">" + text + "</p>";
      case "bulletListItem":
      case "toggleListItem":
        return '<p class="b li"' + pad + '><span class="mark">' + (b.type === "toggleListItem" ? "▸" : "•") + '</span><span class="text">' + text + "</span></p>";
      case "numberedListItem":
        counters[b.depth] = (counters[b.depth] || 0) + 1;
        return '<p class="b li"' + pad + '><span class="mark">' + counters[b.depth] + '.</span><span class="text">' + text + "</span></p>";
      case "checkListItem":
        return '<p class="b li' + (b.checked ? " done" : "") + '"' + pad + '><span class="mark">' + (b.checked ? "☑" : "☐") + '</span><span class="text">' + text + "</span></p>";
      case "quote":
        return '<p class="b quote"' + pad + ">" + text + "</p>";
      case "codeBlock":
        return '<pre class="b code"' + pad + ">" + text + "</pre>";
      case "mathBlock":
        return '<pre class="b code"' + pad + ">" + text + "</pre>";
      case "table":
        return '<pre class="b table"' + pad + ">" + text + "</pre>";
      case "divider":
        return '<hr class="b divider">';
      case "paragraph":
        return text ? '<p class="b"' + pad + ">" + text + "</p>" : "";
      default: {
        const label = { image: "Image", video: "Video", audio: "Audio", file: "File" }[b.type];
        const chip = label ? label + (b.text ? " · " + b.text : "") : b.text || b.type;
        return '<p class="b"' + pad + '><span class="b chip">' + esc(chip) + "</span></p>";
      }
    }
  }

  function renderDoc(data) {
    const d = data.doc;
    const counters = [];
    // The card's head already shows the title; a first heading repeating it is dropped.
    const blocks = data.outline.blocks.filter((b, i) => !(i === 0 && b.type === "heading" && b.text.trim().toLowerCase() === (d.title || "").trim().toLowerCase()));
    const body = blocks.map((b) => blockHtml(b, counters)).join("");
    const more = data.outline.truncated ? '<p class="more">' + (data.outline.total - data.outline.blocks.length) + " more blocks — open the page to see the rest.</p>" : "";
    const meta = [d.projectTitle || "Untitled project", "edited " + relative(d.updatedAt), data.blockCount + (data.blockCount === 1 ? " block" : " blocks")].join(" · ");
    root.innerHTML = '<div class="card">' + header({ crumb: listState ? d.title || "Untitled" : undefined, back: !!listState, url: d.url }) +
      '<div class="doc-head"><h1 class="doc-title">' + esc(d.title || "Untitled") + '</h1><div class="meta">' + esc(meta) + "</div></div>" +
      '<div class="body">' + (body || '<p class="b" style="color:var(--nt-text-3)">This page is empty.</p>') + more + "</div>" +
      footer("Read-only · live from Nootles", d.url, "Open in Nootles") + "</div>";
  }

  const VERB = { added: "Added", changed: "Changed", removed: "Removed", moved: "Moved" };
  const TYPE = {
    paragraph: "paragraph", heading: "heading", bulletListItem: "bullet", numberedListItem: "numbered item", checkListItem: "to-do",
    toggleListItem: "toggle", quote: "quote", codeBlock: "code", mathBlock: "math", table: "table", divider: "divider",
    image: "image", video: "video", audio: "audio", file: "file",
  };

  function panel(d, sub) {
    return '<div class="panel"><div class="panel-who"><span class="avatar">' + ICON.page + '</span><span class="panel-text">' +
      '<span class="panel-name">' + esc(d.title || "Untitled") + '</span><span class="panel-sub">' + esc(sub) + "</span></span></div>" +
      (d.url ? '<button class="btn ink" data-act="open" data-url="' + esc(d.url) + '">Open in Nootles</button>' : "") + "</div>";
  }

  function renderEdit(data) {
    const d = data.doc;
    if (data.replayed) {
      root.innerHTML = '<div class="card">' + header({ crumb: d.title || "Untitled", url: d.url }) +
        '<div class="note">That edit was already made; nothing new was changed.</div></div>';
      return;
    }
    const n = data.changes.length;
    const rows = data.changes.map((c) =>
      '<li class="check" data-id="' + esc(c.id) + '">' + ICON.check + '<span class="text"><span class="what">' + esc(VERB[c.kind] || c.kind) + " " +
        esc(TYPE[c.type] || c.type) + "</span>" + (c.text ? " · " + esc(c.text) : "") + "</span></li>").join("");
    const undo = host.capabilities.serverTools
      ? '<a class="link quiet" href="#" data-act="undo" data-edit="' + esc(data.editId) + '">Undo this edit</a>'
      : "";
    root.innerHTML = '<div class="card">' + header({ url: d.url }) +
      '<div class="confirm"><h1 class="confirm-title">Edited ' + esc(d.title || "Untitled") + "</h1>" +
        panel(d, (d.projectTitle || "Untitled project") + " · " + n + (n === 1 ? " change" : " changes")) +
        '<div class="section"><div class="section-label">Changes</div><ul class="checks">' + rows + "</ul></div></div>" +
      '<div class="footer"><span class="count">Live on the page · undoable for 7 days</span>' + undo + "</div></div>";
  }

  function renderUndo(data) {
    const d = data.doc;
    root.innerHTML = '<div class="card">' + header({ url: d.url }) +
      '<div class="confirm"><h1 class="confirm-title">Undid the edit</h1>' +
        panel(d, "Back to how it was before that edit") + "</div></div>";
  }

  function renderProjects(data) {
    const rows = data.projects.map((p) =>
      '<div class="item">' +
        '<span class="avatar">' + ICON.folder + "</span>" +
        '<span class="content">' +
          '<span class="top"><span class="who"><span class="title">' + esc(p.title || "Untitled") + "</span>" +
          '<span class="tag">' + esc(p.pages + (p.pages === 1 ? " page" : " pages")) + "</span></span>" +
          '<span class="when">' + esc(relative(p.updatedAt)) + "</span></span>" +
          (p.description ? '<span class="snippet">' + esc(p.description) + "</span>" : "") +
        "</span></div>").join("");
    const empty = data.projects.length ? "" : '<div class="note">No personal projects yet.</div>';
    root.innerHTML = '<div class="card">' + header({ crumb: "Projects", url: data.appUrl }) + empty + rows +
      footer(data.projects.length + (data.projects.length === 1 ? " project" : " projects"), data.appUrl, "Open Nootles") + "</div>";
  }

  function renderSearch(data) {
    const rows = data.hits.map((h) =>
      '<button class="item" data-act="read" data-doc="' + esc(h.docId) + '" data-focus="' + esc((h.matches[0] || {}).blockId || "") +
        '" data-url="' + esc(h.url || "") + '" data-title="' + esc(h.title || "Untitled") + '">' +
        '<span class="avatar">' + ICON.page + "</span>" +
        '<span class="content">' +
          '<span class="top"><span class="who"><span class="title">' + esc(h.title || "Untitled") + '</span><span class="tag">' + esc(h.projectTitle || "") + "</span></span></span>" +
          h.matches.map((m) => '<span class="snippet">' + esc(m.text) + "</span>").join("") +
        "</span></button>").join("");
    const empty = data.hits.length ? "" : '<div class="note">Nothing matches “' + esc(data.query) + "”.</div>";
    const partial = data.scanned < data.total ? " · searched " + data.scanned + " of " + data.total : "";
    root.innerHTML = '<div class="card">' + header({ crumb: "“" + data.query + "”", url: data.appUrl }) + empty + rows +
      footer(data.hits.length + (data.hits.length === 1 ? " page" : " pages") + partial, data.appUrl, "Open Nootles") + "</div>";
  }

  function renderDone(title, d, sub, changes) {
    const rows = (changes || []).map((c) =>
      '<li class="check">' + ICON.check + '<span class="text"><span class="what">' + esc(VERB[c.kind] || c.kind) + " " +
        esc(TYPE[c.type] || c.type) + "</span>" + (c.text ? " · " + esc(c.text) : "") + "</span></li>").join("");
    root.innerHTML = '<div class="card">' + header({ url: d.url }) +
      '<div class="confirm"><h1 class="confirm-title">' + esc(title) + "</h1>" + panel(d, sub) +
      (rows ? '<div class="section"><div class="section-label">Written</div><ul class="checks">' + rows + "</ul></div>" : "") +
      "</div></div>";
  }

  function renderCreated(data) {
    const d = data.doc;
    if (data.what === "project") renderDone("Created " + (d.projectTitle || "a project"), { ...d, title: d.title || "Untitled" }, (d.projectTitle || "") + " · first page", data.changes);
    else renderDone("Created " + (d.title || "a page"), { ...d, title: d.title || "Untitled" }, (d.projectTitle || "") + " · new page", data.changes);
  }

  async function undoFromCard(el) {
    el.textContent = "Undoing…";
    el.setAttribute("aria-disabled", "true");
    try {
      renderResult(await request("tools/call", { name: "undo_edit", arguments: { edit_id: el.dataset.edit } }));
    } catch {
      el.textContent = "Undo this edit";
      el.removeAttribute("aria-disabled");
    }
  }

  function renderResult(result) {
    const data = result && result.structuredContent;
    if (result && result.isError) {
      const text = (result.content || []).map((c) => c.text || "").join(" ");
      renderNote(text || "That did not work.", true, listState ? "" : undefined);
      return;
    }
    if (data && data.kind === "docList") renderList(data);
    else if (data && data.kind === "doc") renderDoc(data);
    else if (data && data.kind === "edit") renderEdit(data);
    else if (data && data.kind === "undo") renderUndo(data);
    else if (data && data.kind === "projectList") renderProjects(data);
    else if (data && data.kind === "search") renderSearch(data);
    else if (data && data.kind === "created") renderCreated(data);
    else if (data && data.kind === "renamed") renderDone("Renamed " + (data.target === "project" ? "project" : "page"), data.doc, "Was “" + (data.from || "Untitled") + "”");
    else if (data && data.kind === "trashed") renderDone("Moved to Trash", data.doc, (data.doc.projectTitle || "") + " · restore it from Nootles’ Trash");
    else renderNote("Nothing to show.", false);
  }

  async function readFromList(el) {
    const docId = el.dataset.doc;
    if (!host.capabilities.serverTools) return openLink(el.dataset.url);
    renderLoading(el.dataset.title);
    try {
      const focus = el.dataset.focus;
      renderResult(await request("tools/call", { name: "read_doc", arguments: focus ? { doc: docId, focus_block_id: focus } : { doc: docId } }));
    } catch {
      if (listState) renderList(listState);
      openLink(el.dataset.url);
    }
  }

  root.addEventListener("click", (event) => {
    const el = event.target.closest("[data-act]");
    if (!el) return;
    event.preventDefault();
    const act = el.dataset.act;
    if (act === "open") openLink(el.dataset.url);
    else if (act === "read") readFromList(el);
    else if (act === "undo" && !el.hasAttribute("aria-disabled")) undoFromCard(el);
    else if (act === "back" && listState) renderList(listState);
    else if (act === "expand") request("ui/request-display-mode", { mode: "fullscreen" }).then((r) => applyContext({ displayMode: r && r.mode })).catch(() => {});
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error); else resolve(msg.result);
      return;
    }
    switch (msg.method) {
      case "ui/notifications/tool-input": {
        const args = (msg.params && msg.params.arguments) || {};
        renderLoading(args.operations && !args.project ? "Editing…" : args.edit_id ? "Undoing…" : args.project || args.title ? "Working…" : args.query ? "Searching…" : args.doc ? "Reading…" : "Documents");
        break;
      }
      case "ui/notifications/tool-result":
        renderResult(msg.params);
        break;
      case "ui/notifications/tool-cancelled":
        renderNote("Cancelled.", false);
        break;
      case "ui/notifications/host-context-changed":
        applyContext(msg.params);
        if (listState && !root.querySelector(".doc-head")) renderList(listState);
        break;
      case "ui/resource-teardown":
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
        break;
      case "ping":
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
        break;
    }
  });

  let lastHeight = 0;
  new ResizeObserver(() => {
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    notify("ui/notifications/size-changed", { width: Math.ceil(document.documentElement.getBoundingClientRect().width), height });
  }).observe(document.documentElement);

  renderLoading();
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    capabilities: {},
    clientInfo: { name: "nootles-documents", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  }).then((result) => {
    host.capabilities = (result && result.hostCapabilities) || {};
    applyContext(result && result.hostContext);
    notify("ui/notifications/initialized");
  }).catch(() => notify("ui/notifications/initialized"));
})();
`;

export const MCP_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nootles</title>
<style>${STYLE}</style>
</head>
<body>
<div id="root"></div>
<script>${SCRIPT}</script>
</body>
</html>`;
