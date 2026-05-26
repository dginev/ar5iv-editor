import * as vscode from "vscode";
import type { CursorContext, NormalizedConvertRequest } from "./conversionTypes";
import { preloadFor, splitPreamble, hasDocumentclass } from "../../../frontend-core/convert";

// Convert-request construction for VS Code documents. The ar5iv-specific
// shaping (preamble split, document/fragment detection, preload set) is shared
// with `/editor` via `frontend-core/convert`; this module only adapts a
// `vscode.TextDocument` + caret into the normalized request.

export function isLatexDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "latex" || /\.tex$/i.test(document.uri.path);
}

export function workspaceRootFor(uri: vscode.Uri): string | undefined {
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
}

export function providerPathFor(document: vscode.TextDocument): string {
  const root = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!root) {
    return basename(document.uri.path) || "main.tex";
  }
  const rel = vscode.workspace.asRelativePath(document.uri, false);
  return rel.replace(/\\/g, "/");
}

export function buildConvertRequest(
  id: number,
  document: vscode.TextDocument,
  cursor?: vscode.Position,
): NormalizedConvertRequest {
  const text = document.getText();
  const split = splitPreamble(text);
  return {
    id,
    revision: document.version,
    activeUri: document.uri.toString(),
    activeFile: providerPathFor(document),
    text,
    workspaceRoot: workspaceRootFor(document.uri),
    preamble: split.preamble ?? undefined,
    profile: hasDocumentclass(text) ? "document" : "fragment",
    format: "html5",
    preload: preloadFor(text),
    sourceMap: true,
    cursor: cursor ? cursorContext(document, cursor) : undefined,
  };
}

/** 1-based caret line/column plus the word under the caret (content
 *  fingerprint for forward source-map sync). The word is the maximal
 *  `[A-Za-z0-9]` run straddling the caret — matching the web editor's
 *  `getCursorPos`, not VS Code's broader word definition. */
function cursorContext(document: vscode.TextDocument, pos: vscode.Position): CursorContext {
  const lineText = document.lineAt(pos.line).text;
  const isWord = (ch: string | undefined) => !!ch && /[A-Za-z0-9]/.test(ch);
  let s = pos.character;
  let e = pos.character;
  while (s > 0 && isWord(lineText[s - 1])) s--;
  while (e < lineText.length && isWord(lineText[e])) e++;
  return {
    line: pos.line + 1,
    column: pos.character + 1,
    token: lineText.slice(s, e),
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
