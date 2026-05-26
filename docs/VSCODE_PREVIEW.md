# VS Code Preview Plan

This document plans a sibling editor experiment for ar5iv-editor: a VS Code
extension with the same live LaTeX conversion loop and source/preview sync as
the current `/editor` CodeMirror app, plus a `/vscode` web experiment for
running or launching that extension in a browser-hosted VS Code environment.

## Goal

Build a VS Code extension that uses VS Code's native editor for `.tex` editing
and `latexml-oxide` for conversion.

For the real desktop extension, conversion should prefer a native
`latexml-oxide` integration on the user's system so edits can flow into the
converter without process-spawn overhead. The first supported platform is
Ubuntu.

The plugin may also support a `latexml-oxide` executable as a compatibility
fallback. If the native integration or executable is missing, the extension may
offer to download a supported Ubuntu build from the project's GitHub release
assets and install it into extension-managed storage.

For the `/vscode` browser experiment, the extension cannot execute local
binaries. That path must continue to use a hosted ar5iv conversion backend.
The design should make that backend path reuse the same boundary as the local
VS Code demo, so `latexml.rs/vscode` and desktop VS Code exercise the same
preview, diagnostics, source-map, and lifecycle code.

The extension should provide:

- live "conversion as you type";
- a preview panel beside the editor;
- editor-to-preview source-map scroll sync;
- preview-to-editor source navigation;
- converter diagnostics surfaced as VS Code diagnostics;
- Ubuntu as the first and only supported local native-conversion platform;
- a native desktop integration path that avoids shelling out in the steady
  state;
- a browser-compatible mode for the `/vscode` experiment where conversion is
  delegated to the hosted backend.

The current `/editor` route remains the production browser editor. The
`/vscode` route should start as an experiment, not a replacement.

## Existing Pieces To Reuse

The current app already has the backend contract needed by the extension:

- `POST /api/user` mints an anonymous user token.
- `POST /api/session` opens a per-user session/slot.
- `PUT /api/session/{id}/files/{path}` writes source into the session.
- `GET /api/session/{id}/files/{path}` reads session files.
- `GET /api/session/{id}/files` lists files and returns the session version.
- `GET /api/version` exposes build/version metadata.
- `WebSocket /convert?session_id=...&user_id=...` performs conversion.

The frontend code also has reusable client-side logic:

- `frontend/src/session.ts`: session and file API wrapper.
- `frontend/src/ws.ts`: conversion WebSocket client and protocol types.
- `frontend/src/preview.ts`: preview rendering and source-map helpers.
- `frontend/src/main.ts`: debounce, stale-response handling, diagnostics,
  source-map sync, and session-expiry recovery patterns.

The first implementation should extract protocol/client helpers from the
CodeMirror app rather than copy/paste them into the extension.

## Architecture

Create a new package, tentatively `vscode-extension/`, with a mostly shared
application core and thin desktop/browser entry points over a shared conversion
boundary:

- `main`: desktop extension host implementation. This can use Node APIs and
  load the local native `latexml-oxide` integration.
- `browser`: web extension host implementation. This cannot use Node APIs or
  local executables, so it talks to the hosted ar5iv backend.

The extension should use:

- VS Code's native text editor for source editing;
- `vscode.window.createWebviewPanel` for the ar5iv preview;
- `vscode.workspace.onDidChangeTextDocument` for edit detection;
- `vscode.languages.createDiagnosticCollection` for converter diagnostics;
- a native desktop converter binding for `latexml-oxide`;
- optional `child_process` fallback in the desktop entry point only when the
  native binding is unavailable or explicitly disabled;
- `vscode.workspace.fs` where possible for workspace file access;
- `fetch` and `WebSocket` only in the browser/backend mode;
- webview `postMessage` for preview-to-extension navigation.

The implementation should DRY nearly the entire app. The desktop and browser
entry points should be deployment adapters that initialize capabilities and then
hand control to the same app shell.

