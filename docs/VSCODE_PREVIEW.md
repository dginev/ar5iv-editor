# VS Code Preview Architecture

This document defines the architecture for an ar5iv VS Code experience that can
run as:

- a desktop VS Code extension on Ubuntu, using local `latexml-oxide`;
- a browser VS Code experience at `latexml.rs/vscode`, using the hosted ar5iv
  backend;
- a local browser demo, using the same hosted-backend path as production.

The goal is not to build a second editor. The goal is to make VS Code the
editor surface while reusing one ar5iv preview, diagnostics, source-map, and
conversion lifecycle model across local and web deployments.

> **Plan revision (2026-05-26).** Per direction, the build order was flipped to
> *preview fidelity first, then a self-hosted VS Code for the Web workbench at
> `/vscode`*, and a hard requirement was added: **maximize reuse across the three
> preview surfaces** — `/editor` (CodeMirror), `/vscode` (browser VS Code), and
> the local desktop "code" plugin — rather than maintaining parallel
> implementations. The shared logic now lives in a framework-agnostic
> `frontend-core/` package consumed by all three. See the
> "2026-05-26 Shared Core" handoff section at the end for the implemented state.

## Decisions

0. **One shared `frontend-core/` across all three surfaces.**
   The preview rendering (shadow-DOM ar5iv stylesheet stack, idiomorph
   re-render), the precision source-map sync in both directions, the
   reverse-nav content recovery, source-locator parsing, and the convert-request
   shaping (preamble split, document/fragment detection, preload sets) are
   framework-agnostic and must not be duplicated. They live in `frontend-core/`
   with no bundler-resolved dependency (idiomorph is injected). `/editor` and the
   VS Code webview are thin adapters that supply only environment specifics:
   the color-token → theme-var mapping, stylesheet URLs, and navigation glue.

1. **One shared VS Code app core.**
   Desktop and browser builds must share command registration, document
   tracking, debounce, preview webview, source sync, diagnostics, logging, and
   stale-response handling.

2. **Thin deployment adapters.**
   Desktop and browser entry points only detect capabilities, construct a
   conversion provider, and call the shared activation function.

3. **Native local conversion first.**
   The desktop Ubuntu extension should use a native `latexml-oxide` integration
   in the steady state. Per-conversion process spawning is a fallback, not the
   target architecture.

4. **Hosted conversion for browser VS Code.**
   Web extensions cannot execute local binaries or load native modules. The
   `latexml.rs/vscode` deployment must use the hosted ar5iv backend.

5. **Same conversion boundary everywhere.**
   Native, executable fallback, and hosted backend conversion must all implement
   the same normalized request/response contract. The preview layer must not
   know which provider produced the HTML.

6. **Ubuntu only for local native MVP.**
   Other desktop platforms are explicitly out of scope until the Ubuntu
   integration and packaging story are proven.

## Non-Goals

- Reimplement the current CodeMirror editor inside VS Code.
- Make `/vscode` replace `/editor`.
- Support all VS Code platforms in the first release.
- Self-host a full VS Code web workbench before the extension architecture is
  stable.
- Silently download or execute converter binaries.

## Existing Assets

The current app already has reusable backend and frontend pieces:

- `POST /api/user` mints an anonymous user token.
- `POST /api/session` opens a per-user session/slot.
- `PUT /api/session/{id}/files/{path}` writes source into the session.
- `GET /api/session/{id}/files/{path}` reads session files.
- `GET /api/session/{id}/files` lists files and returns the session version.
- `GET /api/version` exposes build/version metadata.
- `WebSocket /convert?session_id=...&user_id=...` performs hosted conversion.
- `frontend/src/ws.ts` defines the current conversion wire types.
- `frontend/src/session.ts` wraps the hosted session/file API.
- `frontend/src/preview.ts` contains preview and source-map behavior.
- `frontend/src/main.ts` has the current debounce, stale-response, diagnostics,
  and source-sync logic.

The VS Code work should extract concepts from these files, not copy the
CodeMirror application wholesale.

## Target Shape

```text
                 shared VS Code app core
 command registration / document tracking / preview webview
 diagnostics / source sync / logs / stale-response handling
                            |
                    ConversionProvider
                            |
        ------------------------------------------------
        |                      |                       |
 native latexml-oxide    executable fallback      hosted backend
 desktop Ubuntu          desktop Ubuntu           web + latexml.rs/vscode
```

Only the bottom row is deployment-specific. Everything above
`ConversionProvider` is shared.

