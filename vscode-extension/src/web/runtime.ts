import * as vscode from "vscode";
import { HostedBackendProvider, type WebSocketConstructor } from "../shared/hostedProvider";
import type { RuntimeServices } from "../shared/runtime";

export async function createRuntimeServices(context: vscode.ExtensionContext): Promise<RuntimeServices> {
  return {
    capabilities: {
      deployment: "web",
      canLoadNativeConverter: false,
      canRunExecutableFallback: false,
      canUseHostedBackend: true,
      canMountLocalFolder:
        typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function",
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