Keep shared logic in runtime-neutral modules. The desktop adapter can provide
Node-only capabilities such as native module loading and executable fallback;
the browser adapter provides backend URL/session capabilities. After startup,
both should run the same command registration, preview, diagnostics, source
sync, status, and lifecycle code.

## Shared Boundary

The key design constraint is that the local VS Code demo and the
`latexml.rs/vscode` web preview should share nearly all code above the
conversion transport.

Use two small boundaries:

- `RuntimeCapabilities`: what this deployment can do.
- `ConversionProvider`: how this deployment performs conversion.

```ts
interface RuntimeCapabilities {
  readonly deployment: "desktop" | "web";
  readonly canLoadNativeConverter: boolean;
  readonly canRunExecutableFallback: boolean;
  readonly canUseHostedBackend: boolean;
  readonly defaultBackendUrl?: string;
}
```

Then conversion itself hangs off a provider:

```ts
interface ConversionProvider {
  readonly mode: "native" | "executable" | "backend";
  openProject(project: ProjectHandle): Promise<ConversionSession>;
  dispose(): Promise<void>;
}

interface ConversionSession {
  convert(req: NormalizedConvertRequest): Promise<NormalizedConvertResponse>;
  cancel?(id: number): Promise<void>;
  dispose(): Promise<void>;
}
```

Everything above this boundary should be shared:

- command registration;
- debounce and stale-response handling;
- active document tracking;
- preview webview HTML and message protocol;
- editor-to-preview scroll sync;
- preview-to-editor source navigation;
- diagnostics mapping;
- conversion status/log/timing UI;
- version and capability display.

The deployment-specific code should be limited to:

- desktop capability detection;
- browser capability detection;
- native Ubuntu binding loading;
- executable fallback discovery;
- hosted backend URL/session setup;
- asset URI resolution where VS Code desktop and web differ.

The hosted backend adapter should not be treated as a separate application
protocol. It should implement the same normalized request/response contract and
translate it to the existing `/api/*` plus `/convert` WebSocket routes.

This lets us build:

- a local desktop VS Code demo backed by native `latexml-oxide`;
- a local browser VS Code demo backed by the development backend;
- the public `latexml.rs/vscode` preview backed by the production backend;
- the current `/editor` app, once shared helpers are extracted, with less
  duplicated conversion glue.

The intended shape is:

```text
               shared VS Code app shell
 command registration / preview / diagnostics / sync / state
                          |
               ConversionProvider boundary
                          |
        -----------------------------------------
        |                  |                    |
 native Ubuntu       executable fallback    hosted backend
 desktop             desktop                web + latexml.rs/vscode
```

That keeps the deployment difference minimal: desktop gets local converter
capabilities; web gets hosted backend capabilities. The user-facing app remains
the same.

## Conversion Modes

### Desktop Native Mode

The desktop extension should run conversion locally through a native boundary:

1. Load an Ubuntu-compatible native converter module from the extension bundle,
   extension-managed storage, or a configured path.
2. Keep a warm converter instance alive for the preview panel/session.
3. Send document text, active file path, preamble/profile/format options, and
   source-map options directly through the binding.
4. Receive HTML, diagnostics, log, timings, and source-map metadata as
   structured data.
5. Normalize the result into the same internal `ConvertResponse` shape used by
   the preview layer.

Possible native packaging options:

- Node native addon using N-API, loaded by the desktop extension host.
- A shared library with a small Node binding layer.
- A long-lived local helper process only as a transitional compromise if the
  direct binding is not ready; this still avoids per-keystroke process startup,
  but is not the preferred final design.

The native API should be designed alongside `latexml-oxide`, not as a thin
wrapper around command-line text. The goal is one shared conversion core used by
the backend, the CLI, and the VS Code plugin.

### Desktop Executable Fallback

The desktop extension may keep an executable fallback for early adoption and
debugging:

1. Resolve the executable path from `ar5iv.latexmlOxidePath`, then `PATH`, then
   extension-managed install storage.
