import * as vscode from "vscode";
import type { NormalizedConvertResponse, NormalizedConvertRequest } from "./conversionTypes";
import type { SourceRevealRequest } from "./sourceSync";

type WebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "revealSource"; payload: SourceRevealRequest };

export interface PreviewPanelHandlers {
  onRevealSource(payload: SourceRevealRequest): void;
  onRefresh(): void;
}

// The preview webview surface. The rendered ar5iv document, theme mapping, and
// source-map sync all live in the bundled webview script (media/preview.js ->
// the shared preview-core). This class owns the panel lifecycle, the HTML
// scaffold (toolbar + asset URIs + CSP), and message routing to the extension.
export class PreviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private latestRequest: NormalizedConvertRequest | undefined;
  private latestResponse: NormalizedConvertResponse | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly handlers: PreviewPanelHandlers,
  ) {}

  show(document: vscode.TextDocument): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    this.panel = vscode.window.createWebviewPanel(
      "ar5ivPreview",
      `ar5iv: ${basename(document.uri.path)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot],
      },
    );
    this.panel.webview.html = this.renderHtml(this.panel.webview, mediaRoot);
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.onMessage(message),
      undefined,
      this.context.subscriptions,
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  updateTitle(document: vscode.TextDocument): void {
    if (this.panel) {
      this.panel.title = `ar5iv: ${basename(document.uri.path)}`;
    }
  }

  renderPending(request: NormalizedConvertRequest): void {
    this.latestRequest = request;
    this.post({
      type: "pending",
      request: requestMeta(request),
    });
  }

  renderResult(request: NormalizedConvertRequest, response: NormalizedConvertResponse): void {
    this.latestRequest = request;
    this.latestResponse = response;
    this.postResult(request, response);
  }

  renderError(message: string): void {
    this.post({ type: "error", message });
  }

  renderEmpty(message: string): void {
    this.post({ type: "empty", message });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private onMessage(message: WebviewMessage): void {
    if (message.type === "ready") {
      if (this.latestResponse && this.latestRequest) {
        this.postResult(this.latestRequest, this.latestResponse);
      }
      return;
    }
    if (message.type === "refresh") {
      this.handlers.onRefresh();
      return;
    }
    if (message.type === "revealSource") {
      this.handlers.onRevealSource(message.payload);
    }
  }

  private postResult(request: NormalizedConvertRequest, response: NormalizedConvertResponse): void {
    this.post({
      type: "result",
      request: requestMeta(request),
      response,
    });
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = makeNonce();
    const cspSource = webview.cspSource;
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file)).toString();
    const bootstrap = JSON.stringify({
      ar5ivCssUri: asset("ar5iv.css"),
      fontsCssUri: asset("ar5iv-fonts.css"),
    });

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: http: data:; style-src ${cspSource} 'unsafe-inline' https: http:; font-src ${cspSource} https: http: data:; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${asset("preview.css")}">
  <title>ar5iv Preview</title>
</head>
<body>
  <header>
    <div class="title" id="title">ar5iv Preview</div>
    <div class="toolbar">
      <button class="tool-btn" id="btn-refresh" type="button" title="Refresh preview">↻</button>
      <button class="tool-btn" id="btn-log" type="button" title="Toggle conversion log" aria-pressed="false">log</button>
    </div>
  </header>
  <div class="statusbar">
    <span class="status" id="status" title="Click to toggle the conversion log">ready</span>
    <span class="timings" id="timings"></span>
    <a class="version" id="version" target="_blank" rel="noopener noreferrer" hidden></a>
  </div>
  <main>
    <div id="preview"></div>
    <pre class="log" id="log" hidden></pre>
  </main>
  <script type="application/json" id="ar5iv-bootstrap" nonce="${nonce}">${bootstrap}</script>
  <script nonce="${nonce}" src="${asset("preview.js")}"></script>
</body>
</html>`;
  }
}

function requestMeta(request: NormalizedConvertRequest): unknown {
  return {
    id: request.id,
    revision: request.revision,
    activeFile: request.activeFile,
    activeUri: request.activeUri,
    cursor: request.cursor,
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
