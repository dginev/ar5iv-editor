# Multi-stage build for the ar5iv-editor binary + frontend bundle.
#
# Build context expects two sibling directories at the build root:
#
#   <ctx>/
#   ├── ar5iv-editor/          # this repo
#   └── latexml-oxide/         # path-dep, https://github.com/dginev/latexml-oxide
#
# Use `deploy/build-and-push.sh` from the repo root for the canonical
# invocation; it handles the symlink dance.
#
# Notes:
# - rustup auto-installs nightly per `rust-toolchain.toml` on the
#   first cargo invocation, so the standard `rust:slim` image works
#   without a manual `rustup default nightly` step.
# - Default rustflags are `-C target-cpu=x86-64-v3` (Haswell-class
#   baseline: AVX2 / BMI2 / FMA / F16C / LZCNT / MOVBE / OSXSAVE).
#   Overrides the repo's local `target-cpu=native` so the resulting
#   binary runs on every modern x86_64 cloud host. AVX-512 stays off
#   so we don't depend on a specific Xeon SP generation.
# - `RUST_MIN_STACK=16777216` matches the project's `.cargo/config.toml` —
#   `latexml_contrib` overflows rustc's 8 MB default stack at compile time.
# - Final stage uses Debian slim with TeX Live so `kpsewhich` is available
#   for the engine's package-resolution fallback.

FROM rust:1-slim-bookworm AS builder
WORKDIR /build

# Captured at script-time by `deploy/build-and-push.sh` and forwarded
# via `--build-arg`. Used by `crates/ar5iv-editor-server/build.rs` to
# embed the latexml-oxide commit identity into the binary so the
# preview header can render a "powered by latexml-oxide @<sha>" link.
ARG LATEXML_OXIDE_SHA=unknown
ARG LATEXML_OXIDE_DATE=unknown

ENV RUST_MIN_STACK=16777216 \
    RUSTFLAGS="-C target-cpu=x86-64-v3" \
    CARGO_TERM_COLOR=always \
    LATEXML_OXIDE_SHA=$LATEXML_OXIDE_SHA \
    LATEXML_OXIDE_DATE=$LATEXML_OXIDE_DATE

RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config libxml2-dev libxslt1-dev libssl-dev clang \
        libkpathsea-dev \
        autoconf automake libtool make \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY ar5iv-editor/rust-toolchain.toml /build/ar5iv-editor/rust-toolchain.toml
COPY ar5iv-editor/Cargo.toml /build/ar5iv-editor/Cargo.toml
COPY ar5iv-editor/Cargo.lock /build/ar5iv-editor/Cargo.lock
COPY ar5iv-editor/crates /build/ar5iv-editor/crates
COPY ar5iv-editor/examples /build/ar5iv-editor/examples
COPY latexml-oxide /build/latexml-oxide

# Override the repo's target-cpu=native via an empty .cargo/config.toml
# at the build root — Cargo respects the inner-most config it finds, but
# we want our env-RUSTFLAGS to take precedence. Easiest path: drop a
# stub config that resets the rustflags table.
RUN mkdir -p /build/ar5iv-editor/.cargo && \
    printf '[env]\nRUST_MIN_STACK = "16777216"\n' \
        > /build/ar5iv-editor/.cargo/config.toml

WORKDIR /build/ar5iv-editor
RUN cargo build --release -p ar5iv-editor-server

# --------------------------------------------------------------------
# Stage: generate the latexml_oxide kernel dumps (`plain.dump.txt` +
# `latex.dump.txt`) against the ambient TeX Live, mirroring the
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

FROM rust:1-slim-bookworm AS formats
WORKDIR /build

# latexml-oxide's `.cargo/config.toml` uses `-Zunstable-options` and
# pins a nightly-only linker flag, so a stable rustc fails immediately.
# `RUSTUP_TOOLCHAIN=nightly` makes the rustup proxy auto-install +
# select the latest nightly on first cargo invocation, matching how
# the builder stage already handles it via `rust-toolchain.toml`.
ENV RUST_MIN_STACK=16777216 \
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
        pkg-config libxml2-dev libxslt1-dev libssl-dev clang \
        libkpathsea-dev libkpathsea6 \
        autoconf automake libtool make \
        ca-certificates \
        texlive-latex-base texlive-latex-recommended \
        texlive-pictures texlive-latex-extra \
    && rm -rf /var/lib/apt/lists/* \
    && rustup toolchain install nightly --profile minimal

COPY latexml-oxide /build/latexml-oxide
WORKDIR /build/latexml-oxide
# Wipe any host-built `target/` that hitched a ride via the COPY.
# The build context root is the parent of both repos and has no
# `.dockerignore`, so a host `cargo build` in latexml-oxide leaks
# its `target/` into the image. `make_formats.sh` then finds the
# pre-built binary, skips the in-image rebuild, and runs it — but
# the host binary was linked against the host's newer libxml2 (e.g.
# libxml2.so.16 on a recent Debian/Ubuntu) which doesn't exist in
# this bookworm-based stage. Removing it forces a clean
# in-image build that links against bookworm's libxml2.so.2.
RUN rm -rf target
RUN tools/make_formats.sh

# --------------------------------------------------------------------

FROM node:20-bookworm-slim AS frontend
WORKDIR /build
COPY ar5iv-editor /build/ar5iv-editor
WORKDIR /build/ar5iv-editor/frontend
RUN npm ci --no-audit --no-fund && npm run build

# --------------------------------------------------------------------

FROM debian:bookworm-slim AS runtime

# imagemagick + ghostscript are needed by latexml_post::graphics to
# rasterize PDF / EPS / PS into PNG. Without them every
# `\includegraphics{paper.pdf}` becomes a broken `<img>` because the
# engine maps PDF→PNG in its type table but can't run the convert
# subprocess.
#
# Debian's default ImageMagick policy.xml disables PDF reading
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
        texlive-pictures texlive-latex-extra \
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
COPY --from=builder  /build/ar5iv-editor/target/release/ar5iv-editor /app/ar5iv-editor
COPY --from=frontend /build/ar5iv-editor/frontend/dist /app/frontend/dist
COPY --from=formats  /build/latexml-oxide/resources/dumps /app/dumps

ENV AR5IV_EDITOR_BIND="0.0.0.0:3000" \
    AR5IV_EDITOR_STATIC_DIR="/app/frontend/dist" \
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
