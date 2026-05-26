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

## Decisions

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
