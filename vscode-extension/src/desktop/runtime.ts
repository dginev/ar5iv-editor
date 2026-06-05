import * as os from "os";
import * as vscode from "vscode";
import WebSocket from "ws";
import { HostedBackendProvider, type WebSocketConstructor } from "../shared/hostedProvider";
import type { RuntimeServices } from "../shared/runtime";
import type { ConversionProvider } from "../shared/conversionProvider";
import { ConversionUnavailableError } from "../shared/conversionProvider";
import { createExecutableProvider } from "./executableProvider";

/// Single-engine architecture: the desktop extension converts through the
/// BUNDLED `latexml_oxide --server` LSP (warm-fork preamble cache,
/// multi-file project root + unsaved-buffer overlay, per-file diagnostics).
/// The only other lane is the hosted backend URL — kept strictly as the
/// fallback for platforms the engine doesn't run on (latexml-oxide builds
/// and is tested on Ubuntu only) and as a debug escape hatch. The previous
/// managed-local-server and native-module lanes are gone: the managed
/// server duplicated the engine behind a second download pin (stale-version
/// trap), and the in-process native module had no process isolation,
/// watchdogs, or preemption.
type RequestedMode = "auto" | "executable" | "backend";

export async function createRuntimeServices(context: vscode.ExtensionContext): Promise<RuntimeServices> {
  return {
    capabilities: {
      deployment: "desktop",
      canLoadNativeConverter: false,
      canRunExecutableFallback: os.platform() === "linux",
      canUseHostedBackend: true,
      canMountLocalFolder: true, // native Open Folder
      defaultBackendUrl: "https://latexml.rs",
    },
    createConversionProvider: () => createProvider(context),
    asWebviewUri: (uri) => uri,
  };
}

async function createProvider(context: vscode.ExtensionContext): Promise<ConversionProvider> {
  const config = vscode.workspace.getConfiguration("ar5iv");
  const requested = config.get<RequestedMode>("conversionMode", "auto");
  const attempts: string[] = [];

  const tryProvider = async (mode: RequestedMode): Promise<ConversionProvider | undefined> => {
    try {
      switch (mode) {
        case "executable":
          if (os.platform() !== "linux") {
            throw new ConversionUnavailableError(
              "executable",
              "The latexml-oxide engine supports Ubuntu/Linux only.",
            );
          }
          return await createExecutableProvider(context);
        case "backend":
          return await createHostedProvider(context);
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

  // Turnkey default: the bundled LSP engine; hosted backend only when the
  // engine cannot run here. TODO(remote multi-file): the hosted lane speaks
  // the single-buffer editor WS protocol today — for full project fidelity
  // on engine-less platforms, grow a zip-to-zip `latexml.rs/convert`-style
  // exchange (cortex_worker's archive model: ship the project, get the
  // converted bundle back).
  for (const mode of ["executable", "backend"] as const) {
    const provider = await tryProvider(mode);
    if (provider) return provider;
  }

  throw new ConversionUnavailableError(
    "backend",
    `No ar5iv conversion provider is available.\n${attempts.join("\n")}`,
  );
}

async function createHostedProvider(context: vscode.ExtensionContext): Promise<ConversionProvider> {
  const config = vscode.workspace.getConfiguration("ar5iv");
  const backendUrl = config.get<string>("backendUrl", "https://latexml.rs");
  return new HostedBackendProvider({
    backendUrl,
    webSocket: WebSocket as unknown as WebSocketConstructor,
    getUserId: async () => context.globalState.get<string>("ar5iv.userId"),
    setUserId: async (value) => {
      await context.globalState.update("ar5iv.userId", value);
    },
  });
}