## Runtime Boundary

The extension should expose a small runtime adapter to the shared app:

```ts
interface RuntimeCapabilities {
  readonly deployment: "desktop" | "web";
  readonly canLoadNativeConverter: boolean;
  readonly canRunExecutableFallback: boolean;
  readonly canUseHostedBackend: boolean;
  readonly defaultBackendUrl?: string;
}

interface RuntimeServices {
  readonly capabilities: RuntimeCapabilities;
  createConversionProvider(): Promise<ConversionProvider>;
  asWebviewUri(uri: vscode.Uri): vscode.Uri;
}
```

The desktop entry point provides native-module loading and optional executable
fallback. The browser entry point provides hosted-backend configuration. Both
entry points should be small:

```ts
export async function activate(context: vscode.ExtensionContext) {
  const runtime = await createRuntimeServices(context);
  return activateAr5ivExtension(context, runtime);
}
```

## Conversion Boundary

Every conversion mode implements this conceptual provider:

```ts
interface ConversionProvider {
  readonly mode: "native" | "executable" | "backend";
  openProject(project: ProjectHandle): Promise<ConversionSession>;
  dispose(): Promise<void>;
}

interface ConversionSession {
  convert(request: NormalizedConvertRequest): Promise<NormalizedConvertResponse>;
  cancel?(id: number): Promise<void>;
  dispose(): Promise<void>;
}
```

The normalized request should contain:

- monotonic request id;
- active document URI and provider-specific project path;
- current document text as an in-memory overlay;
- project/workspace root when available;
- preamble/profile/format/preload/source-map options;
- version or content revision used for stale-response rejection.

The normalized response should contain:

- request id and revision echo;
- status and status code;
- rendered HTML fragment;
- diagnostics with file/line/column metadata;
- source-map `sources` and source positions;
- converter log;
- timing breakdown;
- converter version/capability metadata.

This boundary is the architectural contract. The native binding, executable
fallback, and hosted backend are adapters into it.

## Desktop Native Provider

The Ubuntu desktop provider should integrate with `latexml-oxide` through a
native boundary, not through a CLI text protocol.

Preferred options:

- Node native addon using N-API.
- Shared library with a small N-API wrapper.

Acceptable temporary option:

- A long-lived helper process with a structured protocol. This avoids
  per-keystroke startup cost, but should be treated as a bridge toward the
  native binding.

The native contract should support:

- create/dispose converter instance;
- warm converter reuse across edits;
- convert active file plus in-memory source overlay;
- project root and search paths;
- preamble/profile/format/preload/source-map options;
- structured HTML/diagnostics/source-map/log/timing result;
- cancellation or supersession when a newer edit arrives;
- converter version and capability reporting.

The native API should be designed with `latexml-oxide` so the backend, CLI, and
VS Code extension do not diverge into separate conversion semantics.

## Executable Fallback

An executable fallback is useful for early adoption, debugging, and recovery
when the native module is unavailable. It should not define the primary
architecture.

Fallback behavior:

1. Resolve `ar5iv.latexmlOxidePath`.
2. Search `PATH`.
3. Search extension-managed install storage.
4. If missing, prompt for manual installation or opt-in download.
5. Run with structured machine-readable output if the CLI supports it.
6. Normalize the result into `NormalizedConvertResponse`.

If the CLI cannot emit structured diagnostics/source maps/timings, add that
contract to `latexml-oxide` before relying on the fallback for serious testing.
Parsing human-oriented stderr is not acceptable beyond throwaway prototypes.

## Hosted Backend Provider

The browser provider implements the same `ConversionProvider` contract but
translates requests to the existing hosted routes:

- `POST /api/user`;
- `POST /api/session`;
- `PUT /api/session/{id}/files/{path}`;
- `WebSocket /convert?session_id=...&user_id=...`.

This provider powers:

- local `@vscode/test-web` development;
- `latexml.rs/vscode`;
- any future browser VS Code deployment.

The hosted provider must not grow UI-specific behavior. It is a transport
adapter only.

## Extension Package Layout

Proposed package:

```text
vscode-extension/
  package.json
  tsconfig.json
  esbuild.desktop.js
  esbuild.web.js
  src/
    desktop/
      extension.ts
      runtime.ts
      nativeProvider.ts
      executableProvider.ts
      installer.ts
    web/
      extension.ts
      runtime.ts
      backendProvider.ts
    shared/
      app.ts
      runtime.ts
      conversionProvider.ts
      conversionTypes.ts
      documentModel.ts
      previewPanel.ts
      sourceSync.ts
      diagnostics.ts
      debounce.ts
```

