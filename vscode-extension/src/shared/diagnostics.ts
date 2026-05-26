import * as vscode from "vscode";
import { locateDiagnosticToken } from "../../../frontend-core/diagnostics";
import type { NormalizedConvertResponse, NormalizedDiagnostic } from "./conversionTypes";

export class DiagnosticPublisher {
  private readonly collection = vscode.languages.createDiagnosticCollection("ar5iv");
  private readonly touched = new Set<string>();

  apply(activeDocument: vscode.TextDocument, response: NormalizedConvertResponse): void {
    const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const diagnostic of response.diagnostics) {
      if (diagnostic.severity === "info") {
        continue;
      }
      const uri = activeDocument.uri;
      const list = grouped.get(uri.toString()) ?? [];
      list.push(toVscodeDiagnostic(activeDocument, diagnostic));
      grouped.set(uri.toString(), list);
    }

    for (const prior of this.touched) {
      if (!grouped.has(prior)) {
        this.collection.set(vscode.Uri.parse(prior), []);
      }
    }

    for (const [uri, diagnostics] of grouped) {
      this.collection.set(vscode.Uri.parse(uri), diagnostics);
      this.touched.add(uri);
    }

    if (!grouped.has(activeDocument.uri.toString())) {
      this.collection.set(activeDocument.uri, []);
      this.touched.add(activeDocument.uri.toString());
    }
  }

  clear(): void {
    this.collection.clear();
    this.touched.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}

function toVscodeDiagnostic(
  document: vscode.TextDocument,
  diagnostic: NormalizedDiagnostic,
): vscode.Diagnostic {
  const range = diagnosticRangeFor(document, diagnostic);
  const message = diagnostic.category
    ? `${diagnostic.category}: ${firstLine(diagnostic.message)}`
    : firstLine(diagnostic.message);
  const out = new vscode.Diagnostic(range, message, severity(diagnostic.severity));
  out.source = diagnostic.category ? `ar5iv: ${diagnostic.category}` : "ar5iv";
  return out;
}

/** Choose the editor range for a diagnostic. The preview is single active-file:
 *  the converted document IS the active buffer (the hosted provider uploads it
 *  as the session entry, so the engine's `source` is the remote entry name, not
 *  the editor's), so we don't gate on the source name.
 *  1. a positive engine source line → that line/column;
 *  2. no usable line (e.g. an undefined macro inside a macro argument, which the
 *     engine can't locate) → recover by finding the named token in the source;
 *  3. otherwise anchor visibly at line 1. */
function diagnosticRangeFor(
  document: vscode.TextDocument,
  diagnostic: NormalizedDiagnostic,
): vscode.Range {
  if ((diagnostic.from?.line ?? 0) > 0) {
    return diagnosticRange(document, diagnostic);
  }
  const located = locateDiagnosticToken(document.getText(), diagnostic.category ?? "", diagnostic.message ?? "");
  if (located) {
    const lineIndex = clampLine(document, located.line - 1);
    const line = document.lineAt(lineIndex);
    const fromCol = clampColumn(line, located.column - 1);
    const toCol = clampColumn(line, fromCol + located.length);
    if (toCol > fromCol) return new vscode.Range(lineIndex, fromCol, lineIndex, toCol);
    return visibleLineRange(document, line);
  }
  return topLineRange(document);
}

function diagnosticRange(
  document: vscode.TextDocument,
  diagnostic: NormalizedDiagnostic,
): vscode.Range {
  const lineIndex = clampLine(document, (diagnostic.from?.line ?? 1) - 1);
  const line = document.lineAt(lineIndex);

  if (diagnostic.from?.column === undefined) {
    return visibleLineRange(document, line);
  }

  const fromCol = clampColumn(line, diagnostic.from.column - 1);
  if (diagnostic.to?.line !== undefined || diagnostic.to?.column !== undefined) {
    const toLineIndex = clampLine(document, (diagnostic.to?.line ?? diagnostic.from.line) - 1);
    const toLine = document.lineAt(toLineIndex);
    const rawToCol = diagnostic.to?.column ?? diagnostic.from.column + 1;
    const toCol = clampColumn(toLine, rawToCol - 1);
    const range = new vscode.Range(lineIndex, fromCol, toLineIndex, toCol);
    if (!range.isEmpty) return range;
  }

  const endCol = Math.min(line.text.length, fromCol + 1);
  if (endCol > fromCol) {
    return new vscode.Range(lineIndex, fromCol, lineIndex, endCol);
  }
  return visibleLineRange(document, line);
}

function topLineRange(document: vscode.TextDocument): vscode.Range {
  return visibleLineRange(document, document.lineAt(0));
}

function visibleLineRange(
  document: vscode.TextDocument,
  line: vscode.TextLine,
): vscode.Range {
  if (!line.isEmptyOrWhitespace) {
    return new vscode.Range(
      line.lineNumber,
      line.firstNonWhitespaceCharacterIndex,
      line.lineNumber,
      line.range.end.character,
    );
  }
  if (line.lineNumber + 1 < document.lineCount) {
    return new vscode.Range(line.lineNumber, 0, line.lineNumber + 1, 0);
  }
  return new vscode.Range(line.lineNumber, 0, line.lineNumber, Math.max(1, line.range.end.character));
}

function clampLine(document: vscode.TextDocument, line: number): number {
  return Math.max(0, Math.min(document.lineCount - 1, line));
}

function clampColumn(line: vscode.TextLine, column: number): number {
  return Math.max(0, Math.min(line.text.length, column));
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

function severity(value: NormalizedDiagnostic["severity"]): vscode.DiagnosticSeverity {
  switch (value) {
    case "fatal":
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "info":
      return vscode.DiagnosticSeverity.Information;
  }
}