2. If no executable is found, prompt the user to install `latexml-oxide` or
   download a supported Ubuntu release asset.
3. Write the active document and needed project files into a temporary work
   directory.
4. Run `latexml-oxide` with the same profile/format/source-map options used by
   the web backend.
5. Parse the converter result, diagnostics, log, timings, and source-map
   metadata into the same internal `ConvertResponse` shape used by the preview
   layer.
6. Render the result in the webview and publish VS Code diagnostics.

Only Ubuntu should be treated as supported for downloaded native modules or
executables in the first version. Other platforms can show a clear
unsupported-platform message and allow manual path configuration later.

### Browser Backend Mode

The browser extension and `/vscode` experiment cannot execute local binaries.
They should use the hosted backend adapter behind the same `ConversionProvider`
boundary as desktop local mode. Internally, that adapter keeps using the hosted
backend contract:

- `POST /api/user`;
- `POST /api/session`;
- `PUT /api/session/{id}/files/{path}`;
- `WebSocket /convert?session_id=...&user_id=...`.

The preview, diagnostics, stale-response handling, and source-sync code should
be shared between local mode and backend mode.

## Ubuntu Bootstrap Flow

Add settings:

```json
{
  "ar5iv.latexmlOxidePath": {
    "type": "string",
    "default": "",
    "description": "Absolute path to a latexml-oxide executable fallback. Empty means auto-detect."
  },
  "ar5iv.nativeLatexmlOxidePath": {
    "type": "string",
    "default": "",
    "description": "Absolute path to a native latexml-oxide module. Empty means use the bundled or downloaded module."
  },
  "ar5iv.disableNativeLatexmlOxide": {
    "type": "boolean",
    "default": false,
    "description": "Disable the native converter binding and use the executable/backend fallback."
  },
  "ar5iv.allowDownloadLatexmlOxide": {
    "type": "boolean",
    "default": false,
    "description": "Allow the extension to download a supported Ubuntu latexml-oxide native module or executable when no local install is found."
  }
}
```

Install/download behavior:

1. Detect platform with `process.platform` and Linux distribution details.
2. Continue only for Ubuntu in the first release.
3. Prefer a matching native `latexml-oxide` module asset.
4. If native integration is unavailable, optionally fall back to a matching
   executable asset.
5. Download to extension global storage.
6. Verify the asset with a published checksum before loading or execution.
7. Mark executable assets executable.
8. Run a native ABI/version check or `latexml-oxide --version` smoke command.
9. Cache the resolved path in extension global state.

The extension should never silently download or execute a binary. It should
require an explicit user action or setting.

## Native Integration Requirements

The native converter API should expose a structured contract, not just CLI
stdout/stderr:

- create/dispose converter instance;
- convert active file path plus in-memory source override;
- set session/project root and search paths;
- pass preamble, profile, format, preload, and source-map options;
- return rendered HTML;
- return diagnostics with file/line/column metadata;
- return source-map `sources` and source positions;
- return conversion log and timing breakdown;
- report converter version/build metadata;
- cancel or supersede an in-flight conversion when a newer edit arrives.

The backend and extension should share this contract conceptually even if the
transport differs. That keeps `/editor`, the CLI, and VS Code from developing
three subtly different conversion behaviors.

The normalized TypeScript boundary should be the extension-facing version of
this contract. The Rust backend protocol and native binding can evolve toward
the same fields over time.

## Extension Package Skeleton

Add:

```text
vscode-extension/
  package.json
  tsconfig.json
  esbuild.desktop.js
  esbuild.web.js
  src/
    desktop/
      extension.ts
      nativeConverter.ts
      executableFallback.ts
      installer.ts
    web/
      extension.ts
      backendConverter.ts
    shared/
      app.ts
      runtimeCapabilities.ts
      conversionProvider.ts
      conversionTypes.ts
      conversion.ts
      sourceMap.ts
      previewHtml.ts
      diagnostics.ts
```

