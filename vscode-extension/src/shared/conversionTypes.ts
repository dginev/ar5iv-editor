export type ConversionMode = "native" | "executable" | "backend";

export type ConversionStatus = "ok" | "error" | "fatal" | "superseded";

export type DiagnosticSeverity = "info" | "warning" | "error" | "fatal";

export interface ProjectHandle {
  readonly workspaceRoot?: string;
  readonly displayName: string;
}

export interface SourcePosition {
  readonly line: number;
  readonly column?: number;
}

/** The caret context captured at conversion time, for forward source-map sync:
 *  1-based line/column plus the word under the caret (content fingerprint used
 *  to refine the matched preview construct). */
export interface CursorContext {
  readonly line: number;
  readonly column: number;
  readonly token?: string;
}

export interface NormalizedDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly category: string;
  readonly message: string;
  readonly source?: string;
  readonly from?: SourcePosition;
  readonly to?: SourcePosition;
}

export interface ConversionTimings {
  readonly buildUs?: number;
  readonly convertMs?: number;
  readonly postMs?: number;
  readonly totalMs?: number;
  readonly networkMs?: number;
}

export interface ConverterCapabilities {
  readonly sourceMap: boolean;
  readonly cancel: boolean;
  readonly multiFileOverlay: boolean;
}

export interface ConverterVersion {
  readonly name: string;
  readonly version?: string;
  readonly sha?: string;
  readonly date?: string;
  readonly url?: string;
}

export interface NormalizedConvertRequest {
  readonly id: number;
  readonly revision: number;
  readonly activeUri: string;
  readonly activeFile: string;
  readonly text: string;
  readonly workspaceRoot?: string;
  readonly preamble?: string;
  readonly profile?: "fragment" | "document" | "math";
  readonly format?: "html5";
  readonly preload: readonly string[];
  readonly sourceMap: boolean;
  readonly cursor?: CursorContext;
}

export interface NormalizedConvertResponse {
  readonly id: number;
  readonly revision: number;
  readonly status: ConversionStatus;
  readonly statusCode: number;
  /** The engine's own status string (e.g. "ok", "1 warning", "2 errors"),
   *  surfaced verbatim in the preview status line like the web editor. */
  readonly engineStatus?: string;
  readonly html: string;
  readonly diagnostics: readonly NormalizedDiagnostic[];
  readonly sources: readonly string[];
  readonly log: string;
  readonly timings?: ConversionTimings;
  readonly converter?: ConverterVersion;
  readonly capabilities?: ConverterCapabilities;
}

export function fatalResponse(
  request: Pick<NormalizedConvertRequest, "id" | "revision">,
  message: string,
): NormalizedConvertResponse {
  return {
    id: request.id,
    revision: request.revision,
    status: "fatal",
    statusCode: 1,
    html: "",
    diagnostics: [
      {
        severity: "fatal",
        category: "ar5iv",
        message,
      },
    ],
    sources: [],
    log: message,
  };
}
