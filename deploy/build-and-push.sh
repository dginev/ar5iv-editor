#!/usr/bin/env bash
# Build the ar5iv-editor image and push it to a container registry.
#
# Usage:
#   deploy/build-and-push.sh                 # build only
#   deploy/build-and-push.sh --push          # build and push to ghcr.io
#   IMAGE=ghcr.io/you/ar5iv-editor:dev deploy/build-and-push.sh --push
#
# The Dockerfile expects four sibling directories at the build root:
#
#     <ctx>/ar5iv-editor    (this repo)
#     <ctx>/latexml-oxide   (the path-dep)
#     <ctx>/validator       (ltx-scholarly schema source)
#     <ctx>/mathml-schema   (mathml4-core schema source)
#
# This script builds a temporary build root in a tmpfs, hardlinks the
# repos into it, runs the docker build with that root as context, and
# tears it down on exit. No copies, no scratch directory in your repo.
#
# Override IMAGE / LATEXML_PATH / VALIDATOR_PATH / MATHML_SCHEMA_PATH
# via env if your checkouts live somewhere other than the defaults.
#
# The published image contains only the compiled binary, the frontend
# bundle, and the vendored VS Code Web workbench assets (vscode-web +
# the ar5iv extension web bundle) — the multi-stage Dockerfile discards the
# latexml-oxide source (and the Rust / npm build trees) before
# the layers that `docker push` sends. We treat latexml-oxide as
# private, so keep the ghcr.io package **private** too. ghcr.io
# defaults to private on first push; on subsequent pushes the
# visibility doesn't change. Don't flip it to public without
# revisiting the latexml-oxide license posture.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIBLING_PARENT="$(cd "$REPO_ROOT/.." && pwd)"
LATEXML_PATH="${LATEXML_PATH:-$SIBLING_PARENT/latexml-oxide}"
# Schema sources default to the repo's submodules (the pinned,
# provenance-tracked state). Point the env overrides at sibling dev
# checkouts when you intentionally want to build against unpinned
# work-in-progress schemas.
VALIDATOR_PATH="${VALIDATOR_PATH:-$REPO_ROOT/validator}"
MATHML_SCHEMA_PATH="${MATHML_SCHEMA_PATH:-$REPO_ROOT/mathml-schema}"
IMAGE="${IMAGE:-ghcr.io/$(git -C "$REPO_ROOT" config --get remote.origin.url \
    | sed -E 's|.*[:/]([^/]+/[^/.]+)(\.git)?$|\1|')/ar5iv-editor:latest}"
# Companion image: the vnu (Nu validator) web service that backs
# `/api/validate`. Lives in the same ghcr namespace, same tag.
VALIDATOR_IMAGE="${VALIDATOR_IMAGE:-${IMAGE/ar5iv-editor:/ar5iv-validator:}}"
PUSH=0

for arg in "$@"; do
    case "$arg" in
        --push) PUSH=1 ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "unknown arg: $arg" >&2; exit 1 ;;
    esac
done

require_dir() {
    local label=$1 path=$2 envvar=$3
    if [[ ! -d "$path" ]]; then
        echo "error: $label not found at $path" >&2
        echo "set $envvar=/path/to/$label if it lives elsewhere" >&2
        exit 1
    fi
}
require_dir latexml-oxide "$LATEXML_PATH"       LATEXML_PATH
require_dir validator     "$VALIDATOR_PATH"     VALIDATOR_PATH
require_dir mathml-schema "$MATHML_SCHEMA_PATH" MATHML_SCHEMA_PATH

# An un-initialized submodule passes the directory check but is empty.
for sub in "$VALIDATOR_PATH" "$MATHML_SCHEMA_PATH"; do
    if [ -z "$(ls -A "$sub" 2>/dev/null)" ]; then
        echo "error: $sub is empty — run 'git submodule update --init' first" >&2
        exit 1
    fi
done