The manifest should start small:

```json
{
  "name": "ar5iv-vscode",
  "displayName": "ar5iv Preview",
  "version": "0.0.1",
  "engines": {
    "vscode": "^1.90.0"
  },
  "main": "./dist/desktop/extension.js",
  "browser": "./dist/web/extension.js",
  "activationEvents": [
    "onLanguage:latex",
    "onCommand:ar5iv.openPreview"
  ],
  "contributes": {
    "commands": [
      {
        "command": "ar5iv.openPreview",
        "title": "ar5iv: Open Preview"
      }
    ],
    "configuration": {
      "properties": {
        "ar5iv.backendUrl": {
          "type": "string",
          "default": "http://localhost:3000",
          "description": "Base URL for the ar5iv-editor conversion backend used by browser mode."
        },
        "ar5iv.latexmlOxidePath": {
          "type": "string",
          "default": "",
          "description": "Absolute path to a latexml-oxide executable fallback. Empty means auto-detect."
        },
        "ar5iv.nativeLatexmlOxidePath": {
          "type": "string",
          "default": "",
          "description": "Absolute path to a native latexml-oxide module. Empty means use the bundled or downloaded module."
        },
        "ar5iv.disableNativeLatexmlOxide": {
          "type": "boolean",
          "default": false,
          "description": "Disable the native converter binding and use the executable/backend fallback."
        },
        "ar5iv.allowDownloadLatexmlOxide": {
          "type": "boolean",
          "default": false,
          "description": "Allow downloading a supported Ubuntu latexml-oxide native module or executable when no local install is found."
        }
      }
    }
  }
}
```

Build both entry points:

- desktop bundle: Node extension host target, keeps `child_process` available;
- web bundle: browser WebWorker target, single `dist/web/extension.js` bundle
  with `vscode` externalized.

The desktop bundle should load the native binding lazily so the extension can
still activate and show actionable setup errors if the binding is missing or
incompatible.

Both entry points should be small:

- construct `RuntimeCapabilities`;
- construct the preferred `ConversionProvider`;
- call shared `activateAr5ivExtension(context, capabilities, provider)`.

All commands and UI behavior should live behind `activateAr5ivExtension`.

## Live Conversion Flow

1. User opens a `.tex` document.
2. User runs `ar5iv: Open Preview`.
3. Shared app selects or receives a `ConversionProvider`:
   - desktop: local `latexml-oxide`;
   - browser: hosted backend session.
4. Extension creates a preview webview beside the active editor.
5. On text changes, debounce edits using the same approximate cadence as the
   CodeMirror app.
6. Debounce tail starts a conversion:
   - desktop: calls the native converter binding, falling back to the executable
     path only when configured or necessary;
   - browser: writes document text to the backend session with `PUT`, then
     sends a `ConvertRequest` over `/convert`.
7. Extension accepts only the freshest response using request `id` and session
   `version`.
8. Extension posts rendered HTML and source-map metadata into the webview.
9. Extension publishes diagnostics from the response.

In browser/backend mode, the request should mirror the current frontend:

```json
{
  "id": 1,
  "active_file": "main.tex",
  "version": 1,
  "profile": "fragment",
  "format": "html5",
  "preload": ["LaTeXML::Package::Pool", "LaTeXML::Package::TeX.pool"]
}
```

The exact preload/preamble rules should be shared with or extracted from the
current frontend so the two editors do not drift.

All modes should produce the same normalized internal response shape. Native
mode should avoid per-conversion process startup and avoid parsing
human-oriented CLI text.

## Source And Preview Sync

### Editor To Preview

On edit-driven conversions:

1. Capture the active editor cursor line, column, token text, and file path at
   debounce time.
2. After the matching conversion renders, send a `scrollToSource` message to the
   webview.
3. The webview locates the nearest rendered element with matching
   `data-sourcepos` metadata and scrolls it into view.

