import { createRoot } from "react-dom/client";
import { ConvexClientProvider } from "../app/ConvexClientProvider";
import { NotionConfigProvider } from "../app/components/notion/NotionAvailable";
import { StandInProvider } from "../app/components/StandIn";
import { Authed } from "../app/components/Authed";
import { Consent } from "../app/components/mcp/Consent";
import { Settings } from "../app/components/settings/Settings";

/**
 * The in-browser half of mcp.fullstack.mjs.
 *
 * `/mcp/authorize` and `/settings` are the app's real pages — the consent a
 * person answers when an agent signs in, and the Agents section that lists and
 * ends connections — under the real providers, talking to the real backend.
 *
 * `/host` is not the app: it stands in for Claude, the MCP Apps host. It frames
 * the app HTML the server served (`resources/read`) in a sandboxed iframe with
 * no same-origin access, as a host does, and speaks the host's half of the
 * protocol (SEP-1865): answers `ui/initialize` with a theme and the standard
 * style variables, delivers the tool input and result, proxies the app's own
 * `tools/call` to the real MCP client in the runner, and records links and
 * size reports for the runner to read.
 */

type Json = Record<string, unknown>;
declare global {
  interface Window {
    __mcpHost: {
      html: string;
      theme: "light" | "dark";
      input: Json;
      result: Json;
      variables: Record<string, string>;
    };
    __mcpCall: (name: string, args: Json) => Promise<Json>;
    __hostLog: { opened: string[]; sizes: Array<{ width?: number; height: number }>; modes: string[]; calls: string[]; initialized: boolean };
    __hostTheme: (theme: "light" | "dark") => void;
  }
}

function mountHost() {
  const cfg = window.__mcpHost;
  const log: Window["__hostLog"] = { opened: [], sizes: [], modes: [], calls: [], initialized: false };
  window.__hostLog = log;
  document.body.style.cssText = `margin:0;padding:24px;background:${cfg.theme === "dark" ? "#262624" : "#f5f4ed"};`;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "display:block;width:720px;height:200px;border:0;";
  frame.srcdoc = cfg.html;
  document.body.appendChild(frame);

  const post = (message: Json) => frame.contentWindow!.postMessage(message, "*");
  const hostContext = (theme: "light" | "dark") => ({
    theme,
    styles: { variables: cfg.variables },
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: { width: 720, maxHeight: 640 },
    locale: "en-US",
    platform: "web",
  });
  window.__hostTheme = (theme) => {
    document.body.style.background = theme === "dark" ? "#262624" : "#f5f4ed";
    post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme } });
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== frame.contentWindow) return;
    const msg = event.data as { jsonrpc?: string; id?: number; method?: string; params?: Json };
    if (msg?.jsonrpc !== "2.0" || !msg.method) return;
    const reply = (result: unknown) => post({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "ui/initialize":
        reply({
          protocolVersion: "2026-01-26",
          hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {} },
          hostInfo: { name: "e2e-host", version: "1.0.0" },
          hostContext: hostContext(cfg.theme),
        });
        break;
      case "ui/notifications/initialized":
        log.initialized = true;
        post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: cfg.input } });
        setTimeout(() => post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: cfg.result }), 150);
        break;
      case "ui/notifications/size-changed": {
        const height = Number(msg.params?.height);
        log.sizes.push({ width: Number(msg.params?.width), height });
        frame.style.height = `${height}px`;
        break;
      }
      case "ui/open-link":
        log.opened.push(String(msg.params?.url));
        reply({});
        break;
      case "ui/request-display-mode":
        log.modes.push(String(msg.params?.mode));
        reply({ mode: msg.params?.mode });
        break;
      case "tools/call": {
        const name = String(msg.params?.name);
        log.calls.push(name);
        try {
          reply(await window.__mcpCall(name, (msg.params?.arguments ?? {}) as Json));
        } catch (error) {
          post({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(error) } });
        }
        break;
      }
    }
  });
}

function Page() {
  const { pathname, search } = window.location;
  if (pathname === "/mcp/authorize") {
    return (
      <Authed>
        <Consent request={new URLSearchParams(search).get("request")} />
      </Authed>
    );
  }
  if (pathname === "/settings") {
    return (
      <Authed>
        <Settings />
      </Authed>
    );
  }
  return <p>Nothing here.</p>;
}

if (window.location.pathname === "/host") {
  mountHost();
} else {
  createRoot(document.getElementById("app")!).render(
    <ConvexClientProvider>
      <NotionConfigProvider oauth={false}>
        <StandInProvider>
          <Page />
        </StandInProvider>
      </NotionConfigProvider>
    </ConvexClientProvider>,
  );
}
