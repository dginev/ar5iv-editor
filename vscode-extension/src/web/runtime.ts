import * as vscode from "vscode";
import { HostedBackendProvider, type WebSocketConstructor } from "../shared/hostedProvider";
import type { RuntimeServices } from "../shared/runtime";

/** Whether folder mounting (VS Code's File System Access–backed Open Folder)
 *  is available. The real mount runs in the workbench's main window, but this
 *  web extension runs in the Worker Extension Host — and `showDirectoryPicker`
 *  is a Window-only method, so probing for it here returns `undefined` on
 *  EVERY browser (Chrome included). Instead detect a Chromium engine, which is
 *  the actual requirement: `navigator.userAgentData` is Chromium-only and is
 *  exposed on `WorkerNavigator` in secure contexts (latexml.rs is HTTPS).
 *  Fallbacks cover a Window context and engines without UA Client Hints. */
function isChromiumBased(): boolean {
  if (typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function") {
    return true;
  }
  const nav = (globalThis as { navigator?: { userAgentData?: unknown; userAgent?: string } }).navigator;
  if (!nav) return false;
  if (nav.userAgentData) return true;
  return /Chrome|Chromium|CriOS/.test(nav.userAgent ?? "");
}

export async function createRuntimeServices(context: vscode.ExtensionContext): Promise<RuntimeServices> {
  return {
    capabilities: {
      deployment: "web",
      canLoadNativeConverter: false,
      canRunExecutableFallback: false,
      canUseHostedBackend: true,
      canMountLocalFolder: isChromiumBased(),
      defaultBackendUrl: "https://latexml.rs",
    },
    createConversionProvider: async () => {
      const backendUrl = vscode.workspace.getConfiguration("ar5iv").get<string>("backendUrl", "https://latexml.rs");
      return new HostedBackendProvider({
        backendUrl,
        webSocket: WebSocket as unknown as WebSocketConstructor,
        // Hosted showcase only: the webview extension-host worker runs on a
        // per-webview subdomain and calls the apex backend cross-origin, so it
        // must send the Anubis clearance cookie to clear the bot-wall. (Desktop
        // leaves this unset — local managed server, no Anubis.)
        credentials: "include",
        getUserId: async () => context.globalState.get<string>("ar5iv.userId"),
        setUserId: async (value) => {
          await context.globalState.update("ar5iv.userId", value);
        },
      });
    },
    asWebviewUri: (uri) => uri,
  };
}