This should reuse the current source-map lookup behavior where possible.

### Preview To Editor

Inside the webview:

1. Bind double-click on rendered preview content.
2. Decode the clicked element's source position.
3. Send a message to the extension:

```json
{
  "type": "revealSource",
  "tag": 0,
  "line": 12,
  "col": 3,
  "text": "..."
}
```

The extension then:

1. Resolves `tag` through the last response's `sources` array.
2. Finds the matching workspace document or session path.
3. Opens the document with `vscode.workspace.openTextDocument`.
4. Reveals and selects the corresponding source range.

For the MVP, this can target the active document only. Multi-file source-map
resolution can follow after single-file sync is reliable.

## Diagnostics

Convert `ConvertResponse.diagnostics` into `vscode.Diagnostic` instances.

Rules:

- map `fatal` and `error` to `DiagnosticSeverity.Error`;
- map `warning` to `DiagnosticSeverity.Warning`;
- map `info` to `DiagnosticSeverity.Information`;
- attach line-anchored diagnostics to the best matching document URI;
- show unanchored diagnostics in the preview status/log area first, then
  consider a dedicated output channel.

Clear diagnostics for a document when a newer clean conversion response arrives.

## Backend And Deployment Changes

The real desktop extension should not require the ar5iv backend for conversion
when `latexml-oxide` is available locally. The backend changes below apply to
browser/backend mode and the `/vscode` experiment.

The current `/editor` app is same-origin with the backend. A VS Code web
extension may run from `vscode.dev`, `github.dev`, or a local test-web origin.
That requires explicit backend support.

Add or verify:

- CORS for `/api/*`;
- WebSocket origin policy for `/convert`;
- support for `x-ar5iv-user` from cross-origin extension fetches;
- HTTPS/WSS support in any public deployment;
- extension-friendly handling in Anubis or a separate API access policy;
- a backend URL setting for browser mode;
- clear errors when the backend URL is unreachable or blocked by CORS.

For local development, `http://localhost:3000` and `ws://localhost:3000` are
enough. For public browser VS Code, the backend must be HTTPS/WSS.

## `/vscode` Experiment

The `/vscode` path should be introduced only after the extension works in a
standard web-extension test environment.

Start with a lightweight route on `latexml.rs`:

- add `GET /vscode`;
- render a page explaining the experiment status;
- link to local test-web instructions while development is local;
- optionally expose extension build assets under `/static/vscode-extension/*`.

Do not initially fork or deeply embed VS Code's web workbench. Treat self-hosted
VS Code as a later experiment after the extension's core behavior is stable in
both desktop-local and browser-backend modes.

Possible stages:

1. `/vscode` documentation/launcher page on `latexml.rs`.
2. Dev-only launcher for `@vscode/test-web`.
3. Public extension package served from `latexml.rs` for sideloading.
4. Optional self-hosted VS Code web workbench with the extension preloaded.

The public `/vscode` preview should use the same hosted backend adapter that
the browser extension uses in local `@vscode/test-web` development. The
difference should be configuration, not code shape: backend URL, static asset
base URL, and deployment policy.

## Minimal Deployment Difference

The same extension app should support these deployments:

| Deployment | Entry point | Converter provider | Expected difference |
| --- | --- | --- | --- |
| Desktop VS Code on Ubuntu | `main` | native Ubuntu binding | local conversion, no backend required |
| Desktop VS Code fallback | `main` | executable fallback | local conversion with compatibility overhead |
| Local browser demo | `browser` | hosted backend | local backend URL |
| `latexml.rs/vscode` | `browser` | hosted backend | production backend URL and public policy |

The shared app should not branch on deployment except through capabilities. For
example, the preview webview should not care whether HTML came from a native
binding, executable fallback, or WebSocket response.

## Web Preview And Test Steps

Use the official web-extension path for browser-mode development:

```sh
cd vscode-extension
npm install
npm run compile-web
npm run run-in-browser
```

