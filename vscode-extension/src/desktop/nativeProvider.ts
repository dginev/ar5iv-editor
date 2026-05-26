import { createRequire } from "module";
import * as path from "path";
import * as vscode from "vscode";
import type { ConversionProvider } from "../shared/conversionProvider";
import { ConversionUnavailableError } from "../shared/conversionProvider";

interface NativeModule {
  createConversionProvider?(): ConversionProvider | Promise<ConversionProvider>;
}

export async function createNativeProvider(context: vscode.ExtensionContext): Promise<ConversionProvider> {
  const configured = vscode.workspace
    .getConfiguration("ar5iv")
    .get<string>("nativeLatexmlOxidePath", "")
    .trim();
  const candidates = [
    configured || undefined,
    path.join(context.extensionPath, "dist", "native", "latexml_oxide.node"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const mod = loadNativeModule(candidate);
      if (typeof mod.createConversionProvider !== "function") {
        throw new Error("module does not export createConversionProvider()");
      }
      return await mod.createConversionProvider();
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new ConversionUnavailableError(
    "native",
    `No usable native latexml-oxide provider found. Tried:\n${errors.join("\n")}`,
  );
}

const requireNative = createRequire(__filename);

function loadNativeModule(modulePath: string): NativeModule {
  return requireNative(modulePath) as NativeModule;
}
