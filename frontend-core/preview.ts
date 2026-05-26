// The shared preview controller: shadow-DOM host + idiomorph re-render + the
// precision source-map sync (both directions), wired together. See
// `frontend-core/index.ts` for the package overview, and `host.ts` for the
// structural CSS and shadow-DOM caveats.
//
// The controller depends on neither CodeMirror nor the VS Code API, and carries
// no bundler-resolved npm dependency: idiomorph is injected as `morph`.

import { PreviewHost, type PreviewHostConfig } from "./host";
import { scrollPreviewToSource } from "./forward-sync";
import { bindPreviewSourceNav, type SourceNavTarget } from "./reverse-sync";

export type { SourceNavTarget, PreviewHostConfig };

export interface PreviewController {
  /** The inner `#preview-root-host` the ar5iv document renders into. */
  host(): HTMLElement;
  setTheme(theme: "light" | "dark"): void;
  renderResult(html: string): void;
  showEmptyState(message: string): void;
  /** Scroll/flash the preview to the construct matching the edited source
   *  position (forward sync). `token` is the word at the caret (content
   *  fingerprint); `sources` is the conversion's source-tag table. */
  scrollToSource(
    line: number,
    col: number,
    token: string,
    activeFile: string,
    sources?: readonly string[],
  ): void;
  /** Bind double-click → source navigation (reverse sync), once. */
  bindSourceNav(onPick: (target: SourceNavTarget) => void): void;
}

export function createPreview(config: PreviewHostConfig): PreviewController {
  const previewHost = new PreviewHost(config);
  return {
    host: () => previewHost.ensure(),
    setTheme: (theme) => previewHost.setTheme(theme),
    renderResult: (html) => previewHost.renderResult(html),
    showEmptyState: (message) => previewHost.showEmptyState(message),
    scrollToSource: (line, col, token, activeFile, sources) =>
      scrollPreviewToSource(previewHost.ensure(), line, col, token, activeFile, sources),
    bindSourceNav: (onPick) => bindPreviewSourceNav(previewHost.ensure(), onPick),
  };
}
