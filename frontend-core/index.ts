// ar5iv shared frontend core.
//
// One implementation of the logic shared by every ar5iv editor/preview surface,
// so the three applications stay in lockstep instead of drifting apart:
//
//   1. the web editor (`frontend/`, CodeMirror) at `/editor`;
//   2. the browser VS Code demo at `/vscode`;
//   3. the local desktop VS Code extension (the "code" plugin).
//
// What lives here is framework-agnostic and carries no bundler-resolved npm
// dependency (idiomorph, the one external piece, is injected by each adapter):
//
//   - preview rendering: shadow-DOM host + ar5iv stylesheet stack + idiomorph
//     re-render, plus the precision source-map sync in both directions
//     (`preview.ts`, `host.ts`, `forward-sync.ts`, `reverse-sync.ts`);
//   - source-locator parsing and reverse-nav content recovery (`sourcepos.ts`,
//     `recover.ts`);
//   - convert-request shaping: preamble split, document/fragment detection,
//     preload sets (`convert.ts`).
//
// Per-environment specifics — the color-token → theme-var mapping, stylesheet
// URLs, navigation glue, and transport — are supplied by each adapter.

export { createPreview, type PreviewController } from "./preview";
export { STRUCTURAL_CSS, type PreviewHostConfig } from "./host";
export { parseSourcepos, baseName, resolveTag, type ParsedSourcepos } from "./sourcepos";
export { recoverSourcePosition } from "./recover";
export type { SourceNavTarget } from "./reverse-sync";
export {
  PRELOAD_AR5IV_ONLY,
  PRELOAD_FRAGMENT,
  hasDocumentclass,
  preloadFor,
  splitPreamble,
} from "./convert";
export { locateDiagnosticToken, type DiagnosticSpan } from "./diagnostics";