The VS Code manifest should expose both `main` and `browser`:

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
          "default": "https://latexml.rs",
          "description": "Base URL for hosted conversion in browser mode."
        },
        "ar5iv.nativeLatexmlOxidePath": {
          "type": "string",
          "default": "",
          "description": "Absolute path to a native latexml-oxide module. Empty means bundled or extension-managed."
        },
        "ar5iv.disableNativeLatexmlOxide": {
          "type": "boolean",
          "default": false,
          "description": "Disable the native converter and use fallback conversion."
        },
        "ar5iv.latexmlOxidePath": {
          "type": "string",
          "default": "",
          "description": "Absolute path to a latexml-oxide executable fallback."
        },
        "ar5iv.allowDownloadLatexmlOxide": {
          "type": "boolean",
          "default": false,
          "description": "Allow explicit download of supported Ubuntu latexml-oxide assets."
        }
      }
    }
  }
}
```

## Live Conversion Lifecycle

The shared app owns the lifecycle:

1. User opens a `.tex` document.
2. User runs `ar5iv: Open Preview`.
3. Shared app opens a `ConversionSession`.
4. Shared app creates a preview webview beside the editor.
5. Text edits are debounced.
6. Debounce tail captures document revision, cursor/source context, and text.
7. Shared app calls `session.convert(...)`.
8. Response is accepted only if id and revision are still current.
9. Preview webview receives rendered HTML and source-map metadata.
10. Diagnostics are published to VS Code.
11. Source-scroll request is applied if this was an edit-driven conversion.

Provider-specific file handling happens below the boundary:

- Native provider may pass an in-memory overlay plus workspace search paths.
- Executable provider may materialize a temporary project tree.
- Hosted provider writes the active file to the backend session before sending
  the WebSocket request.

## Source Sync

Editor-to-preview:

1. Capture active URI, line, column, token, and revision at debounce time.
2. Convert with source-map enabled.
3. After the matching response renders, ask the webview to scroll to the
   matching source location.

Preview-to-editor:

1. Webview decodes the clicked `data-sourcepos` location.
2. Webview posts a `revealSource` message.
3. Shared app resolves source tag to URI.
4. Shared app opens/reveals the document and selects the best range.

MVP may resolve only the active document. Multi-file source resolution should be
designed into the data model from day one, even if implemented later.

## Diagnostics

Map converter diagnostics into `vscode.Diagnostic`:

- `fatal` and `error` -> `DiagnosticSeverity.Error`;
- `warning` -> `DiagnosticSeverity.Warning`;
- `info` -> `DiagnosticSeverity.Information`.

Diagnostics must be keyed by document URI and conversion revision. A clean
newer conversion clears stale diagnostics for affected documents. Unanchored
diagnostics should appear in the preview/log UI and can later be mirrored into
an output channel.

## `/vscode` On `latexml.rs`

The `/vscode` route should start as a deployment of the browser build, not as a
separate app.

Initial shape:

- `GET /vscode` serves an experiment/launcher page.
- Static extension assets are served from a versioned path.
- The browser build is configured with `https://latexml.rs` as backend URL.
- The hosted provider uses the same `/api/*` and `/convert` routes as `/editor`.

Do not self-host or fork the VS Code web workbench until the extension works in
`@vscode/test-web` and the public hosting requirements are clear.

## Backend Requirements For Browser Mode

The desktop native provider does not need the ar5iv backend. Browser mode does.

Required backend work:

- CORS for `/api/*` from approved VS Code web origins.
- WebSocket origin policy for `/convert`.
- Support for `x-ar5iv-user` in cross-origin requests.
- HTTPS/WSS only for public use.
- Anubis or rate-limit policy that does not break extension API traffic.
- Clear failure responses for blocked origin, expired session, and quota.

Security posture:

- Treat session/user ids as bearer credentials.
- Do not allow arbitrary file paths outside a session root.
- Keep download/install of local converter assets out of browser mode entirely.

## Ubuntu Download Policy

The extension may offer opt-in download for Ubuntu assets only after release
assets include integrity metadata.

Minimum policy:

1. User explicitly enables download or clicks an install action.
2. Extension detects Ubuntu and architecture.
3. Extension selects a matching native module first.
4. Executable fallback is selected only if native asset is unavailable.
5. Asset is downloaded to extension global storage.
6. Checksum or signature is verified before load/execution.
7. Native ABI/version smoke check passes.
8. Resolved path is cached in extension global state.