# The Dockerfile references `ar5iv-editor/`, `latexml-oxide/`,
# `validator/`, and `mathml-schema/` paths. We need a build context
# that contains exactly those four as immediate subdirectories — and
# nothing else.
#
# Earlier versions had a "use the parent directory as the build
# context" fast-path when all four checkouts lived as siblings under
# `~/git/`. BuildKit only sends files referenced by COPY directives,
# so on paper the unused siblings cost nothing. In practice they
# don't: BuildKit still walks the entire context root to compute
# stat-based cache keys, which on a working `~/git/` (multi-hundred-
# GB of unrelated checkouts: corpora, other forks, build artefacts)
# adds tens of seconds per build *and* invalidates the cache when
# any unrelated repo changes.
#
# Always stage to a tmpdir via `cp -al`. The hardlinks make the
# staging O(file-count) on the same filesystem, not O(bytes) — even
# the 45 GB latexml-oxide tree stages in a few seconds — and the
# trap rm cleans up on exit.
# `cp -al` requires src and dst on the same filesystem (hardlinks
# can't cross devices). `/tmp` is often a separate tmpfs / different
# block device from $HOME, so we anchor the staging dir under
# $SIBLING_PARENT — which by construction lives on whichever fs
# holds the source repos. Override AR5IV_STAGE_DIR to point
# elsewhere if you keep checkouts on a fs $SIBLING_PARENT can't
# hardlink to (rare).
STAGE_PARENT="${AR5IV_STAGE_DIR:-$SIBLING_PARENT}"
CTX="$(mktemp -d -p "$STAGE_PARENT" .ar5iv-build-XXXXXX)"
CLEANUP="$CTX"
trap 'rm -rf "$CLEANUP"' EXIT
echo "==> staging build context in $CTX (hardlinks)"
cp -al "$REPO_ROOT"          "$CTX/ar5iv-editor"
cp -al "$LATEXML_PATH"       "$CTX/latexml-oxide"
cp -al "$VALIDATOR_PATH"     "$CTX/validator"
cp -al "$MATHML_SCHEMA_PATH" "$CTX/mathml-schema"

# Drop the heaviest "build artefact" subdirs from the staged copies.
# The hardlinks let us delete from $CTX without touching the source
# checkouts; what we save is the BuildKit context-walk, which would
# otherwise stat its way through every file under target/ and
# node_modules/ to compute cache keys (tens of seconds each on the
# active dev machine, plus spurious cache invalidation when an
# unrelated `cargo build` runs between docker builds).
for junk in \
    "$CTX/ar5iv-editor/target"            \
    "$CTX/ar5iv-editor/frontend/node_modules" \
    "$CTX/ar5iv-editor/frontend/dist"     \
    "$CTX/ar5iv-editor/vscode-extension/node_modules" \
    "$CTX/ar5iv-editor/vscode-extension/dist" \
    "$CTX/ar5iv-editor/vscode-web/ar5iv"  \
    "$CTX/ar5iv-editor/validator"         \
    "$CTX/ar5iv-editor/mathml-schema"     \
    "$CTX/latexml-oxide/target"           \
    "$CTX/validator/build"                \
    "$CTX/validator/jing-trang"           \
    "$CTX/validator/dependencies"         \
    "$CTX/mathml-schema/build"            ; do
    [[ -e "$junk" ]] && rm -rf "$junk"
done
# (The staged ar5iv-editor copy carries the submodule worktrees; the
# canonical staged copies live at $CTX/validator and $CTX/mathml-schema,
# so the nested ones are dropped along with the build artefacts.)

# ---------------------------------------------------------------------
# Local pre-build of platform-independent artefacts.
#
# Both the frontend bundle (vite output) and the schema-docs HTML are
# pure browser content — no native code, no platform tie. Building
# them on the host instead of inside dedicated docker stages keeps
# trang / Java / node off the build pipeline, drops two intermediate
# stages, and shaves a few minutes off cold builds. The Rust binary
# and the TeX format dumps still build inside docker because both
# are tied to bookworm's ABI / TeX-Live version.

# === Frontend bundle =================================================
echo "==> [local prep] building frontend bundle"
if ! command -v npm >/dev/null 2>&1; then
    echo "error: 'npm' is required on PATH (Node.js 20+)" >&2
    echo "  install via your package manager, then retry." >&2
    exit 1
fi
(
    cd "$CTX/ar5iv-editor/frontend"
    npm ci --no-audit --no-fund
    npm run build
)
# `dist/` now lives at $CTX/ar5iv-editor/frontend/dist/ and the
# Dockerfile COPYs it into the runtime stage. node_modules/ stays put;
# BuildKit only walks paths referenced by COPY directives.

