import type * as vscode from "vscode";
import type { ConversionProvider } from "./conversionProvider";

export interface RuntimeCapabilities {
  readonly deployment: "desktop" | "web";
  readonly canLoadNativeConverter: boolean;
  readonly canRunExecutableFallback: boolean;
  readonly canUseHostedBackend: boolean;
  readonly defaultBackendUrl?: string;
}

export interface RuntimeServices {
  readonly capabilities: RuntimeCapabilities;
  createConversionProvider(): Promise<ConversionProvider>;
  asWebviewUri(uri: vscode.Uri): vscode.Uri;
}