No silent downloads. No execution of unverifiable assets.

## Phased Delivery

### Phase 0: Contract

- Define `NormalizedConvertRequest` and `NormalizedConvertResponse`.
- Define `RuntimeServices` and `ConversionProvider`.
- Decide where the contract lives: TypeScript first, Rust first, or schema
  generated into both.

### Phase 1: Desktop Native MVP

- Add `vscode-extension/` package.
- Add tiny desktop entry point.
- Implement shared `activateAr5ivExtension`.
- Implement one-preview-panel workflow for the active `.tex` document.
- Implement Ubuntu native provider against a local development native binding.
- Render HTML preview.
- Publish basic diagnostics.
- Support active-document source sync.

### Phase 2: Provider Hardening

- Add cancellation/supersession semantics.
- Add converter version/capability reporting.
- Add executable fallback only after structured CLI output exists.
- Add explicit Ubuntu asset download/install flow.
- Add tests for missing, incompatible, and manually configured converters.

### Phase 3: Browser Provider

- Implement hosted backend provider behind the same contract.
- Add web bundle and `@vscode/test-web` workflow.
- Verify the same shared app code runs in browser mode.
- Add backend CORS/WebSocket origin support for approved development origins.

### Phase 4: `latexml.rs/vscode`

- Add `/vscode` route.
- Serve versioned browser extension assets.
- Configure production backend URL.
- Validate Anubis/rate-limit behavior for extension API traffic.
- Decide whether a self-hosted VS Code web workbench is justified.

### Phase 5: Multi-File Projects

- Resolve `\input`, graphics, and bibliography assets.
- Decide between workspace overlays and temporary project materialization.
- Support source-map navigation across files.
- Add project/session lifetime policy.

## Critical Risks

- **Native binding complexity.** N-API packaging, ABI stability, and Rust panic
  boundaries need deliberate design.
- **Contract drift.** Backend, CLI, native binding, and extension can diverge
  unless the normalized contract is shared and tested.
- **Source-map fidelity.** Preview/editor sync is only as good as source
  metadata. Imperfect locations need graceful recovery.
- **Web security policy.** `latexml.rs/vscode` depends on correct CORS,
  WebSocket origins, CSP, and rate limiting.
- **Asset trust.** Downloaded converter assets require checksums/signatures and
  explicit user consent.
- **Performance regression.** The native provider must preserve warm converter
  state; otherwise local VS Code will feel worse than `/editor`.

## Open Questions

- Should the normalized contract be owned by a Rust crate, a TypeScript package,
  or a schema that generates both?
- What exact native ABI should `latexml-oxide` expose?
- Can the converter accept in-memory source overlays, or must every conversion
  materialize a project tree?
- What structured output should the CLI fallback expose?
- Which VS Code webview APIs require abstraction across desktop and web?
- What subset of features should `latexml.rs/vscode` guarantee initially:
  examples, virtual files, uploads, export, or only active-file editing?
- Should `/editor` eventually consume the same normalized conversion contract,
  or remain independently wired to the current frontend protocol?

## Recommended First Cut

Start with the smallest path that validates the architecture:

1. Ubuntu desktop VS Code only.
2. One active `.tex` document.
3. One preview panel.
4. Native `latexml-oxide` provider.
5. Shared app core with provider boundary already in place.
6. HTML preview, diagnostics, and active-document source sync.

Do not start with `/vscode`. Build the local native provider first because it
proves the hardest architectural decision. Add browser/backend mode only after
the shared app core is working against one real provider.

## Implementation Notes And Handoff

### 2026-05-26 Codex Progress

Reference checked:

- [`shd101wyy/vscode-markdown-preview-enhanced`](https://github.com/shd101wyy/vscode-markdown-preview-enhanced)
  is the closest UX precedent. The useful lessons for ar5iv are:
  command-driven preview opening, a persistent webview preview surface,
  editor/preview scroll sync as core behavior, broad configuration around one
  rendering core, and a privacy posture that is explicit about local vs remote
  execution. We should copy those architectural instincts, not its Markdown
  processing stack.

Files added so far:

- `vscode-extension/package.json`, `tsconfig.json`, `esbuild.desktop.js`,
  `esbuild.web.js`, `.vscodeignore`.
- `vscode-extension/src/shared/*`: normalized conversion contract, shared
  activation/app lifecycle, document request construction, diagnostics,
  preview webview, source reveal helpers, and hosted backend adapter.
- `vscode-extension/src/desktop/*`: desktop entry point, runtime provider
  selection, native-provider loader contract, and executable fallback stub.
- `vscode-extension/src/web/*`: web entry point and hosted-backend runtime.

Current implementation shape:

- `activateAr5ivExtension(context, runtime)` is shared across desktop and web.
- The preview is intentionally one-panel/active-document for the first cut.
- Stale responses are rejected by request id and VS Code document version.
- Diagnostics are normalized into `vscode.DiagnosticCollection`.
- Preview-to-editor navigation uses `data-sourcepos` in the webview and reveals
  the active document. Multi-file source resolution is still designed into the
  message payload but not implemented.
- Browser/hosted mode writes the active file to a blank hosted session, then
  sends the normal WebSocket convert request.
- Desktop `auto` mode starts the managed local backend first, then falls back
  to native and executable providers only if the backend provider is unavailable.
  Explicit `native` and `executable` modes remain available for testing.

Important caveats for the next agent:

- The native N-API module does not exist yet. The loader expects a module that
  exports `createConversionProvider()`.
- The hosted backend provider only overlays the active file. It does not yet
  upload workspace dependencies (`\input`, graphics, `.bib`, `.bbl`).
- The preview webview currently injects converter HTML directly. This matches
  trusted local/hosted ar5iv output assumptions, but a production web extension
  should add a sanitizer or a stricter ar5iv-output trust boundary before
  exposing arbitrary remote conversion responses.
- The `/vscode` Rust route is wired as a launcher/status page. It does not
  yet serve a browser VS Code workbench or versioned extension assets.
- `Cargo.lock` was dirty before this work started and should not be reverted
  without checking with the user.

### 2026-05-26 Critical Review

Critical gaps:

- **The first test path is the managed backend, not native mode.** The desktop
  runtime has a native-loader contract, but no N-API module exists yet. Local
  testing should use desktop `auto` mode and a bundled or development
  `ar5iv-editor` server binary.
- **Hosted mode only writes the active file.** `\input`, graphics,
  bibliography files, and generated `.bbl` dependencies are not uploaded from
  the workspace. Single-file examples are the only reliable test cases.
- **Session expiry is not recovered.** The web editor catches
  `session_expired` and reopens the slot. The VS Code hosted provider currently
  turns a 410 into a fatal preview/log message and stays stuck until the
  provider/session is recreated.
- **Provider startup errors are only partially polished.** `openPreview()` now
  routes startup through the guarded conversion path, so failures can render in
  the preview panel, but the UI still needs a targeted recovery action such as
  opening the server output channel.
- **The preview HTML is trusted too broadly.** CSP blocks scripts, but the
  webview still injects converter HTML directly with `innerHTML`. Before public
  browser use, add a sanitizer or a stricter ar5iv-output trust boundary.

UI sharp edges:

- **The VS Code preview is not visually equivalent to `/editor`.** It does not
  yet load the same ar5iv CSS/font stack inside the webview, so output can look
  more like raw LaTeXML HTML than the web editor showcase.
- **No visible controls beyond status.** There is no refresh button, provider
  indicator, log toggle, source-sync toggle, or quick link to extension
  settings. Markdown Preview Enhanced is a useful precedent here: keep the
  preview surface simple, but expose the expected preview commands around it.
- **Status is too terse.** Conversion failures collapse into `error` plus raw
  log text. Users need a short actionable message such as "backend unreachable",
  "session expired", or "native converter missing".
- **Scroll sync is approximate.** Editor-to-preview chooses the closest source
  line and preview-to-editor resolves only the active document. Multi-file
  source positions are carried in the payload but not implemented.
- **No output affordance.** The output channel receives logs, but the user is
  not prompted or given a command to open it when conversion fails.

Recommended next fixes before expanding scope:

1. Keep managed backend mode as the documented local MVP and add a command or
   status action that shows the active provider/backend URL.
2. Mirror `/editor` preview styling in the webview using packaged CSS assets
   and `asWebviewUri`.
3. Add hosted-provider session-expiry recovery and a backend health check at
   provider creation.
4. Upload a conservative workspace dependency set for hosted mode:
   `.tex`, `.sty`, `.cls`, `.bib`, `.bbl`, and common image formats.
5. Add a real preview toolbar: refresh, open log, reveal source toggle, and
   provider/status indicator.

### 2026-05-26 Diagnostics Marker Update

- VS Code diagnostics now mirror the web editor more closely: info-level engine
  chatter is filtered out of editor markers, diagnostics are matched to the
  active buffer by path, basename, or stem, and one-based engine line/column
  locations are converted into clamped VS Code ranges.
- Zero-width or column-only converter locations are expanded to a visible range
  so errors get the normal VS Code squiggle/gutter marker while editing.
- Multi-file diagnostic routing is still not complete. Diagnostics whose source
  does not match the active buffer are kept visible on line 1 instead of being
  mapped to other workspace files.

### 2026-05-26 Diagnostics Anchoring Rule

- Diagnostics now use a two-tier placement rule in the VS Code extension:
  active-source diagnostics with a positive source line are placed inline at
  the reported token-locator line; diagnostics without a clear active-file
  source identity or positive line are still shown, but anchored visibly at
  line 1.
- This keeps global/ambiguous converter messages visible without pretending
  their engine-internal line numbers refer to the user document. Inline errors
  such as an undefined `\foo` should land at the actual source line when the
  backend was built with `token-locators` and conversion runs with source maps
  enabled.

### 2026-05-26 Anonymous Source Diagnostic Adjustment

- Positive-line diagnostics from `Anonymous String` are now treated as active
  document diagnostics. This matches the web editor behavior and avoids moving
  real token-locator errors to line 1 just because the converter source label is
  weak. Diagnostics still fall back to line 1 when they have no positive source
  line or point at a non-active file.



### 2026-05-26 Managed Local Server Packaging

- Desktop auto mode now prefers a managed backend provider. On first preview it
  starts a local `ar5iv-editor` server, points the hosted-backend transport at
  that localhost URL, and registers disposal with the VS Code extension context
  so the child process is terminated when the extension host shuts down.
- The managed server chooses an ephemeral `127.0.0.1` port, sets
  `AR5IV_EDITOR_BIND` to that port, stores sessions under extension global
  storage, waits for `GET /api/version`, and streams stdout/stderr into the
  `ar5iv Server` output channel.
- Binary resolution order is `ar5iv.serverPath`,
  `vscode-extension/bin/ar5iv-editor`, `target/release/ar5iv-editor`, then
  `target/debug/ar5iv-editor`. The packaged/self-contained path is the `bin/`
  binary; the target paths are development conveniences only.
- `npm run build:server` builds `ar5iv-editor` in release mode and copies it
  into `vscode-extension/bin/`; `npm run build:all` builds both the server and
  the desktop/web extension bundles. `npm run package:vsix` runs the full build
  and emits `ar5iv-vscode.vsix`. `.vscodeignore` explicitly includes
  `bin/**` for VSIX packaging.
- `ar5iv.managedServer.enabled=false` keeps the previous hosted-backend testing
  path available through `ar5iv.backendUrl`. Browser/web extension mode still
  uses the hosted backend and cannot start local processes.

Remaining managed-server gaps:

- We have not added platform-specific packaging metadata yet. The current
  bundled binary path assumes the package is built on the target platform, so
  cross-platform VSIX distribution still needs per-platform artifacts or
  extension-target filtering.
- The backend upload/session limitations remain: active-file-only upload, no
  automatic session-expiry recovery, and no workspace dependency sync.
- Startup failure is surfaced through the preview/log path, but the preview
  panel still needs a polished user-facing recovery state with an action to
  open the `ar5iv Server` output channel.

### 2026-05-26 Shared Core, Preview Fidelity, and Web Workbench

This is the current authoritative state; earlier handoff notes above describe
the path here.

**Shared `frontend-core/` (repo root).** One framework-agnostic package, zero
bundler-resolved dependencies (idiomorph is injected by each adapter), consumed
by all three surfaces:

- `host.ts` — shadow-DOM host + the structural ar5iv CSS (the environment-
  independent half) + theme switching + idiomorph render + empty state.
- `forward-sync.ts` — `scrollPreviewToSource`: reading-order anchor + content-
  fingerprint refinement; arrival flash via the CSS Custom Highlight API.
- `reverse-sync.ts` — `bindPreviewSourceNav`: double-click → `{tag,line,col,
  word,text}`.
- `recover.ts` — `recoverSourcePosition` (pure; runs in the browser *and* the
  VS Code extension host for reverse-nav).
- `sourcepos.ts` — locator parsing + tag/basename resolution.
- `convert.ts` — preamble split, document/fragment detection, preload sets.
- `preview.ts` / `index.ts` — the `createPreview(config)` controller + package
  entry.

Adapters:

- `frontend/src/preview.ts` — web editor adapter: chrome-theme token mapping,
  `/static/css/...` URLs, idiomorph + KaTeX fallback. Keeps its prior public
  API, so `frontend/src/main.ts` was only trimmed (its `recoverSourcePosition`,
  `splitPreamble`, `hasDocumentclass`, and inline preload lists now come from
  `frontend-core`).
- `vscode-extension/src/webview/preview.ts` — VS Code webview adapter:
  `--vscode-*` token mapping, `asWebviewUri` stylesheet URLs (via a bootstrap
  JSON), idiomorph, plus the toolbar / status / timings / live "converting (Xs)"
  ticker / loading watermark / log toggle chrome.

Regression gates: `frontend` Vite build, `vscode-extension` `npm run typecheck`
+ `npm run build`, `cargo build -p ar5iv-editor-server`, and the touched
integration tests all pass. (`tests/search_paths_de_risk.rs` fails on pre-
existing latexml API drift, unrelated to this work.)

**Preview fidelity (both VS Code deployments).** The webview now renders inside
a shadow root carrying the same `ar5iv.css` + `ar5iv-fonts.css` stack as
`/editor` (bundled into `vscode-extension/media/` by `npm run build:assets`),
maps ar5iv color tokens onto the active VS Code theme, morphs with idiomorph,
runs the full two-way source-map sync, and shows a timings breakdown + backend
version footer (`/api/version`, plumbed through the hosted provider). Math
relies on native MathML (Chromium webview); KaTeX fallback is editor-only.

**Self-hosted `/vscode` workbench.** The official VS Code Web "web-standalone"
build is vendored by `vscode-extension/scripts/fetch-vscode-web.mjs`
(`npm run fetch:vscode-web`; pinned version + sha256; extracts to repo-root
`vscode-web/`, gitignored). The server serves it at `/vscode-static`, the
extension root at `/vscode-ext`, and renders the standalone `workbench.html` at
`/vscode` with an injected `IWorkbenchConstructionOptions` that (a) loads the
ar5iv extension as an `additionalBuiltinExtension`, (b) sets
`ar5iv.backendUrl` to this origin via `configurationDefaults`, and (c) points
the webview endpoint at `/vscode-static`. Config paths: `AR5IV_VSCODE_WEB_DIR`,
`AR5IV_VSCODE_EXT_DIR`. When the build isn't vendored, `/vscode` degrades to a
launcher page with the fetch instructions. HTTP-level serving is verified
(workbench HTML + config injection, `/vscode-static/out/nls.messages.js`,
`/vscode-ext/{package.json,dist/web/extension.js,media/preview.js}` all 200).

Remaining for `/vscode`:

- **In-browser validation pending.** The workbench boot, extension activation,
  and webview rendering have not been exercised in a real browser yet (no
  headless browser in the work environment). This is the next concrete step.
- **Webview origin isolation.** `webEndpointUrlTemplate` is set to the same
  origin (no `{{uuid}}` subdomain, since self-hosting has no wildcard DNS).
  This is the most likely thing to need tuning during browser validation;
  options include a fixed webview subdomain or COOP/COEP headers.
- **No sample file / filesystem.** The workbench opens an empty `tmp:`
  workspace. A memfs provider (cf. `@vscode/test-web`'s `fs-provider`) seeding
  an example `.tex` + opening the preview would make the demo self-explanatory.
- **`/vscode-ext` serves the whole extension dir.** Fine for a demo; a pruned
  served copy (package.json + `dist/web` + `media`) is the hardening step.

Carried-over gaps (unchanged): native N-API provider does not exist; hosted
mode uploads only the active file (no `\input`/graphics/`.bib`/`.bbl` sync) and
has no session-expiry recovery; multi-file reverse-nav resolves by workspace
basename search only; cross-platform VSIX packaging needs per-target artifacts.

## Plug-And-Play Distribution Roadmap

**Goal:** a single extension installation on any OS that, with default settings,
lets a user instantly preview any `.tex` — no manual toolchain, no LaTeX
install, no terminal. Install → enable → preview.

### Conversion backend dependency analysis (2026-05-26)

The managed-server path runs the self-contained `ar5iv-editor` HTTP server
(~53 MB release; latexml-oxide compiled in as a Rust library). Its real runtime
needs:

- **Shared C libraries** (dynamically linked): `libxml2`, `libxslt`/`libexslt`,
  `libkpathsea`. The `-dev` headers are build-time only; runtime needs just the
  `.so`/`.dylib`/`.dll`. Present on most Linux/LaTeX machines; absent on bare
  macOS/Windows.
- **A texmf tree** for any package latexml-oxide has no hand-written Rust
  binding for: `find_file` falls back to `kpathsea` → system TeX Live. Common
  packages (article, amsmath, ar5iv, …) are bound and need no texmf; long-tail
  packages do.

So a single downloaded binary is *not* self-sufficient on a bare system.

### Current state (shipped, Linux) — 2026-05-26

Plug-and-play is **live and verified** on Linux x86_64: *Install Extension →
ar5iv-editor → Reload Window → preview*, with no settings.

- Linux x86_64 only, `assume system libs + TeX Live present` (target audience:
  LaTeX authors). On first activation the plugin downloads the prebuilt,
  self-contained `ar5iv-editor` server release into extension global storage,
  sha256-verifies it (against the published `.sha256`), caches it, and
  auto-starts it (managed server). Default-on; `ar5iv.serverPath` /
  `ar5iv.serverDownloadBaseUrl` override.
- The VSIX is ~82 KB (no bundled binary). The download is structured
  **per-platform** from day one: it resolves
  `ar5iv-editor-<SERVER_VERSION>-<target-triple>.tar.gz`, ships
  `x86_64-unknown-linux-gnu` today, and reports a clean "not yet available for
  your platform" otherwise. Adding an OS later is purely a new release asset —
  no plugin change.
- First published backend release: **`0.2.0`** (the portable glibc-2.35 CI
  build). Verified end-to-end: download from the default URL → checksum match →
  extract → the published binary runs and serves `/api/version`.

### Releasing the backend

Cutting a server release requires **three version points to agree**:
`SERVER_VERSION` in `vscode-extension/src/desktop/managedServer.ts`, the
workspace `Cargo.toml` `version`, and the pushed git tag (`X.Y.Z`, bare
numeric). Then:

1. `tools/make-server-release.sh` — local dry build (tarball + `.sha256`).
2. Push the `X.Y.Z` tag → `.github/workflows/release.yml` builds on ubuntu-22.04
   (glibc 2.35) and publishes the assets.
3. **CI requires the `LATEXML_OXIDE_TOKEN` repo secret** — a fine-grained PAT
   with `Contents:read` on `dginev/latexml-oxide`. latexml-oxide is a *private*
   path dependency, so the default `GITHUB_TOKEN` cannot check it out (the run
   otherwise fails at "checkout latexml-oxide: repository not found").
   `workflow_dispatch` runs a dry build (no publish) and lets you pick the
   latexml-oxide ref.

### Path to full plug-and-play (no system prerequisites)

This is mostly **latexml-oxide / `ar5iv-editor` build work** (the engine), not
plugin work; the plugin's download/cache/auto-start is already in place.

1. **Statically link the third-party C deps, per OS.**
   - Linux: `x86_64-unknown-linux-musl` → a *fully* static binary (musl libc +
     libxml2/libxslt/kpathsea built from source). One file, any Linux.
   - macOS: `libSystem` cannot be statically linked (Apple), but it is always
     present; statically link the three third-party libs → self-contained in
     practice. Ship `aarch64-apple-darwin` + `x86_64-apple-darwin`.
   - Windows: link the C deps against the static CRT → self-contained `.exe`.
2. **Bundle a curated texmf subset** with the release and point kpathsea at it
   (`TEXMFHOME`/`texmf.cnf` in global storage), so common unbound packages
   resolve with no system TeX Live. Long-tail packages still degrade to a
   system texmf if one exists. Sizing the subset (ar5iv + the most-used arXiv
   packages) is the main judgement call.
3. **Per-OS release matrix.** Tag-triggered CI builds the static binary + texmf
   bundle for each target triple and publishes them as release assets with
   `.sha256` sidecars. The plugin already selects by triple.
4. **Acquisition trust.** Verify `.sha256` (and ideally a signature) before
   chmod/execute; pin the release version in the extension; keep an opt-out
   (`ar5iv.serverDownload=false` + `ar5iv.serverPath`).

### Alternative considered: native N-API module

A native `latexml-oxide` N-API addon (loaded in-process by the extension)
removes the localhost server hop and the spawn, but multiplies the
static-linking/texmf-bundling problem across Node ABIs and OSes, and still needs
the texmf tree. The managed self-contained server is the simpler portable unit;
keep the native module as a later optimization, not the portability strategy.