# === VS Code for the Web (/vscode workbench) =========================
# The /vscode route serves a vendored VS Code Web standalone build
# (vscode-web/, ~150 MB of static out/ + builtin extensions/) with the
# ar5iv extension loaded as a built-in (vscode-extension/, served at
# /vscode-ext). Mirror the frontend prep: install the extension's deps,
# vendor the standalone build, then bundle the extension's web + preview
# assets. Order matters — `fetch:vscode-web` vendors the workbench
# bootstrap (ar5iv/workbench.html + workbench-main.js) out of
# node_modules/@vscode/test-web, so `npm ci` must run first.
echo "==> [local prep] building VS Code Web workbench assets"
(
    cd "$CTX/ar5iv-editor/vscode-extension"
    # Playwright browsers are a test-only dependency; the
    # @playwright/browser-chromium postinstall hard-fails on host
    # platforms its pinned version doesn't recognize (e.g. a too-new
    # Ubuntu). The workbench asset build needs none of it.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
    # Idempotent: re-downloads the ~190 MB standalone build only on a
    # cold cache or pin bump (the .ar5iv-vscode-web-version stamp gates
    # it); otherwise just re-vendors the ar5iv/ bootstrap. Writes into
    # ../vscode-web (resolved relative to the script, i.e. inside $CTX).
    npm run fetch:vscode-web
    # build:assets + build:desktop + build:web + build:preview →
    # dist/{web,desktop}/extension.js + media/{preview.js,*.css}.
    npm run build
)
# The /vscode route silently degrades to a launcher page when any of
# these are absent, which would ship a dead workbench. Fail the build
# here instead so a broken vendor step never reaches the image.
#
# NOTE: `vscode-web/node_modules` is NOT a discardable "bundled server" —
# the workbench fetches its tokenizer + telemetry runtime from there at
# load time (`/vscode-static/node_modules/vscode-oniguruma/release/onig.wasm`,
# `vscode-textmate`, `tas-client`, `@vscode/vscode-languagedetection`).
# Stripping it breaks syntax highlighting and spams 404s. Likewise
# `vscode-extension/media/preview.css` is a *tracked source* file (only
# preview.js is generated), so `media/` must not be stripped before the
# build. Both are asserted below so a future prune can't silently
# reintroduce the regression.
for required in \
    "$CTX/ar5iv-editor/vscode-web/ar5iv/workbench.html"                                  \
    "$CTX/ar5iv-editor/vscode-web/out/nls.messages.js"                                   \
    "$CTX/ar5iv-editor/vscode-web/node_modules/vscode-oniguruma/release/onig.wasm"       \
    "$CTX/ar5iv-editor/vscode-web/node_modules/vscode-textmate/release/main.js"          \
    "$CTX/ar5iv-editor/vscode-web/extensions/latex/syntaxes/LaTeX.tmLanguage.json"       \
    "$CTX/ar5iv-editor/vscode-extension/dist/web/extension.js"                           \
    "$CTX/ar5iv-editor/vscode-extension/media/preview.js"                                \
    "$CTX/ar5iv-editor/vscode-extension/media/preview.css"                               ; do
    [[ -f "$required" ]] || { echo "error: missing $required after vscode build" >&2; exit 1; }
done

# === Schema documentation ============================================
echo "==> [local prep] generating schema documentation"
if ! command -v trang >/dev/null 2>&1; then
    echo "error: 'trang' is required on PATH (RNC -> RNG conversion)" >&2
    echo "  install with: sudo apt install trang" >&2
    exit 1
fi

# Always run `cargo build --release` so the binary tracks the current
# source. Cargo's incremental compilation makes this a no-op when
# nothing has changed (~1s); when the source is ahead of a previous
# build it does the right thing instead of silently using a binary
# from before the latest .sty / native-binding change. The earlier
# "use whatever's in target/" heuristic burned us once with a stale
# release binary that pre-dated `\schemasource{}{}` getting added to
# `latexmlman_sty.rs` — generator emitted the macro, engine didn't
# know it, and the run produced an `<ltx:ERROR/>` cover-page entry.
echo "    cargo build --release (latexml_oxide, genschema_oxide)"
(cd "$LATEXML_PATH" && cargo build --release \
    --bin latexml_oxide --bin genschema_oxide)
oxide_bin="$LATEXML_PATH/target/release/latexml_oxide"
genschema_bin="$LATEXML_PATH/target/release/genschema_oxide"
schema_doc_path="$(dirname "$oxide_bin"):$(dirname "$genschema_bin"):$PATH"
generator="$LATEXML_PATH/tools/generate-scholarly-schema-docs"
schema_docs_root="$CTX/schema-docs"
mkdir -p "$schema_docs_root"

# The RelaxNG tree lives inside latexml_core, not at the latexml-oxide workspace
# root: `cargo package` cannot follow a `../` path, so each embedded resource tree
# had to move into the crate that embeds it for the crates.io release
# (latexml-oxide docs/release/CRATES_IO_PUBLISH.md B3b). The catalog itself stayed
# at resources/ and points across.
PATH="$schema_doc_path" "$generator" \
    --schema  "$LATEXML_PATH/latexml_core/resources/RelaxNG/LaTeXML.rnc" \
    --catalog "$LATEXML_PATH/resources/LaTeXML.catalog"                  \
    --output  "$schema_docs_root/latexml"                                \
    --title   "LaTeXML Document Schema"
PATH="$schema_doc_path" "$generator" \
    --schema  "$VALIDATOR_PATH/schema/html5/scholarly-ltx.rnc" \
    --output  "$schema_docs_root/scholarly"                    \
    --title   "LaTeXML Scholarly HTML Schema"
PATH="$schema_doc_path" "$generator" \
    --schema  "$MATHML_SCHEMA_PATH/rnc/mathml4-core.rnc" \
    --output  "$schema_docs_root/mathml-core"            \
    --title   "MathML 4 Core"

