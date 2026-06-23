# Multi-stage build for the ar5iv-editor binary.
#
# Build context expects four sibling source directories plus two
# pre-built artefact directories at the build root:
#
#   <ctx>/
#   ├── ar5iv-editor/                       # this repo
#   │   ├── frontend/dist/                  # vite output (built locally)
#   │   ├── vscode-web/                     # vendored VS Code Web build (/vscode)
#   │   └── vscode-extension/{dist,media}/  # ar5iv extension web bundle (/vscode-ext)
#   ├── latexml-oxide/                      # path-dep, https://github.com/dginev/latexml-oxide
#   ├── validator/                          # ltx-scholarly schema source
#   ├── mathml-schema/                      # mathml4-core schema source
#   └── schema-docs/{latexml,scholarly,mathml-core}/
#                                           # generated schema-doc sites
#
# `frontend/dist/`, `schema-docs/`, and the `vscode-web/` +
# `vscode-extension/` web bundles are all produced on the host by
# `deploy/build-and-push.sh` before the docker build kicks off. They
# are pure browser content (HTML/CSS/JS) with no platform tie, so
# generating them locally avoids dragging trang + Java + Node into
# the docker pipeline. The Rust binary (libxml2 ABI) and the TeX
# format dumps (TeX-Live version) stay in dedicated stages here
# because both are tied to the runtime OS's exact ABI / TeX Live.
#
# Use `deploy/build-and-push.sh` from the repo root for the canonical
# invocation; running `docker build` directly will fail at the
# `COPY frontend/dist` / `COPY schema-docs` lines.
#
# Notes:
# - All three stages are Ubuntu 24.04 (Noble). Its TeX Live 2023 ships
#   `kpathsea 6.3.5`, which exactly matches the embedded `*.2023.dump.txt`
#   stamp — so the runtime dump-stamp check finds no TeXLive skew (Debian
#   bookworm's TL2022/6.3.4 and trixie's 6.4.0/dev both mismatch the bundled
#   2023/2025 dumps). Keeping builder + formats + runtime on the same OS also
#   keeps the binary's libxml2 / libkpathsea / glibc ABI consistent.
# - The official `rust` images are Debian-based, so the two Rust stages install
#   the toolchain via rustup (no default toolchain; the first cargo invocation
#   auto-installs the nightly pinned by `rust-toolchain.toml`). rustup/cargo live
#   under `/usr/local/{rustup,cargo}` (the `rust` image layout) so the BuildKit
#   cargo-registry cache mount is shared across stages.
# - Default rustflags are `-C target-cpu=x86-64-v3` (Haswell-class
#   baseline: AVX2 / BMI2 / FMA / F16C / LZCNT / MOVBE / OSXSAVE).
#   Overrides the repo's local `target-cpu=native` so the resulting
#   binary runs on every modern x86_64 cloud host. AVX-512 stays off
#   so we don't depend on a specific Xeon SP generation.
# - `RUST_MIN_STACK=16777216` matches the project's `.cargo/config.toml` —
#   `latexml_contrib` overflows rustc's 8 MB default stack at compile time.

FROM ubuntu:24.04 AS builder
WORKDIR /build

# Captured at script-time by `deploy/build-and-push.sh` and forwarded
# via `--build-arg`. Used by `crates/ar5iv-editor-server/build.rs` to
# embed the latexml-oxide commit identity into the binary so the
# preview header can render a "powered by latexml-oxide @<sha>" link.
ARG LATEXML_OXIDE_SHA=unknown
ARG LATEXML_OXIDE_DATE=unknown
# Pin of the `validator` submodule (schema source + vnu service);
# surfaced through `/api/version` alongside the latexml-oxide SHA.
ARG VALIDATOR_SHA=unknown
# Optional cargo job cap for memory/thermal-constrained build hosts.
# `0` (default) = cargo's default (all logical CPUs). Pass e.g.
# `--build-arg CARGO_JOBS=6` to bound the concurrent rustc/codegen
# threads; matters most because BuildKit runs the builder and formats
# stages in parallel, so two uncapped cargo builds can thrash a host.
ARG CARGO_JOBS=0

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    RUST_MIN_STACK=16777216 \
    RUSTFLAGS="-C target-cpu=x86-64-v3" \
    CARGO_TERM_COLOR=always \
    LATEXML_OXIDE_SHA=$LATEXML_OXIDE_SHA \
    LATEXML_OXIDE_DATE=$LATEXML_OXIDE_DATE \
    VALIDATOR_SHA=$VALIDATOR_SHA

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential curl ca-certificates \
        pkg-config libxml2-dev libxslt1-dev libssl-dev clang \
        libkpathsea-dev \
        autoconf automake libtool make \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --default-toolchain none --profile minimal

