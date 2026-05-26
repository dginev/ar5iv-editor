import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { ConversionProvider, ConversionSession } from "../shared/conversionProvider";
import { ConversionUnavailableError } from "../shared/conversionProvider";
import type {
  NormalizedConvertRequest,
  NormalizedConvertResponse,
  ProjectHandle,
} from "../shared/conversionTypes";
import { fatalResponse } from "../shared/conversionTypes";

export async function createExecutableProvider(): Promise<ConversionProvider> {
  const executable = await resolveExecutablePath();
  if (!executable) {
    throw new ConversionUnavailableError(
      "executable",
      "No latexml-oxide executable fallback is configured or discoverable on PATH.",
    );
  }
  return new ExecutableFallbackProvider(executable);
}

class ExecutableFallbackProvider implements ConversionProvider {
  readonly mode = "executable" as const;

  constructor(private readonly executable: string) {}

  async openProject(_project: ProjectHandle): Promise<ConversionSession> {
    return new ExecutableFallbackSession(this.executable);
  }

  async dispose(): Promise<void> {}
}

class ExecutableFallbackSession implements ConversionSession {
  constructor(private readonly executable: string) {}

  async convert(request: NormalizedConvertRequest): Promise<NormalizedConvertResponse> {
    return fatalResponse(
      request,
      [
        `Executable fallback resolved to ${this.executable}, but the structured CLI conversion contract is not implemented yet.`,
        "Use ar5iv.conversionMode=backend for hosted testing or configure a native provider module.",
      ].join("\n"),
    );
  }

  async dispose(): Promise<void> {}
}

async function resolveExecutablePath(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration("ar5iv").get<string>("latexmlOxidePath", "").trim();
  if (configured) {
    await assertExecutable(configured);
    return configured;
  }

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "latexml_oxide");
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function assertExecutable(file: string): Promise<void> {
  if (!(await isExecutable(file))) {
    throw new ConversionUnavailableError("executable", `${file} is not executable or does not exist.`);
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
