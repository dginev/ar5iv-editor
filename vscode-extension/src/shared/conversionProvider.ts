import type {
  ConversionMode,
  NormalizedConvertRequest,
  NormalizedConvertResponse,
  ProjectHandle,
} from "./conversionTypes";

export interface ConversionProvider {
  readonly mode: ConversionMode;
  openProject(project: ProjectHandle): Promise<ConversionSession>;
  dispose(): Promise<void>;
}

export interface ConversionSession {
  convert(request: NormalizedConvertRequest): Promise<NormalizedConvertResponse>;
  cancel?(id: number): Promise<void>;
  /** Push workspace sibling files to the conversion backend. Only remote
   *  (hosted) sessions implement this: a local engine reads the workspace
   *  from disk directly, but a hosted session only knows the bytes it has
   *  been sent — without this, `\input{chapter}` and `\includegraphics`
   *  have nothing to resolve against (the bug class: "budget-tables.tex
   *  is right there" while the server-side session dir holds one file). */
  syncFiles?(files: readonly SyncFile[]): Promise<void>;
  dispose(): Promise<void>;
}

/** One workspace file pushed to a remote conversion session, with its
 *  workspace-relative path (forward slashes). */
export interface SyncFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export class ConversionUnavailableError extends Error {
  constructor(
    public readonly mode: ConversionMode,
    message: string,
  ) {
    super(message);
  }
}
