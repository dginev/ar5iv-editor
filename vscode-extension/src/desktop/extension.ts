import type * as vscode from "vscode";
import { activateAr5ivExtension } from "../shared/app";
import { createRuntimeServices } from "./runtime";

export async function activate(context: vscode.ExtensionContext): Promise<{ dispose(): void }> {
  const runtime = await createRuntimeServices(context);
  return activateAr5ivExtension(context, runtime);
}

export function deactivate(): void {}
