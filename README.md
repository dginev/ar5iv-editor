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

**v0.1.0 — first alpha.** End-to-end pipeline is real (no stub): every
keystroke runs through `latexml-oxide`, post-processes XMath into MathML,
applies the bundled HTML5 XSLT, and morphs the result into the preview.
Light and dark themes for editor + preview, 16 example documents ported
from ltxmojo, sub-100 ms warm-conversion latency in release builds. Expect
ongoing rough edges around package coverage; see the *Known gaps* section.

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

## Layout

```
ar5iv-editor/
├── Cargo.toml                              workspace
├── rust-toolchain.toml                     pins nightly (latexml-oxide req)
├── .cargo/config.toml                      bumps RUST_MIN_STACK for build
├── crates/
│   ├── ar5iv-editor-protocol/              shared wire types
│   └── ar5iv-editor-server/                Axum binary + lib
│       ├── src/                            main, lib, routes, ws, convert, …
│       └── templates/                      Askama HTML templates
└── frontend/                               Vite + TS + CodeMirror 6
    └── src/                                main, editor, ws, preview, examples
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
`/help`, `/editor`, `/static` to the backend):

```sh
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173/editor>.

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

| Var                          | Default                     | Meaning                                  |
|------------------------------|-----------------------------|------------------------------------------|
| `AR5IV_EDITOR_BIND`          | `127.0.0.1:3000`            | Listen address                           |
| `AR5IV_EDITOR_MAX_IN_FLIGHT` | `num_cpus`                  | Accepted but ignored — the engine is single-threaded; conversions are serialised |
| `AR5IV_EDITOR_STATIC_DIR`    | `frontend/dist`             | Where `/static` is served from           |
| `RUST_LOG`                   | `info,ar5iv_editor=debug`   | tracing-subscriber filter                |

## Tests

```sh
cargo test --workspace
```

Includes:
- `convert::tests::round_trips_a_math_fragment` — a real conversion that
  asserts MathML in the response.
- `tests/ws_round_trip.rs` — end-to-end test: boots the server on a random
  port, connects via `tokio-tungstenite`, sends `\(x^2 + y^2 = z^2\)`,
  asserts MathML round-trips.
- `convert::tests::measure_pipeline` (`#[ignore]`) — wall-clock
  micro-benchmark with per-stage timings (`from_config`,
  `converter.convert`, `run_post_processing`).

## Wire protocol

Single WebSocket at `/convert`; JSON text frames.

Client → server:

```json
{ "id": 7, "tex": "\\(x^2\\)", "preamble": null,
  "profile": "fragment", "format": "html5", "preload": ["..."] }
```

Server → client:

```json
{ "id": 7, "result": "<div>…</div>", "status": "Status:conversion:0",
  "status_code": 0, "log": "…" }
```

The worker drains the inbound queue before each digest and replies with
`{ "status": "superseded", "status_code": 0, "result": "" }` for any
request overtaken by a newer one. The frontend filters by id and discards
`superseded` frames so stale results never overwrite the freshest preview.

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
2. Optional: re-add user/profile DB and ZIP archive upload from ltxmojo.
3. Closing the package-coverage gaps listed above.

## License

MIT, see `LICENSE`.