The `run-in-browser` script should use `@vscode/test-web`, for example:

```json
{
  "scripts": {
    "run-in-browser": "vscode-test-web --browserType=chromium --extensionDevelopmentPath=. ."
  },
  "devDependencies": {
    "@vscode/test-web": "*"
  }
}
```

Add `.vscode-test-web/` to the repo ignore list once the extension package is
created.

For desktop-local development, use VS Code's standard Extension Development
Host and verify Ubuntu local conversion with:

- bundled/configured native module;
- native module downloaded from release assets;
- configured `ar5iv.latexmlOxidePath` fallback;
- executable discovered on `PATH` fallback;
- missing native module/executable with download disabled;
- missing native module/executable with Ubuntu download enabled;
- unsupported platform behavior.

For final web sanity checks before publishing, sideload the web bundle into
`vscode.dev` from an HTTPS local/static server. This validates the real browser
extension host, but local `@vscode/test-web` should remain the primary browser
development loop because it is easier to debug.

## MVP Milestones

1. Define the shared normalized conversion response shape.
2. Define `RuntimeCapabilities` and the `ConversionProvider` boundary.
3. Add `vscode-extension/` with tiny desktop and browser entry points.
4. Implement the shared `activateAr5ivExtension` app shell.
5. Implement `ar5iv: Open Preview` in shared code.
6. Define and implement the native `latexml-oxide` binding contract.
7. Make single-file live conversion work on Ubuntu through the native binding.
8. Add executable fallback with a configured local `latexml-oxide` path.
9. Add executable auto-detection on `PATH`.
10. Add opt-in GitHub release asset download for missing Ubuntu native modules
   or executable fallbacks.
11. Render conversion results in a VS Code webview.
12. Add stale-response handling.
13. Add editor-to-preview scroll sync.
14. Add preview-to-editor source navigation.
15. Add VS Code diagnostics.
16. Add browser/backend provider using the existing ar5iv backend.
17. Add `@vscode/test-web` scripts and tests for browser mode.
18. Add `/vscode` as an experiment route on `latexml.rs`.
19. Revisit CORS/Anubis/deployment rules for public web use.

## Open Questions

- Should the extension create a backend session per VS Code workspace, per
  editor tab, or per preview panel in browser/backend mode?
- What native ABI should `latexml-oxide` expose for extension use: N-API addon,
  C ABI shared library, or another stable wrapper?
- Which crate should own the shared converter contract so backend, CLI, and VS
  Code stay aligned?
- Should the normalized boundary be specified first in TypeScript, Rust, or a
  schema file that generates both?
- Where should downloaded Ubuntu native modules/executables live, and how long
  should the extension retain old versions?
- What checksum/signature format should release assets publish before the
  extension is allowed to execute a downloaded binary?
- How should multi-file projects map to backend sessions when opened from
  `vscode.dev` virtual workspaces?
- Should native local mode copy the entire workspace into a temp conversion
  directory, or pass an in-memory source overlay plus workspace search paths?
- Should `/vscode` eventually self-host VS Code web, or should it remain a
  launcher/sideloading page for the published extension?
- What subset of the local VS Code demo should `latexml.rs/vscode` guarantee:
  single-file editing, virtual workspace files, examples, or full upload/export?
- Which VS Code APIs differ enough between desktop and web to require a small
  abstraction: asset URIs, workspace files, settings storage, or webview CSP?
- How should public deployments distinguish browser-editor traffic from VS Code
  extension API traffic for rate limits and Anubis challenges?

## Recommended First Implementation

Keep the first pass intentionally narrow:

1. Ubuntu desktop only;
2. one active `.tex` file;
3. one preview panel;
4. native `latexml-oxide` binding;
5. HTML preview render;
6. basic diagnostics;
7. single-file source sync.

After that works in desktop VS Code on Ubuntu, add executable fallback,
auto-detection, opt-in download, browser/backend mode, multi-file support, and
the `/vscode` route.