COPY ar5iv-editor/rust-toolchain.toml /build/ar5iv-editor/rust-toolchain.toml
COPY ar5iv-editor/Cargo.toml /build/ar5iv-editor/Cargo.toml
COPY ar5iv-editor/Cargo.lock /build/ar5iv-editor/Cargo.lock
COPY ar5iv-editor/crates /build/ar5iv-editor/crates
COPY ar5iv-editor/examples /build/ar5iv-editor/examples
# `crates/ar5iv-editor-server/src/files.rs` `include_bytes!`s the
# ar5iv stylesheets from this path so the export-zip route can ship a
# self-contained `index.html`. Has to land in the builder stage
# because the embed happens at compile time.
COPY ar5iv-editor/frontend/public /build/ar5iv-editor/frontend/public
COPY latexml-oxide /build/latexml-oxide

# Override the repo's target-cpu=native via an empty .cargo/config.toml
# at the build root — Cargo respects the inner-most config it finds, but
# we want our env-RUSTFLAGS to take precedence. Easiest path: drop a
# stub config that resets the rustflags table.
RUN mkdir -p /build/ar5iv-editor/.cargo && \
    printf '[env]\nRUST_MIN_STACK = "16777216"\n' \
        > /build/ar5iv-editor/.cargo/config.toml

WORKDIR /build/ar5iv-editor
# BuildKit cache mounts let cargo's incremental cache survive between
# image rebuilds. On a cold build the mounts are empty and we pay the
# full ~17 min release compile; on a warm rebuild (same host, same
# BuildKit instance) cargo only re-builds what actually changed. The
# `target/` cache is per-crate-version, the registry cache holds
# already-downloaded crate sources.
# Two binaries come out of this stage:
#  * ar5iv-editor        — the web server (path-deps on latexml-oxide).
#    Built with ar5iv-editor's own `[profile.release]`, which is already
#    the maxperf-cortex recipe (opt-level=3, fat LTO, codegen-units=1,
#    panic=unwind). Cargo profiles are workspace-local, so this binary
#    cannot literally name latexml-oxide's `maxperf-cortex` — but it
#    doesn't need to: the path-dep'd engine crates get fat-LTO'd into
#    the server here regardless.
#  * latexml_oxide       — the ENGINE the warm LSP pool spawns per
#    session (`lsp_pool.rs`); this standalone binary does the ACTUAL
#    production conversions. Without it in the runtime image the pool
#    is DISABLED at startup (loud warn) and every conversion runs cold
#    in-process — the exact silent-degradation failure the pool's
#    design forbids. The cache mount over latexml-oxide/target also
#    shadows any host-leaked target/ from the COPY above.
#
#    Build it with latexml-oxide's `maxperf-cortex` profile, NOT the
#    default `release`: latexml-oxide's `[profile.release]` is its local
#    benchmark profile (thin LTO, codegen-units=20) — fast to compile but
#    leaves runtime perf on the table for the long-lived engine. maxperf-
#    cortex = maxperf's real levers (fat LTO + codegen-units=1) with
#    panic=unwind preserved, which the engine needs to isolate per-paper
#    panics (catch_unwind). This is the binary on the hot path, so this is
#    where whole-program optimization actually pays off. Costs a few extra
#    minutes of fat-LTO link time on a cold build; runtime-only artifact.
RUN --mount=type=cache,target=/build/ar5iv-editor/target,sharing=locked,id=ar5iv-editor-target \
    --mount=type=cache,target=/build/latexml-oxide/target,sharing=locked,id=latexml-oxide-target-release \
    --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked,id=cargo-registry \
    if [ "$CARGO_JOBS" != 0 ]; then export CARGO_BUILD_JOBS="$CARGO_JOBS"; fi && \
    cargo build --release -p ar5iv-editor-server && \
    cp target/release/ar5iv-editor /tmp/ar5iv-editor && \
    cargo build --profile maxperf-cortex --bin latexml_oxide \
        --manifest-path /build/latexml-oxide/Cargo.toml && \
    cp /build/latexml-oxide/target/maxperf-cortex/latexml_oxide /tmp/latexml_oxide

