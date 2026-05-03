# Multi-stage build for the ar5iv-editor binary + frontend bundle.
#
# Notes:
# - The latexml-oxide path-deps live one level above this repo at
#   `~/git/latexml-oxide`. The build COPYs that tree alongside the
#   editor source, so the docker build context must include both.
#   Run `docker compose build` from a parent directory that contains
#   both checkouts, or symlink the latexml-oxide tree into this repo.
# - Rust nightly is pinned in `rust-toolchain.toml` (latexml-oxide
#   requires it).
# - Final stage uses the Debian slim image so `kpsewhich` from
#   TeX Live is available for the engine's package-resolution
#   fallback.

FROM rust:1-slim-bookworm AS builder
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config libxml2-dev libxslt1-dev libssl-dev clang \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# rust-toolchain.toml in the project pins the right channel.
COPY ar5iv-editor/rust-toolchain.toml /build/ar5iv-editor/rust-toolchain.toml
COPY ar5iv-editor/Cargo.toml /build/ar5iv-editor/Cargo.toml
COPY ar5iv-editor/Cargo.lock /build/ar5iv-editor/Cargo.lock
COPY ar5iv-editor/crates /build/ar5iv-editor/crates
COPY ar5iv-editor/examples /build/ar5iv-editor/examples
COPY latexml-oxide /build/latexml-oxide

WORKDIR /build/ar5iv-editor
RUN cargo build --release -p ar5iv-editor-server

# --------------------------------------------------------------------

FROM node:20-bookworm-slim AS frontend
WORKDIR /build
COPY ar5iv-editor /build/ar5iv-editor
WORKDIR /build/ar5iv-editor/frontend
RUN npm ci && npm run build

# --------------------------------------------------------------------

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        texlive-latex-base texlive-latex-recommended \
        libxml2 libxslt1.1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder  /build/ar5iv-editor/target/release/ar5iv-editor /app/ar5iv-editor
COPY --from=frontend /build/ar5iv-editor/frontend/dist /app/frontend/dist

USER nobody
EXPOSE 3000
CMD ["/app/ar5iv-editor"]
