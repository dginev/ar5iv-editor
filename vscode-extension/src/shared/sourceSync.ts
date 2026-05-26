import * as vscode from "vscode";
import { recoverSourcePosition } from "../../../frontend-core/recover";

// Reverse source-map navigation (preview → editor), the extension-host half of
// the shared core's `bindPreviewSourceNav`. The webview reports the clicked
// construct's source tag, start line/col, and a content fingerprint; here we
// resolve the tag to a workspace file, run `recoverSourcePosition` against the
// real document text, and move the caret. `recoverSourcePosition` is the same
// pure routine the web editor uses — imported from `frontend-core/`.

export interface SourceRevealRequest {
  readonly tag: number;
  readonly line: number;
  readonly col: number;
  readonly word: string;
  readonly text: string;
  readonly sources: readonly string[];
  readonly activeUri: string;
}

export async function revealSource(message: SourceRevealRequest): Promise<void> {
  const uri = await resolveUri(message);
  if (!uri) return;

  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
  });

  // Content recovery: confirm the clicked text actually sits on the located
  // line, else find it within a few lines (multi-line wrappers, unreliable
  // macro-argument columns). Falls through to the locator's own line:col.
  const recovered = recoverSourcePosition(document.getText(), message.line, message.text, message.word);
  const line1 = recovered?.line ?? message.line;
  const col1 = recovered?.col ?? message.col;
  const pos = document.validatePosition(
    new vscode.Position(Math.max(0, line1 - 1), Math.max(0, col1 - 1)),
  );
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Resolve the clicked construct's source tag to a document URI. Tags index the
 *  conversion's `sources` table (basenames). The active document is the common
 *  single-file case; for multi-file projects we search the workspace for a file
 *  whose basename matches, falling back to the active URI. */
async function resolveUri(message: SourceRevealRequest): Promise<vscode.Uri | undefined> {
  const active = vscode.Uri.parse(message.activeUri);
  if (!message.sources || message.sources.length <= 1) return active;

  const want = message.sources[message.tag];
  if (!want) return active;
  const wantBase = basename(want);
  if (wantBase.toLowerCase() === basename(active.path).toLowerCase()) return active;

  const matches = await vscode.workspace.findFiles(`**/${wantBase}`, "**/node_modules/**", 1);
  return matches[0] ?? active;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
