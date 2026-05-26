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
      defaultBackendUrl: "https://latexml.rs",
    },
    createConversionProvider: async () => {
      const backendUrl = vscode.workspace.getConfiguration("ar5iv").get<string>("backendUrl", "https://latexml.rs");
      return new HostedBackendProvider({
        backendUrl,
        webSocket: WebSocket as unknown as WebSocketConstructor,
        getUserId: async () => context.globalState.get<string>("ar5iv.userId"),
        setUserId: async (value) => {
          await context.globalState.update("ar5iv.userId", value);
        },
      });
    },
    asWebviewUri: (uri) => uri,
  };
}
