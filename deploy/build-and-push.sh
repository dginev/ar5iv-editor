#!/usr/bin/env bash
# Build the ar5iv-editor image and push it to a container registry.
#
# Usage:
#   deploy/build-and-push.sh                 # build only
#   deploy/build-and-push.sh --push          # build and push to ghcr.io
#   IMAGE=ghcr.io/you/ar5iv-editor:dev deploy/build-and-push.sh --push
#
# The Dockerfile expects two sibling directories at the build root:
#
#     <ctx>/ar5iv-editor    (this repo)
#     <ctx>/latexml-oxide   (the path-dep)
#
# This script builds a temporary build root in a tmpfs, symlinks both
# repos into it, runs the docker build with that root as context, and
# tears it down on exit. No copies, no scratch directory in your repo.
#
# Override IMAGE / LATEXML_PATH via env if your checkouts live
# somewhere other than the defaults.
#
# The published image contains only the compiled binary and the
# frontend bundle — the multi-stage Dockerfile discards the
# latexml-oxide source (and the Rust / npm build trees) before
# the layers that `docker push` sends. We treat latexml-oxide as
# private, so keep the ghcr.io package **private** too. ghcr.io
# defaults to private on first push; on subsequent pushes the
# visibility doesn't change. Don't flip it to public without
# revisiting the latexml-oxide license posture.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LATEXML_PATH="${LATEXML_PATH:-$(cd "$REPO_ROOT/.." && pwd)/latexml-oxide}"
IMAGE="${IMAGE:-ghcr.io/$(git -C "$REPO_ROOT" config --get remote.origin.url \
    | sed -E 's|.*[:/]([^/]+/[^/.]+)(\.git)?$|\1|')/ar5iv-editor:latest}"
PUSH=0

for arg in "$@"; do
    case "$arg" in
        --push) PUSH=1 ;;
        -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
        *) echo "unknown arg: $arg" >&2; exit 1 ;;
    esac
done

if [[ ! -d "$LATEXML_PATH" ]]; then
    echo "error: latexml-oxide not found at $LATEXML_PATH" >&2
    echo "set LATEXML_PATH=/path/to/latexml-oxide if it lives elsewhere" >&2
    exit 1
fi

# The Dockerfile references both `ar5iv-editor/...` and
# `latexml-oxide/...` paths. We need a build context that contains
# both as immediate subdirectories.
#
# BuildKit doesn't dereference symlinks at the top level of a build
# context (security: a symlink-out attack would otherwise leak host
# files). Three options:
#   1. Build with the *parent* directory as the context if both
#      checkouts already live as siblings there. This is the path
#      we take when the layout matches.
#   2. Otherwise hard-link the trees into a tmpdir staging area
#      via `cp -al` (fast on the same filesystem, large context but
#      no actual copies).
#
# Option 1 is faster (no staging) and is the common case.
PARENT_OF_REPO="$(cd "$REPO_ROOT/.." && pwd)"
PARENT_OF_LATEXML="$(cd "$LATEXML_PATH/.." && pwd)"
if [[ "$PARENT_OF_REPO" == "$PARENT_OF_LATEXML" \
   && "$(basename "$REPO_ROOT")" == "ar5iv-editor" \
   && "$(basename "$LATEXML_PATH")" == "latexml-oxide" ]]; then
    CTX="$PARENT_OF_REPO"
    CLEANUP=""
    echo "==> using parent dir as build context: $CTX"
else
    CTX="$(mktemp -d)"
    CLEANUP="$CTX"
    trap 'rm -rf "$CLEANUP"' EXIT
    echo "==> staging build context in $CTX (hardlinks)"
    cp -al "$REPO_ROOT"    "$CTX/ar5iv-editor"
    cp -al "$LATEXML_PATH" "$CTX/latexml-oxide"
fi

# Capture the latexml-oxide commit identity so the binary can render
# a "powered by latexml-oxide @<sha>" link in the preview header.
# Pinned to the tip of `master` rather than the local checkout's HEAD
# — the constants advertise "we built against latexml-oxide master
# @<sha>" and the SHA needs to mean the same thing regardless of
# which branch the build host happens to be on. Falls back to
# "unknown" if the checkout doesn't have a `master` ref.
LATEXML_OXIDE_REF="${LATEXML_OXIDE_REF:-master}"
LATEXML_OXIDE_SHA=$(
    git -C "$LATEXML_PATH" rev-parse --short "$LATEXML_OXIDE_REF" 2>/dev/null \
        || echo "unknown"
)
LATEXML_OXIDE_DATE=$(
    git -C "$LATEXML_PATH" log -1 --format=%cs "$LATEXML_OXIDE_REF" 2>/dev/null \
        || echo "unknown"
)

echo
echo "==> building $IMAGE"
echo "    repo:          $REPO_ROOT"
echo "    latexml-oxide: $LATEXML_PATH ($LATEXML_OXIDE_SHA, $LATEXML_OXIDE_DATE)"
echo "    context:       $CTX"
echo

docker build \
    -f "$REPO_ROOT/deploy/Dockerfile" \
    -t "$IMAGE" \
    --build-arg "LATEXML_OXIDE_SHA=$LATEXML_OXIDE_SHA" \
    --build-arg "LATEXML_OXIDE_DATE=$LATEXML_OXIDE_DATE" \
    "$CTX"

if [[ "$PUSH" -eq 1 ]]; then
    echo
    echo "==> pushing $IMAGE"
    docker push "$IMAGE"
    echo
    echo "    pull on the server with:"
    echo "    docker pull $IMAGE"
fi

echo
echo "image:  $IMAGE"
echo "  size: $(docker image inspect "$IMAGE" --format='{{.Size}}' | numfmt --to=iec)"
