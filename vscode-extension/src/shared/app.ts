import * as vscode from "vscode";
import type { RuntimeServices } from "./runtime";
import type { ConversionProvider, ConversionSession } from "./conversionProvider";

/** Workspace-sync caps: stay well under the server session quotas
 *  (200 files / 100 MB) and skip oversized assets rather than fail. */
const MAX_SYNC_FILES = 150;
const MAX_SYNC_FILE_BYTES = 20 * 1024 * 1024;

/** Text files worth streaming to a hosted session on buffer edits. */
const PROJECT_TEXT_EXTENSIONS = /\.(tex|ltx|sty|cls|bib|bbl|bst|cfg|clo|def)$/i;
function isProjectTextFile(document: vscode.TextDocument): boolean {
  if (document.uri.scheme === "untitled") return false;
  return PROJECT_TEXT_EXTENSIONS.test(document.uri.path) || isLatexDocument(document);
}
import { ConversionUnavailableError } from "./conversionProvider";
import { buildConvertRequest, isLatexDocument, providerPathFor, workspaceRootFor } from "./documentModel";
import type { SyncFile } from "./conversionProvider";
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
    if (!this.activeDocument) return;
    const changed = event.document;
    if (changed.uri.toString() === this.activeDocument.uri.toString()) {
      this.debouncer.schedule(() => {
        const editor = vscode.window.visibleTextEditors.find(
          (candidate) => candidate.document.uri.toString() === changed.uri.toString(),
        );
        void this.convertNow(editor?.selection.active);
      });
      return;
    }
    // Sibling project file edited. Two deployments, two behaviors:
    //  * LOCAL engine (desktop): the engine reads the workspace from disk —
    //    no copying, nothing to do (the session has no syncFiles).
    //  * HOSTED (web /vscode): the cloud session is canonical after the
    //    one-time initial upload; sibling BUFFER edits stream to it (and
    //    refresh the preview), debounced through the same pipeline as
    //    active-buffer edits.
    if (!this.session?.syncFiles) return;
    if (!isProjectTextFile(changed)) return;
    this.dirtySiblings.set(changed.uri.toString(), changed);
    this.debouncer.schedule(() => void this.convertNow(this.lastCursor));
  }

  /** Stream edited sibling buffers to a hosted session (cloud-canonical
   *  model). The active buffer is NOT pushed here — it travels with every
   *  convert request. No-op on local-engine sessions. */
  private async pushDirtySiblings(): Promise<void> {
    const session = this.session;
    if (!session?.syncFiles || this.dirtySiblings.size === 0) return;
    const encoder = new TextEncoder();
    const files = [...this.dirtySiblings.values()].map((doc) => ({
      path: providerPathFor(doc),
      bytes: encoder.encode(doc.getText()),
    }));
    this.dirtySiblings.clear();
    await session.syncFiles(files);
  }

  private readonly dirtySiblings = new Map<string, vscode.TextDocument>();

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
    this.syncedMtimes.clear();
    await this.syncWorkspaceFiles(document);
  }

  /** ONE-TIME initial upload of the workspace's project files (TeX
   *  sources, bibliographies, figures) to a hosted session, so
   *  `\input`/`\includegraphics` siblings resolve server-side. Runs at
   *  session open only — afterwards the CLOUD session is canonical and
   *  sibling edits stream as buffer pushes (`pushDirtySiblings`), never
   *  directory re-walks. No-op for local-engine sessions (no
   *  `syncFiles`: the engine reads the workspace from disk, no copying)
   *  and for documents outside a workspace. Known gap: binary assets
   *  added AFTER session open are not picked up (re-open the preview). */
  private async syncWorkspaceFiles(document: vscode.TextDocument): Promise<void> {
    const session = this.session;
    if (!session?.syncFiles) return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return;

    const pattern = new vscode.RelativePattern(
      folder,
      "**/*.{tex,sty,cls,bib,bst,bbl,cfg,clo,def,png,jpg,jpeg,gif,svg,pdf,eps}",
    );
    const uris = await vscode.workspace.findFiles(
      pattern,
      "**/{node_modules,.git,target,dist,out}/**",
      MAX_SYNC_FILES,
    );
    const activeUri = document.uri.toString();
    const dirty: SyncFile[] = [];
    for (const uri of uris) {
      // The active buffer travels with every convert request; its disk
      // copy may be stale mid-edit.
      if (uri.toString() === activeUri) continue;
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        continue;
      }
      if (stat.size > MAX_SYNC_FILE_BYTES) continue;
      const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
      if (this.syncedMtimes.get(rel) === stat.mtime) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        dirty.push({ path: rel, bytes });
        this.syncedMtimes.set(rel, stat.mtime);
      } catch (error) {
        this.output.appendLine(
          `workspace sync: reading ${rel} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (dirty.length > 0) {
      await session.syncFiles(dirty);
      this.output.appendLine(`workspace sync: pushed ${dirty.length} file(s)`);
    }
  }

  private readonly syncedMtimes = new Map<string, number>();

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
      await this.pushDirtySiblings();
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
