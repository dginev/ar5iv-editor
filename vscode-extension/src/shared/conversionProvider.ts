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
  dispose(): Promise<void>;
}

export class ConversionUnavailableError extends Error {
  constructor(
    public readonly mode: ConversionMode,
    message: string,
  ) {
    super(message);
  }
}