# The generator drops a sibling "<output>-work" tree next to each
# output dir. We don't want those in the runtime image — strip them
# before the docker build context-walk picks them up.
rm -rf "$schema_docs_root"/*-work

# === vnu.jar (validation service) ====================================
# Pure Java, platform-independent — built on the host from the
# validator submodule, same rationale as the frontend bundle and the
# schema docs above. `checker.py dldeps` only fetches missing jars, so
# warm runs are a quick existence scan; the ant build underneath is
# incremental. The submodule worktree keeps `dependencies/` and
# `build/` between runs, so only the first build pays the full cost.
echo "==> [local prep] building vnu.jar (validation service)"
if ! command -v java >/dev/null 2>&1; then
    echo "error: 'java' (JDK 11+) is required on PATH to build vnu.jar" >&2
    exit 1
fi
(
    cd "$VALIDATOR_PATH"
    python3 ./checker.py dldeps > /dev/null
    python3 ./checker.py build > /dev/null
)
mkdir -p "$CTX/vnu"
cp "$VALIDATOR_PATH/build/dist/vnu.jar" "$CTX/vnu/vnu.jar"

# Capture the latexml-oxide commit identity so the binary can render
# a "powered by latexml-oxide @<sha>" link in the preview header.
# Pinned to the tip of `main` rather than the local checkout's HEAD
# — the constants advertise "we built against latexml-oxide main
# @<sha>" and the SHA needs to mean the same thing regardless of
# which branch the build host happens to be on. Falls back to
# "unknown" if the checkout doesn't have a `main` ref.
LATEXML_OXIDE_REF="${LATEXML_OXIDE_REF:-main}"
LATEXML_OXIDE_SHA=$(
    git -C "$LATEXML_PATH" rev-parse --short "$LATEXML_OXIDE_REF" 2>/dev/null \
        || echo "unknown"
)
LATEXML_OXIDE_DATE=$(
    git -C "$LATEXML_PATH" log -1 --format=%cs "$LATEXML_OXIDE_REF" 2>/dev/null \
        || echo "unknown"
)
# The validator pin is the submodule's HEAD (or whatever override the
# caller pointed VALIDATOR_PATH at) — surfaced via /api/version.
VALIDATOR_SHA=$(
    git -C "$VALIDATOR_PATH" rev-parse --short HEAD 2>/dev/null \
        || echo "unknown"
)

echo
echo "==> building $IMAGE"
echo "    repo:          $REPO_ROOT"
echo "    latexml-oxide: $LATEXML_PATH ($LATEXML_OXIDE_SHA, $LATEXML_OXIDE_DATE)"
echo "    validator:     $VALIDATOR_PATH ($VALIDATOR_SHA)"
echo "    mathml-schema: $MATHML_SCHEMA_PATH"
echo "    context:       $CTX"
echo

# `DOCKER_BUILD_EXTRA` lets callers (notably `release.sh --no-cache`)
# inject extra docker-build flags without us hard-coding every option.
# Whitespace-split into an array so quoting survives the call site.
EXTRA=()
if [[ -n "${DOCKER_BUILD_EXTRA:-}" ]]; then
    read -r -a EXTRA <<< "$DOCKER_BUILD_EXTRA"
    echo "    extra flags:   ${EXTRA[*]}"
    echo
fi

docker build \
    -f "$REPO_ROOT/deploy/Dockerfile" \
    -t "$IMAGE" \
    --build-arg "LATEXML_OXIDE_SHA=$LATEXML_OXIDE_SHA" \
    --build-arg "LATEXML_OXIDE_DATE=$LATEXML_OXIDE_DATE" \
    --build-arg "VALIDATOR_SHA=$VALIDATOR_SHA" \
    "${EXTRA[@]}" \
    "$CTX"

echo
echo "==> building $VALIDATOR_IMAGE"
docker build \
    -f "$REPO_ROOT/deploy/validator.Dockerfile" \
    -t "$VALIDATOR_IMAGE" \
    "${EXTRA[@]}" \
    "$CTX"

if [[ "$PUSH" -eq 1 ]]; then
    echo
    echo "==> pushing $IMAGE"
    docker push "$IMAGE"
    echo
    echo "==> pushing $VALIDATOR_IMAGE"
    docker push "$VALIDATOR_IMAGE"
    echo
    echo "    pull on the server with:"
    echo "    docker pull $IMAGE"
    echo "    docker pull $VALIDATOR_IMAGE"
fi

echo
echo "image:  $IMAGE"
echo "  size: $(docker image inspect "$IMAGE" --format='{{.Size}}' | numfmt --to=iec)"
echo "image:  $VALIDATOR_IMAGE"
echo "  size: $(docker image inspect "$VALIDATOR_IMAGE" --format='{{.Size}}' | numfmt --to=iec)"
