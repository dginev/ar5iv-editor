import * as os from "os";
import * as vscode from "vscode";
import WebSocket from "ws";
import { HostedBackendProvider, type WebSocketConstructor } from "../shared/hostedProvider";
import type { RuntimeServices } from "../shared/runtime";
import type { ConversionProvider } from "../shared/conversionProvider";
import { ConversionUnavailableError } from "../shared/conversionProvider";
import { createExecutableProvider } from "./executableProvider";
import { ManagedAr5ivServer } from "./managedServer";
import { createNativeProvider } from "./nativeProvider";

type RequestedMode = "auto" | "native" | "executable" | "backend";

export async function createRuntimeServices(context: vscode.ExtensionContext): Promise<RuntimeServices> {
  const serverOutput = vscode.window.createOutputChannel("ar5iv Server");
  const managedServer = new ManagedAr5ivServer(context, serverOutput);
  context.subscriptions.push({ dispose: () => void managedServer.dispose() });
  context.subscriptions.push(serverOutput);

  return {
    capabilities: {
      deployment: "desktop",
      canLoadNativeConverter: os.platform() === "linux",
      canRunExecutableFallback: os.platform() === "linux",
      canUseHostedBackend: true,
      defaultBackendUrl: "https://latexml.rs",
    },
    createConversionProvider: () => createProvider(context, managedServer),
    asWebviewUri: (uri) => uri,
  };
}

async function createProvider(
  context: vscode.ExtensionContext,
  managedServer: ManagedAr5ivServer,
): Promise<ConversionProvider> {
  const config = vscode.workspace.getConfiguration("ar5iv");
  const requested = config.get<RequestedMode>("conversionMode", "auto");
  const attempts: string[] = [];

  const tryProvider = async (mode: RequestedMode): Promise<ConversionProvider | undefined> => {
    try {
      switch (mode) {
        case "native":
          if (config.get<boolean>("disableNativeLatexmlOxide", false)) {
            throw new ConversionUnavailableError("native", "Native provider is disabled by configuration.");
          }
          if (os.platform() !== "linux") {
            throw new ConversionUnavailableError("native", "Native provider MVP supports Ubuntu/Linux only.");
          }
          return await createNativeProvider(context);
        case "executable":
          if (os.platform() !== "linux") {
            throw new ConversionUnavailableError("executable", "Executable fallback MVP supports Ubuntu/Linux only.");
          }
          return await createExecutableProvider(context);
        case "backend":
          return await createHostedProvider(context, managedServer);
        case "auto":
          return undefined;
      }
    } catch (error) {
      attempts.push(error instanceof Error ? error.message : String(error));
      if (requested !== "auto") throw error;
      return undefined;
    }
  };

  if (requested !== "auto") {
    const provider = await tryProvider(requested);
    if (provider) return provider;
  }

  for (const mode of ["backend", "native", "executable"] as const) {
    const provider = await tryProvider(mode);
    if (provider) return provider;
  }

  throw new ConversionUnavailableError(
    "backend",
    `No ar5iv conversion provider is available.\n${attempts.join("\n")}`,
  );
}

async function createHostedProvider(
  context: vscode.ExtensionContext,
  managedServer: ManagedAr5ivServer,
): Promise<ConversionProvider> {
  const config = vscode.workspace.getConfiguration("ar5iv");
  const useManagedServer = config.get<boolean>("managedServer.enabled", true);
  const backendUrl = useManagedServer
    ? await managedServer.start()
    : config.get<string>("backendUrl", "https://latexml.rs");
  return new HostedBackendProvider({
    backendUrl,
    webSocket: WebSocket as unknown as WebSocketConstructor,
    getUserId: async () => context.globalState.get<string>("ar5iv.userId"),
    setUserId: async (value) => {
      await context.globalState.update("ar5iv.userId", value);
    },
  });
}
