# ar5iv-editor

A web-based LaTeX editor with a live preview, written in Rust. The successor
to the Perl/Mojolicious
[ltxmojo](https://github.com/dginev/LaTeXML-Plugin-ltxmojo).

The browser sends LaTeX source over a WebSocket; the server runs
[`latexml-oxide`](https://github.com/dginev/latexml-oxide) (a pure-Rust
LaTeXML port) and streams back HTML5 + native MathML, which the browser
morphs into the preview pane. The preview is styled with
[ar5iv-css](https://github.com/dginev/ar5iv-css) so the result reads like an
arXiv HTML page.

## Status

**v0.2.0 — file panel UI.** End-to-end pipeline is real (no stub): every
keystroke runs through `latexml-oxide`, post-processes XMath into MathML,
applies the bundled HTML5 XSLT, and morphs the result into the preview.
v0.2 ships:

- Three-pane shell (files / source / preview) with draggable resizers.
- Per-user, per-slot anonymous sessions backed by tmpdirs. Each example
  the user opens lives in its own scratch directory and survives until
  10 minutes of inactivity.
- File panel: tree, click-to-open, multi-buffer editor with cursor /
  scroll / undo preserved per file, single-file + folder upload, ZIP /
  tar.gz import as new project, ZIP export of the whole project.
- Engine diagnostics surfaced inline: line-anchored ones light up
  CodeMirror's lint gutter, unanchored ones attach to a header badge.
- Disk and URL identity decoupled: 256-bit OsRng tokens, the on-disk
  directory name is unrelated to the URL-visible session id, logs
  redact through a request-id (no token bytes in plaintext).

Expect ongoing rough edges around package coverage; see *Known gaps*.

## Stack

| Layer         | Choice                                                       |
|---------------|--------------------------------------------------------------|
| Server        | Rust, [Axum 0.8](https://github.com/tokio-rs/axum) on Tokio  |
| LaTeX→HTML    | `latexml-oxide` on a dedicated 256 MB-stack worker thread    |
| Templating    | [Askama](https://github.com/askama-rs/askama) (compile-time) |
| Transport     | Single WebSocket at `/convert`, JSON text frames             |
| Editor        | [CodeMirror 6](https://codemirror.net/) + `codemirror-lang-latex` |
| Editor themes | One Dark (dark) / GitHub Light (light), Compartment-swapped  |
| Preview       | Shadow DOM + [ar5iv-css](https://github.com/dginev/ar5iv-css) |
| DOM updates   | [Idiomorph](https://github.com/bigskysoftware/idiomorph)     |
| Math render   | Native browser MathML, KaTeX as a fallback                   |
| Bundler       | Vite + TypeScript                                            |
| VS Code preview | Extension package in `vscode-extension/`, bundled with esbuild |

## Layout

```
ar5iv-editor/
├── Cargo.toml                              workspace
├── rust-toolchain.toml                     pins nightly (latexml-oxide req)
├── .cargo/config.toml                      bumps RUST_MIN_STACK for build
├── crates/
│   ├── ar5iv-editor-protocol/              shared wire types
│   └── ar5iv-editor-server/                Axum binary + lib
│       ├── src/
│       │   ├── main.rs, lib.rs             entrypoint + crate root
│       │   ├── config.rs, error.rs         tunables + AppError taxonomy
│       │   ├── routes.rs, ws.rs            HTTP + WebSocket handlers
│       │   ├── convert.rs                  latexml-oxide worker thread
│       │   ├── session.rs                  per-(user, slot) tmpdir registry
│       │   ├── files.rs                    file routes (CRUD + uploads)
│       │   ├── archive.rs                  ZIP + tar.gz unpack, ZIP export
│       │   ├── examples.rs                 embedded examples manifest
│       │   └── quota.rs                    size + count + per-IP guards
│       └── templates/                      Askama HTML templates
├── docs/
│   └── FileUI.md                           file-panel design (v1.2)
├── examples/                               shared example tree (server + frontend)
│   ├── _index.json                         manifest used by both sides
│   └── <slug>/main.tex                     one per example
├── deploy/                                 docker-compose + Anubis policy
├── vscode-extension/                       VS Code preview extension MVP
│   └── src/
│       ├── shared/                         app core, provider boundary, webview
│       ├── desktop/                        desktop runtime + native/fallback adapters
│       └── web/                            browser runtime + hosted backend adapter
└── frontend/                               Vite + TS + CodeMirror 6
    └── src/
        ├── main.ts                         bootstrap + convert chain
        ├── editor.ts                       CM6 multi-buffer editor
        ├── files.ts                        FilePanel (tree, uploads, export)
        ├── session.ts                      SessionClient (HTTP wrapper)
        ├── resizers.ts                     pane resizers
        ├── toast.ts                        small notification stack
        ├── ws.ts                           ConvertClient (WebSocket)
        ├── preview.ts                      shadow-DOM preview
        ├── examples.ts                     loads `examples/_index.json`
        └── styles.css                      chrome stylesheet
```

## Prerequisites

- Rust **nightly** (pinned in `rust-toolchain.toml`).
- `latexml-oxide` checked out at `~/git/latexml-oxide` — `Cargo.toml`
  references it via path dep until it ships as a crate. Adjust the
  `latexml = { path = "..." }` entries in
  `crates/ar5iv-editor-server/Cargo.toml` if your checkout lives elsewhere.
- Node 20+ and npm.
- A working TeX Live tree on `$PATH` (latexml-oxide uses `kpsewhich` to
  find raw `.sty`/`.cls` files for packages without a dedicated binding).

## Quick start (development)

Two terminals.

**Backend** (port 3000):

```sh
cargo run -p ar5iv-editor-server
```

**Frontend** (Vite dev server on port 5173, proxies `/convert`, `/about`,
`/help`, `/editor`, `/upload`, `/api`, `/static` to the backend):

```sh
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173/editor>. `GET /upload` is a standalone, no-preview
archive converter: pick or drag a single self-sufficient LaTeX archive (`.zip`,
`.tar.gz`, `.tgz`, or a bare `.gz`) and the converted ar5iv HTML5 is packaged as
a self-contained ZIP (`index.html` + ar5iv CSS + image assets, no LaTeX sources)
and auto-downloaded.

## VS Code extension local test

The VS Code extension is currently an MVP. Desktop auto mode starts a managed
local `ar5iv-editor` server by default, uses it for previews, and stops it when
the VS Code extension host exits.

1. Build the bundled server binary and extension:

```sh
cd vscode-extension
npm install
npm run build:all
```

To produce an installable VSIX after testing, run `npm run package:vsix` from
`vscode-extension/`; the VSIX includes `bin/ar5iv-editor`.

For a faster development loop after the Rust server binary already exists, use
`npm run build`. The managed server resolves binaries in this order: configured
`ar5iv.serverPath`, `vscode-extension/bin/ar5iv-editor`,
`target/release/ar5iv-editor`, then `target/debug/ar5iv-editor`.

2. Open a VS Code extension development host from the repository root:

```sh
cd ..
code --extensionDevelopmentPath="$(pwd)/vscode-extension" examples/equations
```

3. Open `main.tex`, run `ar5iv: Open Preview` from the Command Palette, then
edit the source. The extension starts a localhost backend automatically. The
`ar5iv Server` output channel shows the selected binary, backend URL, and
server logs. Diagnostics should appear in VS Code Problems and in the editor
gutter.

Optional settings:

```json
{
  "ar5iv.managedServer.enabled": true,
  "ar5iv.serverPath": ""
}
```

To test against an already running remote or local backend instead, disable the
managed server:

```json
{
  "ar5iv.conversionMode": "backend",
  "ar5iv.managedServer.enabled": false,
  "ar5iv.backendUrl": "http://127.0.0.1:3000"
}
```

Current local-test constraints:

- Use a single-file example first. Backend mode currently uploads only the
  active file, so `\input`, images, and bibliography side files are not yet
  reliable from a workspace.
- If the server session expires, reload the extension host or rerun the command;
  automatic session recovery is not implemented yet.
- The preview webview does not yet load the full `/editor` ar5iv CSS/font stack,
  so visual parity with the web editor is incomplete.

## Production build

```sh
cd frontend
npm install
npm run build              # outputs frontend/dist/
cd ..
cargo build -r -p ar5iv-editor-server
AR5IV_EDITOR_STATIC_DIR=$(pwd)/frontend/dist ./target/release/ar5iv-editor
```

By default the server resolves `frontend/dist` relative to its working
directory; the env var avoids surprises when the binary isn't started from
the workspace root.

### Configuration (env)

Listener and frontend:

| Var                          | Default                     | Meaning                                  |
|------------------------------|-----------------------------|------------------------------------------|
| `AR5IV_EDITOR_BIND`          | `127.0.0.1:3000`            | Listen address                           |
| `AR5IV_EDITOR_MAX_IN_FLIGHT` | `num_cpus`                  | Accepted but ignored — the engine is single-threaded; conversions are serialised |
| `AR5IV_EDITOR_STATIC_DIR`    | `frontend/dist`             | Where `/static` is served from           |
| `RUST_LOG`                   | `info,ar5iv_editor=debug`   | tracing-subscriber filter                |

Sessions and quotas (tunables for the file panel UI):

| Var                                   | Default                          | Meaning                                                |
|---------------------------------------|----------------------------------|--------------------------------------------------------|
| `AR5IV_EDITOR_SESSIONS_DIR`           | `$TMPDIR/ar5iv-editor-sessions`  | Where session tmpdirs live                             |
| `AR5IV_EDITOR_SESSION_IDLE_SECS`      | `600`                            | Idle timeout before GC removes a session (10 min)      |
| `AR5IV_EDITOR_GC_INTERVAL_SECS`       | `30`                             | How often the GC sweep runs                            |
| `AR5IV_EDITOR_QUOTA_SESSION_BYTES`    | `104857600` (100 MB)             | Max total size per session                             |
| `AR5IV_EDITOR_QUOTA_SESSION_FILES`    | `200`                            | Max file count per session                             |
| `AR5IV_EDITOR_QUOTA_UPLOAD_BYTES`     | `52428800` (50 MB)               | Max single-file upload size                            |
| `AR5IV_EDITOR_QUOTA_ARCHIVE_BYTES`    | `52428800` (50 MB)               | Max archive (ZIP / tar.gz / .gz) size                  |
| `AR5IV_EDITOR_QUOTA_ROOT_BYTES`       | `2147483648` (2 GB)              | Soft cap on the entire sessions root                   |
| `AR5IV_EDITOR_QUOTA_PER_USER`         | `8`                              | Concurrent sessions per `user_id` (LRU eviction)       |
| `AR5IV_EDITOR_QUOTA_PER_IP`           | `16`                             | `user_id`s per remote IP                               |

## Production deployment (Anubis)

For public-facing deploys put [Anubis](https://github.com/TecharoHQ/anubis)
in front of the Axum binary so anonymous compute isn't free for
crawlers. See `deploy/README.md` for the docker-compose setup, the
deny-by-default policy, and the smoke-tests that verify the
WebSocket upgrade and streaming uploads survive the proxy.

## Tests

```sh
cargo test --workspace            # ~37 fast tests
cargo test --workspace -- --ignored --test-threads=1  # plus 4 heavy ones
cd frontend && npm run build      # typecheck + bundle
```

The fast suite covers:
- `session::tests` — token / slot / resolve chokepoints.
- `convert::tests` — math fragment round-trip, path-rewrite, the
  diagnostic parser (synthetic + real engine run with an
  undefined-macro fixture).
- `archive::tests` — ZIP + tar.gz unpack, path-traversal rejection,
  symlink rejection, allowlist, oversized-entry rejection,
  Skip / Overwrite overlay, export → import round-trip.
- `tests/files_round_trip.rs` — 14 end-to-end HTTP route checks
  (CRUD, dedup, eviction, GC, orphan sweep, foreign-user 403,
  expired 410, archive import-as-new-project, export-zip).
- `tests/ws_round_trip.rs` — session-bound WS round-trip with
  `\input` resolution from a PUT'd file.

`#[ignore]`-by-default heavy tests:
- `tests/search_paths_de_risk.rs` — 3 the de-risk that
  `OxideConfig.search_paths` resolves `\input` and `\includegraphics`.
- `tests/ws_graphics_round_trip.rs` — confirms that
  `<img src="<absolute fs path>">` from the engine is rewritten into
  `/api/session/{id}/files/fig.png` so the browser can actually fetch
  it.
- `convert::tests::measure_pipeline` — wall-clock micro-benchmark
  with per-stage timings.

## Wire protocol

WebSocket at `/convert?session_id=…&user_id=…`; JSON text frames.
HTTP file routes under `/api/*` carry the user id in the
`X-Ar5iv-User` header. The full surface is documented in
`docs/FileUI.md`; the convert frame in particular looks like:

Client → server:

```json
{ "id": 7, "active_file": "main.tex", "version": 3, "preamble": null,
  "profile": "fragment", "format": "html5", "preload": ["..."] }
```

Server → client:

```json
{ "id": 7, "result": "<div>…</div>", "status": "No obvious problems",
  "status_code": 0, "version": 3, "log": "…",
  "diagnostics": [
    { "severity": "error", "category": "undefined:\\foo",
      "message": "The token T_CS[\\foo] is not defined.",
      "source": "main.tex", "from_line": 1, "from_col": 19 }
  ] }
```

`active_file` names a file that already lives on disk in the
session's tmpdir (PUT it via the file route first). The worker reads
the path off disk, sets `OxideConfig.search_paths` to the session
dir so `\input` and `\includegraphics` resolve, then post-processes
the rendered HTML to rewrite any `<img src="<session_dir>/…">` into
`/api/session/{id}/files/<rel>` URLs the browser can fetch.

Status codes: `0` = clean, `2` = errors, `3` = fatal,
`4` = `session_expired` (the session was GC'd; the client should
re-open the slot).

The worker drains the inbound queue before each digest and replies
with `{ "status": "superseded", "status_code": 0, "result": "" }` for
any request overtaken by a newer one. The frontend filters by id
*and* by the echoed `version` so stale convert results can't
overwrite a freshest preview after a write.

## Known gaps

- **PSTricks** rendering is not yet supported by `latexml-oxide`. The
  `psp` example loads but doesn't produce a graphic.
- **Tikz** colour-mix expressions (`fill=\couleur!\thedensity`) work for
  explicitly named or RGB colours; numeric-percent mixing of dvipsnames
  colours renders as grayscale until xcolor's mix algebra is fully ported.
- **Raw `.sty` consumption** for packages without a dedicated binding is
  flaky — `kpsewhich` finds the file but the engine's `find_file_aux`
  gating returns `None` in some configurations. Ports of the most common
  missing-binding packages are tracked upstream in `latexml-oxide`.

## Roadmap

1. Single-binary deployment via `rust-embed` over `frontend/dist`.
2. File rename + delete in the file panel (server routes already
   exist; the UI is intentionally deferred — see `docs/FileUI.md`
   "Non-goals").
3. Multi-file examples that actually use multiple files.
4. Closing the package-coverage gaps listed above.

## License

MIT, see `LICENSE`.
