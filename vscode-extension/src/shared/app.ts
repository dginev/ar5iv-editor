import * as vscode from "vscode";
import type { RuntimeServices } from "./runtime";
import type { ConversionProvider, ConversionSession } from "./conversionProvider";
import { ConversionUnavailableError } from "./conversionProvider";
import { buildConvertRequest, isLatexDocument, workspaceRootFor } from "./documentModel";
import { DiagnosticPublisher } from "./diagnostics";
import { Debouncer } from "./debounce";
import { PreviewPanel } from "./previewPanel";
import { revealSource } from "./sourceSync";
import type { NormalizedConvertRequest } from "./conversionTypes";

// Sample document for the hosted `/vscode` web demo's startup layout.
const DEMO_SAMPLE = `\\documentclass{article}
\\title{ar5iv in VS Code}
\\author{powered by latexml-oxide}
\\begin{document}
\\maketitle

\\section{Live preview}
This document is rendered by \\texttt{latexml-oxide} — the same conversion
and preview core as the web editor at \\texttt{/editor}. Edit the source on
the left and the preview on the right updates as you type.

\\section{Mathematics}
Inline math like $e^{i\\pi} + 1 = 0$ renders with MathML, and so do displays:
\\begin{equation}
  \\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}.
\\end{equation}

Double-click any rendered text to jump back to its source line.
\\end{document}
`;

export async function activateAr5ivExtension(
  context: vscode.ExtensionContext,
  runtime: RuntimeServices,
): Promise<{ dispose(): void }> {
  const app = new Ar5ivExtensionApp(context, runtime);
  app.activate();
  return app;
}

class Ar5ivExtensionApp {
  private provider: ConversionProvider | undefined;
  private session: ConversionSession | undefined;
  private sessionRoot: string | undefined;
  private activeDocument: vscode.TextDocument | undefined;
  private lastCursor: vscode.Position | undefined;
  private requestSeq = 0;
  private latestAcceptedRevision = -1;
  private readonly preview: PreviewPanel;
  private readonly diagnostics = new DiagnosticPublisher();
  private readonly output = vscode.window.createOutputChannel("ar5iv Preview");
  private readonly debouncer = new Debouncer(() => readDebounceMs());
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: RuntimeServices,
  ) {
    this.preview = new PreviewPanel(context, {
      onRevealSource: (payload) => void revealSource(payload),
      onRefresh: () => void this.convertNow(this.lastCursor),
    });
  }

  activate(): void {
    this.disposables.push(
      vscode.commands.registerCommand("ar5iv.openPreview", () => this.openPreview()),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDidChangeTextDocument(event)),
      vscode.workspace.onDidCloseTextDocument((document) => this.onDidCloseDocument(document)),
    );
    this.context.subscriptions.push(this);
    this.context.subscriptions.push(...this.disposables);
    void this.maybeOpenDemoSample();
  }

  /** For the hosted `/vscode` web demo (gated by `ar5iv.demoSampleOnStartup`):
   *  open a sample LaTeX document with the preview beside it, so the showcase
   *  lands on a two-column editor + live preview layout. No-op for normal use
   *  (default off) and when an editor is already open. */
  private async maybeOpenDemoSample(): Promise<void> {
    if (!vscode.workspace.getConfiguration("ar5iv").get<boolean>("demoSampleOnStartup", false)) return;
    if (vscode.window.visibleTextEditors.some((editor) => isLatexDocument(editor.document))) return;
    try {
      const document = await vscode.workspace.openTextDocument({ language: "latex", content: DEMO_SAMPLE });
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
      await this.openPreview();
      // Collapse the Explorer/side bar so the showcase opens on just the
      // source + preview columns. (Side-bar visibility is UI state, not a
      // setting, so there's no config key for it.)
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
    } catch (error) {
      this.output.appendLine(`demo sample failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async openPreview(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isLatexDocument(editor.document)) {
      await vscode.window.showWarningMessage("Open a LaTeX document before running ar5iv: Open Preview.");
      return;
    }
    this.activeDocument = editor.document;
    this.preview.show(editor.document);
    this.preview.updateTitle(editor.document);
    await this.convertNow(editor.selection.active);
  }

  dispose(): void {
    this.debouncer.dispose();
    this.preview.dispose();
    this.diagnostics.dispose();
    this.output.dispose();
    void this.session?.dispose();
    void this.provider?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
    if (!this.activeDocument || event.document.uri.toString() !== this.activeDocument.uri.toString()) {
      return;
    }
    this.debouncer.schedule(() => {
      const editor = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.toString() === event.document.uri.toString(),
      );
      void this.convertNow(editor?.selection.active);
    });
  }

  private onDidCloseDocument(document: vscode.TextDocument): void {
    if (this.activeDocument?.uri.toString() === document.uri.toString()) {
      this.activeDocument = undefined;
      this.diagnostics.clear();
    }
  }

  private async ensureSession(document: vscode.TextDocument): Promise<void> {
    const root = workspaceRootFor(document.uri);
    if (this.session && root === this.sessionRoot) return;

    await this.session?.dispose();
    this.session = undefined;
    this.sessionRoot = root;

    if (!this.provider) {
      this.provider = await this.createProvider();
      this.output.appendLine(`Using ar5iv conversion provider: ${this.provider.mode}`);
    }
    this.session = await this.provider.openProject({
      workspaceRoot: root,
      displayName: root ?? document.uri.fsPath,
    });
  }

  private async createProvider(): Promise<ConversionProvider> {
    try {
      return await this.runtime.createConversionProvider();
    } catch (error) {
      if (error instanceof ConversionUnavailableError) {
        throw error;
      }
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  private async convertNow(cursor?: vscode.Position): Promise<void> {
    const document = this.activeDocument;
    if (!document) return;
    if (cursor) this.lastCursor = cursor;

    let request: NormalizedConvertRequest;
    try {
      await this.ensureSession(document);
      request = buildConvertRequest(++this.requestSeq, document, cursor);
      this.preview.renderPending(request);
      const response = await this.session!.convert(request);
      if (request.id !== this.requestSeq || response.revision !== document.version) {
        await this.session?.cancel?.(request.id);
        return;
      }
      this.latestAcceptedRevision = response.revision;
      this.preview.renderResult(request, response);
      this.diagnostics.apply(document, response);
      if (response.log) {
        this.output.appendLine(`--- conversion ${response.id} (${response.status}) ---`);
        this.output.appendLine(response.log);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.preview.renderError(message);
      this.output.appendLine(message);
      if (this.latestAcceptedRevision < document.version) {
        this.diagnostics.clear();
      }
    }
  }
}

function readDebounceMs(): number {
  const configured = vscode.workspace.getConfiguration("ar5iv").get<number>("debounceMs", 500);
  if (!Number.isFinite(configured)) return 500;
  return Math.max(50, Math.min(5000, configured));
}
