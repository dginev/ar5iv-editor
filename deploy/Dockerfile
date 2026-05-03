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

ENV RUST_MIN_STACK=16777216 \
    RUSTFLAGS="-C target-cpu=x86-64-v3" \
    CARGO_TERM_COLOR=always

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

FROM node:20-bookworm-slim AS frontend
WORKDIR /build
COPY ar5iv-editor /build/ar5iv-editor
WORKDIR /build/ar5iv-editor/frontend
RUN npm ci --no-audit --no-fund && npm run build

# --------------------------------------------------------------------

FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        texlive-latex-base texlive-latex-recommended \
        libxml2 libxslt1.1 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder  /build/ar5iv-editor/target/release/ar5iv-editor /app/ar5iv-editor
COPY --from=frontend /build/ar5iv-editor/frontend/dist /app/frontend/dist

ENV AR5IV_EDITOR_BIND="0.0.0.0:3000" \
    AR5IV_EDITOR_STATIC_DIR="/app/frontend/dist"

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