# --------------------------------------------------------------------
# Stage: generate the latexml_oxide kernel dumps (`plain.YYYY.dump.txt` +
# `latex.YYYY.dump.txt`) against the ambient TeX Live, mirroring the
# `make formats` step in latexml-oxide's CI workflow. The engine
# reads these from disk at runtime; without them every cold start
# falls back to reconstructing kernel state from `_base` (slower,
# noisier logs). See `latexml_engine/build.rs` for the dump search
# path.
#
# We use the debug profile here (the make_formats.sh default) — the
# binary is run exactly twice (`--init=plain.tex`, `--init=latex.ltx`)
# and is discarded with the stage, so optimizing it would just trade
# linker time for nothing.

FROM ubuntu:24.04 AS formats
WORKDIR /build

# Same optional cargo job cap as the builder stage (stage-scoped ARG).
ARG CARGO_JOBS=0

# latexml-oxide's `.cargo/config.toml` uses `-Zunstable-options` and
# pins a nightly-only linker flag, so a stable rustc fails immediately.
# `RUSTUP_TOOLCHAIN=nightly` makes the rustup proxy auto-install +
# select the latest nightly on first cargo invocation. rustup/cargo live
# under `/usr/local/{rustup,cargo}` to match the builder stage and share
# the cargo-registry cache mount.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    RUST_MIN_STACK=16777216 \
    CARGO_TERM_COLOR=always \
    RUSTUP_TOOLCHAIN=nightly

# Native deps for the engine + the same texlive packages we ship in
# the runtime stage. Matching the package set is important: the
# kernel dump captures whatever `\input{...}` reachable bindings
# resolve at dump-time, and a runtime that has *more* texlive than
# dump-time means any package only-resolvable at runtime wouldn't
# get its state into the dump (so `_base` reconstruction kicks in
# anyway). Cheaper to align here than diagnose mismatch later.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential curl ca-certificates \
        pkg-config libxml2-dev libxslt1-dev libssl-dev clang \
        libkpathsea-dev libkpathsea6 \
        autoconf automake libtool make mold \
        texlive-latex-base texlive-latex-recommended \
        texlive-pictures texlive-latex-extra texlive-science \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --default-toolchain none --profile minimal \
    && rustup toolchain install nightly --profile minimal

COPY latexml-oxide /build/latexml-oxide
WORKDIR /build/latexml-oxide
# Wipe any host-built `target/` that hitched a ride via the COPY.
# The build context root is the parent of both repos and has no
# `.dockerignore`, so a host `cargo build` in latexml-oxide leaks
# its `target/` into the image. `make_formats.sh` then finds the
# pre-built binary, skips the in-image rebuild, and runs it — but
# the host binary was linked against the host's libxml2, which may differ
# from this stage's (Ubuntu 24.04 ships libxml2.so.2 / 2.9.14). Removing it
# forces a clean in-image build that links against this stage's libs.
RUN rm -rf target
# Same BuildKit cache pattern as the builder stage: cargo's
# incremental survives between rebuilds. `make_formats.sh` invokes
# `cargo build --bin latexml_oxide` internally, then runs the binary
# twice to dump kernel state. The dumps land outside `target/` (in
# `resources/dumps/`), so they survive the cache-mount unmount.
# Use a different cache id from the builder stage because they
# build different package sets (debug vs release, different bin).
RUN --mount=type=cache,target=/build/latexml-oxide/target,sharing=locked,id=latexml-oxide-target-debug \
    --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked,id=cargo-registry \
    if [ "$CARGO_JOBS" != 0 ]; then export CARGO_BUILD_JOBS="$CARGO_JOBS"; fi && \
    tools/make_formats.sh

# --------------------------------------------------------------------

FROM ubuntu:24.04 AS runtime

# imagemagick + ghostscript are needed by latexml_post::graphics to
# rasterize PDF / EPS / PS into PNG. Without them every
# `\includegraphics{paper.pdf}` becomes a broken `<img>` because the
# engine maps PDF→PNG in its type table but can't run the convert
# subprocess.
#
# The distro's default ImageMagick policy.xml disables PDF reading
# (CVE-2018-16323 mitigation). For our demo we trust the input — the
# engine has already validated the path and the upload allowlist
# already restricts what can land. Remove the PDF-deny line so the
# Graphics processor's `convert paper.pdf out.png` actually works.
# `texlive-pictures` ships `tikz.sty` / `pgf.sty` / friends; without
# it the engine warns `missing_file:tikz Can't find binding or file
# for 'tikz.sty'` and every `\begin{tikzpicture}` collapses to a
# wall of undefined-macro errors. `texlive-latex-extra` covers the
# long tail of extra packages real arXiv preprints depend on
# (`tcolorbox`, `enumitem`, `ifoddpage`, ...). Together they add
# ~200 MB to the image but make tikz/pgf-heavy uploads convert
# without manual fixups.
RUN apt-get update && apt-get install -y --no-install-recommends \
        texlive-latex-base texlive-latex-recommended \
        texlive-pictures texlive-latex-extra texlive-science \
        libxml2 libxslt1.1 ca-certificates curl \
        imagemagick ghostscript \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's@<policy domain="coder" rights="none" pattern="PDF" />@<policy domain="coder" rights="read|write" pattern="PDF" />@' \
        /etc/ImageMagick-6/policy.xml \
    && sed -i 's@<policy domain="coder" rights="none" pattern="EPS" />@<policy domain="coder" rights="read|write" pattern="EPS" />@' \
        /etc/ImageMagick-6/policy.xml \
    && sed -i 's@<policy domain="coder" rights="none" pattern="PS" />@<policy domain="coder" rights="read|write" pattern="PS" />@' \
        /etc/ImageMagick-6/policy.xml

WORKDIR /app
COPY --from=builder /tmp/ar5iv-editor /app/ar5iv-editor
# The warm-pool engine, on PATH so `lsp_pool::resolve_engine` finds it
# with zero configuration (the explicit env makes the wiring auditable).
COPY --from=builder /tmp/latexml_oxide /usr/local/bin/latexml_oxide
ENV AR5IV_LATEXML_BIN=/usr/local/bin/latexml_oxide
COPY --from=formats /build/latexml-oxide/resources/dumps             /app/dumps
COPY ar5iv-editor/frontend/dist /app/frontend/dist
COPY schema-docs                /app/schema-docs

# VS Code for the Web assets for the `/vscode` workbench. `vscode-web` is
# the vendored standalone build (static `out/` + builtin `extensions/`),
# served at /vscode-static. The pruned extension dir (manifest + web
# bundle + preview media) is served at /vscode-ext and loaded as a
# built-in. Both are produced by `build-and-push.sh`'s [local prep] step
# (npm ci → fetch:vscode-web → build). Without them the /vscode route
# degrades to a launcher page.
COPY ar5iv-editor/vscode-web                         /app/vscode-web
COPY ar5iv-editor/vscode-extension/package.json      /app/vscode-extension/package.json
COPY ar5iv-editor/vscode-extension/package.nls.json  /app/vscode-extension/package.nls.json
COPY ar5iv-editor/vscode-extension/dist              /app/vscode-extension/dist
COPY ar5iv-editor/vscode-extension/media             /app/vscode-extension/media

ENV AR5IV_EDITOR_BIND="0.0.0.0:3000" \
    AR5IV_EDITOR_STATIC_DIR="/app/frontend/dist" \
    AR5IV_EDITOR_SCHEMA_DOCS_DIR="/app/schema-docs" \
    AR5IV_VSCODE_WEB_DIR="/app/vscode-web" \
    AR5IV_VSCODE_EXT_DIR="/app/vscode-extension" \
    LATEXML_DUMP_DIR="/app/dumps"

# `nobody` has UID 65534 — works on every Linux distro out of the
# box. We don't need write access to anything outside the sessions
# tmpfs, which is mounted writable in the compose file.
USER nobody
EXPOSE 3000

# A trivial liveness probe — `/about` is a static template that
# requires no engine work, so it's the right thing to ping.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:3000/about" >/dev/null || exit 1

CMD ["/app/ar5iv-editor"]
