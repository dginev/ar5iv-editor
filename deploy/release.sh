#!/usr/bin/env bash
# release.sh — laptop-side release pipeline for ar5iv-editor.
#
# Wraps `build-and-push.sh` with the pre-flight checks, the local
# smoke test, and the tagging that turn a build into a safe cloud
# release. Mirrors the laptop-side steps of `deploy/PLAN.md`
# (sections A, B, C, E1); the box-side bit (D) is documented in
# `cloud-demo.md` and stays manual on purpose.
#
# Usage:
#     deploy/release.sh
#         Sync latexml-oxide to master, build the image, run the
#         local smoke test. No registry push, no source tag.
#
#     deploy/release.sh --push
#         Above, plus push :latest AND a dated :YYYYMMDD-<sha> tag.
#         The dated tag is the rollback handle.
#
#     deploy/release.sh --push --tag-source
#         Above, plus `git tag deploy-YYYYMMDD-<sha>` on the
#         ar5iv-editor commit and push the tag to origin.
#
#     deploy/release.sh --no-sync
#         Don't fetch/pull latexml-oxide; build against whatever is
#         currently checked out. Useful for testing a non-master
#         feature branch.
#
#     deploy/release.sh --allow-dirty
#         Don't bail when ar5iv-editor has uncommitted tracked
#         changes. The Dockerfile copies the working tree as-is, so
#         a dirty build is reproducible only on this laptop.
#
#     deploy/release.sh --no-cache
#         Force a from-scratch build (drop the BuildKit cache).
#         Use when a Dockerfile change is being silently cached or
#         you suspect a corrupt layer.
#
#     deploy/release.sh --no-host-network
#         Use BuildKit's isolated build network instead of
#         `--network=host`. Default is host networking because
#         BuildKit's default network sometimes can't resolve
#         deb.debian.org during apt-get; opt out only if you have
#         a hardened build environment that needs the isolation.
#
#     deploy/release.sh --yes
#         Skip the 5-second pre-push confirmation window. Useful in
#         CI; never use it interactively when --push is set.
#
# Env overrides (all optional):
#     LATEXML_PATH        — checkout location of latexml-oxide
#                           (default: ../latexml-oxide)
#     LATEXML_OXIDE_REF   — branch/tag/sha to build against
#                           (default: master)
#     IMAGE_BASE          — registry path without a tag
#                           (default: ghcr.io/<owner>/<repo>/ar5iv-editor,
#                            inferred from `git remote get-url origin`)
#     SMOKE_PORT          — host port for the smoke test container
#                           (default: 3210)

set -euo pipefail

# -- ANSI helpers (no-op if stdout isn't a tty) -----------------------------
if [[ -t 1 ]]; then
    C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_OK=$'\033[32m'
    C_WARN=$'\033[33m'; C_BAD=$'\033[31m'; C_RST=$'\033[0m'
else
    C_BOLD=""; C_DIM=""; C_OK=""; C_WARN=""; C_BAD=""; C_RST=""
fi
say()  { printf '%s\n' "$*"; }
step() { printf "${C_BOLD}==> %s${C_RST}\n" "$*"; }
ok()   { printf "    ${C_OK}✓${C_RST} %s\n" "$*"; }
warn() { printf "    ${C_WARN}!${C_RST} %s\n" "$*" >&2; }
die()  { printf "${C_BAD}error:${C_RST} %s\n" "$*" >&2; exit 1; }

# A non-empty assignment that explicitly bails when the captured
# string is empty. Catches silent failures where `jq -r` returns ""
# because the JSON path didn't match — without this, downstream
# `curl /api/.../$EMPTY/...` calls hit the wrong route and produce
# misleading error messages.
require_nonempty() {
    local val="$1" name="$2"
    [[ -n "$val" ]] || die "$name resolved to empty (upstream call failed)"
}

# Cleanup is registered up front and parameterised on the container
# name; the smoke phase fills in $SMOKE_NAME when it actually starts a
# container. This way a Ctrl+C between the build phase and `docker run`
# doesn't get tripped by a half-installed trap.
SMOKE_NAME=""
VNU_SMOKE_NAME=""
cleanup() {
    [[ -n "$SMOKE_NAME" ]] && docker rm -f "$SMOKE_NAME" >/dev/null 2>&1
    [[ -n "$VNU_SMOKE_NAME" ]] && docker rm -f "$VNU_SMOKE_NAME" >/dev/null 2>&1
    true
}
trap cleanup EXIT

# -- arg parsing ------------------------------------------------------------
PUSH=0; TAG_SOURCE=0; SYNC=1; ALLOW_DIRTY=0; NO_CACHE=0; YES=0
HOST_NETWORK=1   # default ON — see [B] phase comment for why
for arg in "$@"; do
    case "$arg" in
        --push)               PUSH=1 ;;
        --tag-source)         TAG_SOURCE=1 ;;
        --no-sync)            SYNC=0 ;;
        --allow-dirty)        ALLOW_DIRTY=1 ;;
        --no-cache)           NO_CACHE=1 ;;
        --no-host-network)    HOST_NETWORK=0 ;;
        --yes|-y)             YES=1 ;;
        -h|--help)            sed -n '2,62p' "$0"; exit 0 ;;
        *)                    die "unknown arg: $arg (try --help)" ;;
    esac
done
[[ $TAG_SOURCE -eq 1 && $PUSH -eq 0 ]] && \
    die "--tag-source requires --push (no point tagging an unpushed build)"

# -- paths + dependency probe -----------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LATEXML_PATH="${LATEXML_PATH:-$(cd "$REPO_ROOT/.." && pwd)/latexml-oxide}"
LATEXML_OXIDE_REF="${LATEXML_OXIDE_REF:-master}"
# Match `build-and-push.sh`'s IMAGE convention exactly:
# `ghcr.io/<owner>/<repo>/ar5iv-editor:tag` — three path segments,
# the last one a literal `ar5iv-editor`. GHCR organises packages
# under a repo, and the box's docker-compose pulls from this path,
# so any divergence here means we'd push to a different package
# than what the deploy is configured to fetch (silent footgun).
IMAGE_BASE="${IMAGE_BASE:-ghcr.io/$(git -C "$REPO_ROOT" config --get remote.origin.url \
    | sed -E 's|.*[:/]([^/]+/[^/.]+)(\.git)?$|\1|')/ar5iv-editor}"
# Companion vnu validation-service image — same namespace, same tags.
VALIDATOR_IMAGE_BASE="${VALIDATOR_IMAGE_BASE:-${IMAGE_BASE%/*}/ar5iv-validator}"
SMOKE_PORT="${SMOKE_PORT:-3210}"
VNU_SMOKE_PORT="${VNU_SMOKE_PORT:-3211}"

for tool in docker curl jq git awk sed; do
    command -v "$tool" >/dev/null || die "'$tool' is required"
done

[[ -d "$LATEXML_PATH/.git" ]] || \
    die "latexml-oxide not found at $LATEXML_PATH (set LATEXML_PATH=… or pass --no-sync)"

# Force BuildKit so the multi-stage Dockerfile parallelises across stages.
# build-and-push.sh respects this via inherited env.
export DOCKER_BUILDKIT=1

# -- timing helpers ---------------------------------------------------------
PIPE_START=$SECONDS
phase_start() { PHASE_START=$SECONDS; PHASE_NAME="$1"; step "$PHASE_NAME"; }
phase_end()   { ok "$PHASE_NAME — $(( SECONDS - PHASE_START ))s"; }

# ---------------------------------------------------------------------------
# A1. Sync latexml-oxide
# ---------------------------------------------------------------------------
if [[ $SYNC -eq 1 ]]; then
    phase_start "[A1] sync latexml-oxide ($LATEXML_OXIDE_REF)"

    # Refuse to clobber uncommitted changes in latexml-oxide. The
    # checkout below would silently fail (and set-e bail) on staged
    # edits — surface this as a recognisable error instead. Same
    # `--allow-dirty` escape valve as for ar5iv-editor.
    LATEXML_DIRTY=$(git -C "$LATEXML_PATH" status --porcelain | awk '/^[^?]/' || true)
    if [[ -n "$LATEXML_DIRTY" ]]; then
        if [[ $ALLOW_DIRTY -eq 0 ]]; then
            say "$LATEXML_DIRTY"
            die "latexml-oxide has uncommitted tracked changes (commit/stash, or pass --allow-dirty)"
        fi
        warn "latexml-oxide working tree dirty (--allow-dirty); skipping checkout/pull"
    else
        # Don't `--quiet` — fetch/pull errors should reach stderr so we
        # don't build against stale state on a network blip or expired
        # token.
        git -C "$LATEXML_PATH" fetch origin
        git -C "$LATEXML_PATH" checkout "$LATEXML_OXIDE_REF"
        # `pull --ff-only` only makes sense on an actual branch.
        if git -C "$LATEXML_PATH" symbolic-ref -q HEAD >/dev/null; then
            git -C "$LATEXML_PATH" pull --ff-only
        fi
    fi
    phase_end
fi

LATEXML_SHA=$(git -C "$LATEXML_PATH" rev-parse --short "$LATEXML_OXIDE_REF" 2>/dev/null) \
    || die "cannot resolve $LATEXML_OXIDE_REF in $LATEXML_PATH"
LATEXML_DATE=$(git -C "$LATEXML_PATH" log -1 --format=%cs "$LATEXML_OXIDE_REF")

# ---------------------------------------------------------------------------
# A2. Verify ar5iv-editor working tree
# ---------------------------------------------------------------------------
phase_start "[A2] verify ar5iv-editor working tree"
DIRTY=$(git -C "$REPO_ROOT" status --porcelain | awk '/^[^?]/' || true)
if [[ -n "$DIRTY" ]]; then
    if [[ $ALLOW_DIRTY -eq 0 ]]; then
        say "$DIRTY"
        die "ar5iv-editor has uncommitted tracked changes (commit/stash, or pass --allow-dirty)"
    fi
    warn "building from a dirty working tree (--allow-dirty)"
fi
AR5IV_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
AR5IV_BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)
[[ "$AR5IV_BRANCH" != "main" ]] && \
    warn "ar5iv-editor is on '$AR5IV_BRANCH', not 'main'"
[[ "$LATEXML_OXIDE_REF" != "master" ]] && \
    warn "latexml-oxide ref is '$LATEXML_OXIDE_REF', not 'master'"
phase_end

# ---------------------------------------------------------------------------
# A3. Pre-flight — registry auth (only if we'll push)
# ---------------------------------------------------------------------------
# Cheap manifest probe against the registry. Fails fast if the docker
# config lacks credentials for ghcr.io, sparing you a 10-min build.
# We probe `:latest` because it's guaranteed to exist after the first
# release. On a literal first-ever push this manifest call fails with
# a 404 — that's also fine; what we're really detecting is 401.
if [[ $PUSH -eq 1 ]]; then
    phase_start "[A3] pre-flight registry auth"
    REGISTRY_HOST="${IMAGE_BASE%%/*}"
    # Capture the manifest probe's combined output, then pattern-match
    # against it. Doing this in a `cmd | grep` pipe would interact
    # badly with `set -o pipefail` — docker exits non-zero on
    # "manifest unknown", and pipefail propagates that even when grep
    # matches, causing the auth check to falsely fail.
    AUTH_OK=0
    if docker manifest inspect "$IMAGE_BASE:latest" >/dev/null 2>&1; then
        AUTH_OK=1
    else
        OUT=$(docker manifest inspect "$IMAGE_BASE:latest" 2>&1 || true)
        case "$OUT" in
            *"manifest unknown"*|*"not found"*|*"404"*) AUTH_OK=1 ;;
        esac
    fi
    if [[ $AUTH_OK -eq 0 ]]; then
        die "cannot inspect $IMAGE_BASE:latest on $REGISTRY_HOST — run 'docker login $REGISTRY_HOST' first"
    fi
    ok "authed to $REGISTRY_HOST"
    phase_end
fi

# ---------------------------------------------------------------------------
# Plan summary + changelog since the last deploy- tag
# ---------------------------------------------------------------------------
DATE_TAG=$(date +%Y%m%d)
LATEST_TAG="$IMAGE_BASE:latest"
DATED_TAG="$IMAGE_BASE:$DATE_TAG-$LATEXML_SHA"
VNU_LATEST_TAG="$VALIDATOR_IMAGE_BASE:latest"
VNU_DATED_TAG="$VALIDATOR_IMAGE_BASE:$DATE_TAG-$LATEXML_SHA"

# Note: we no longer pre-flight-warn that `deploy-YYYYMMDD-<sha>` exists
# locally. The E1 step is now idempotent — if the tag already exists
# locally with the same SHA, `git push origin` is a no-op (recovers
# from a previous run that pushed the image but failed before pushing
# the tag); if it exists with a *different* SHA, push will fail with
# a clear "tag already exists" error and we surface it.

# Last deploy- tag, for the changelog. Empty string if no prior deploys.
LAST_DEPLOY_TAG=$(git -C "$REPO_ROOT" describe --tags --abbrev=0 \
    --match 'deploy-*' 2>/dev/null || true)

cat <<EOF

${C_BOLD}=========================================================${C_RST}
${C_BOLD}release plan${C_RST}
  ar5iv-editor:    $AR5IV_BRANCH @ $AR5IV_SHA
  latexml-oxide:   $LATEXML_OXIDE_REF @ $LATEXML_SHA ($LATEXML_DATE)
  image (latest):  $LATEST_TAG
  image (dated):   $DATED_TAG
  vnu (latest):    $VNU_LATEST_TAG
  vnu (dated):     $VNU_DATED_TAG
  push:            $([[ $PUSH -eq 1 ]] && echo yes || echo no)
  tag source:      $([[ $TAG_SOURCE -eq 1 ]] && echo yes || echo no)
  no-cache:        $([[ $NO_CACHE -eq 1 ]] && echo yes || echo no)
EOF

if [[ -n "$LAST_DEPLOY_TAG" ]]; then
    say
    say "${C_BOLD}commits since $LAST_DEPLOY_TAG:${C_RST}"
    git -C "$REPO_ROOT" log --oneline --no-decorate "$LAST_DEPLOY_TAG..HEAD" | sed 's/^/  /'
    DIFF_LINES=$(git -C "$REPO_ROOT" log --oneline "$LAST_DEPLOY_TAG..HEAD" | wc -l | tr -d ' ')
    [[ "$DIFF_LINES" -eq 0 ]] && warn "no new commits since $LAST_DEPLOY_TAG — re-deploying same source"
fi

say "${C_BOLD}=========================================================${C_RST}"

# Last chance to bail before the long-running step.
if [[ $PUSH -eq 1 && $YES -eq 0 ]]; then
    say
    say "${C_DIM}push enabled — proceeding in 5s (Ctrl+C to abort)${C_RST}"
    sleep 5
fi

# ---------------------------------------------------------------------------
# B. Build (delegate to build-and-push.sh, no --push)
# ---------------------------------------------------------------------------
phase_start "[B] build $LATEST_TAG"
# Build flags assembled in this order:
#   1. `--network=host` by default — BuildKit's isolated build network
#      doesn't always inherit the host's DNS, which makes `apt-get
#      update` inside the Dockerfile fail to resolve `deb.debian.org`
#      in sandbox-style environments. Host networking is the same
#      mode `docker run` uses by default and works everywhere we've
#      tried. Pass `--no-host-network` to opt back into BuildKit's
#      isolated network if you need it.
#   2. `--no-cache` when --no-cache is set on release.sh.
#   3. Anything the caller already had in $DOCKER_BUILD_EXTRA, so
#      power users can layer extra flags via the env without losing
#      our defaults.
BUILD_ARGS=()
[[ $HOST_NETWORK -eq 1 ]] && BUILD_ARGS+=(--network=host)
[[ $NO_CACHE -eq 1 ]] && BUILD_ARGS+=(--no-cache)
# Append (not overwrite) the caller-supplied env so external usage
# (e.g. CI passing --build-arg) survives.
COMBINED_EXTRA="${BUILD_ARGS[*]:-} ${DOCKER_BUILD_EXTRA:-}"
COMBINED_EXTRA="${COMBINED_EXTRA## }"
COMBINED_EXTRA="${COMBINED_EXTRA%% }"

# build-and-push.sh respects $IMAGE; we don't pass --push because we
# want the smoke test to gate the registry push.
IMAGE="$LATEST_TAG" \
VALIDATOR_IMAGE="$VNU_LATEST_TAG" \
LATEXML_PATH="$LATEXML_PATH" \
LATEXML_OXIDE_REF="$LATEXML_OXIDE_REF" \
DOCKER_BUILDKIT=1 \
DOCKER_BUILD_EXTRA="$COMBINED_EXTRA" \
    "$REPO_ROOT/deploy/build-and-push.sh"
phase_end

# ---------------------------------------------------------------------------
# Image-size delta vs the previous tag (warn if it grew >100 MB)
# ---------------------------------------------------------------------------
NEW_SIZE_BYTES=$(docker image inspect "$LATEST_TAG" --format='{{.Size}}')
NEW_SIZE_HUMAN=$(awk "BEGIN { printf \"%.0f MB\", $NEW_SIZE_BYTES / 1024 / 1024 }")
if [[ -n "$LAST_DEPLOY_TAG" ]]; then
    PREV_LATEXML_SHA="${LAST_DEPLOY_TAG##*-}"
    PREV_DATE="${LAST_DEPLOY_TAG#deploy-}"; PREV_DATE="${PREV_DATE%-*}"
    PREV_DATED_TAG="$IMAGE_BASE:$PREV_DATE-$PREV_LATEXML_SHA"
    if PREV_BYTES=$(docker image inspect "$PREV_DATED_TAG" --format='{{.Size}}' 2>/dev/null); then
        DELTA_MB=$(awk "BEGIN { printf \"%.0f\", ($NEW_SIZE_BYTES - $PREV_BYTES) / 1024 / 1024 }")
        if [[ "$DELTA_MB" -gt 100 ]]; then
            warn "image grew ${DELTA_MB} MB vs $PREV_DATED_TAG — investigate before pushing"
        elif [[ "$DELTA_MB" -lt -100 ]]; then
            ok "image shrank ${DELTA_MB#-} MB vs $PREV_DATED_TAG"
        else
            ok "image size $NEW_SIZE_HUMAN (Δ ${DELTA_MB} MB vs $PREV_DATED_TAG)"
        fi
    else
        ok "image size $NEW_SIZE_HUMAN (no local copy of $PREV_DATED_TAG to diff against)"
    fi
else
    ok "image size $NEW_SIZE_HUMAN"
fi

# ---------------------------------------------------------------------------
# B3. Local smoke test
# ---------------------------------------------------------------------------
phase_start "[B3] smoke-test on :$SMOKE_PORT"

# Generate the container name now that we're actually about to run.
# The cleanup trap is already installed; setting $SMOKE_NAME activates it.
SMOKE_NAME="ar5iv-smoke-$(date +%s)-$$"

# Detect port collision via docker itself — that's portable across
# Linux/macOS where `ss` and `lsof` differ. If the run fails because
# the port is busy, fall back to a docker-assigned random port.
if ! CONTAINER_ID=$(docker run --rm -d -p "$SMOKE_PORT:3000" --name "$SMOKE_NAME" "$LATEST_TAG" 2>&1); then
    if echo "$CONTAINER_ID" | grep -qE 'address already in use|port is already allocated'; then
        warn "port $SMOKE_PORT busy, falling back to a random port"
        CONTAINER_ID=$(docker run --rm -d -P --name "$SMOKE_NAME" "$LATEST_TAG")
        SMOKE_PORT=$(docker port "$CONTAINER_ID" 3000/tcp | awk -F: 'NR==1{print $NF}')
        require_nonempty "$SMOKE_PORT" "fallback smoke port"
    else
        die "docker run failed: $CONTAINER_ID"
    fi
fi

# Wait for the binary to start serving HTTP. /about is an Askama
# template that needs no engine work, so it returns 200 well before
# the conversion worker thread has finished its lazy init — that's
# fine for a smoke test of "did the binary boot and bind", which is
# what we're verifying. Engine readiness is implied by the kernel-
# dump check below.
deadline=$((SECONDS + 30))
until curl -fsS "http://127.0.0.1:$SMOKE_PORT/about" >/dev/null 2>&1; do
    if [[ $SECONDS -gt $deadline ]]; then
        say "${C_BAD}--- container logs ---${C_RST}" >&2
        docker logs "$CONTAINER_ID" 2>&1 | tail -50 >&2 || true
        die "container did not start serving HTTP within 30s"
    fi
    sleep 1
done
ok "container serving HTTP"

# /api/version must report the SHA we just synced — guards against a
# stale build cache silently re-using an older binary.
LIVE_SHA=$(curl -fsS "http://127.0.0.1:$SMOKE_PORT/api/version" | jq -r '.latexml_oxide.sha // empty')
require_nonempty "$LIVE_SHA" "/api/version → latexml_oxide.sha"
[[ "$LIVE_SHA" == "$LATEXML_SHA" ]] || \
    die "image reports latexml_oxide.sha=$LIVE_SHA, expected $LATEXML_SHA"
ok "version marker matches: $LIVE_SHA"

# Kernel dumps must exist on disk inside the image. The HTTP layer
# above won't catch a missing dump file because dumps load lazily on
# first conversion — but a missing dump file IS the most common cause
# of "image looked fine, prod broke".
# Use --user root so a future Dockerfile permissions tightening
# can't make this opaque. We're just listing one directory; no
# privilege escalation footprint.
DUMPS=$(docker exec --user root "$CONTAINER_ID" ls /app/dumps 2>/dev/null || true)
echo "$DUMPS" | grep -Eq '^plain\.[0-9]{4}\.dump\.txt$' || die "/app/dumps/plain.<year>.dump.txt missing in image"
echo "$DUMPS" | grep -Eq '^latex\.[0-9]{4}\.dump\.txt$' || die "/app/dumps/latex.<year>.dump.txt missing in image"
ok "kernel dumps present (plain.<year>.dump.txt, latex.<year>.dump.txt)"

# Editor shell must serve markup that includes the wordmark and the
# bundled main.js — confirms the askama template + frontend bundle
# are both wired up.
EDITOR_HTML=$(curl -fsS "http://127.0.0.1:$SMOKE_PORT/editor")
echo "$EDITOR_HTML" | grep -q 'ar5iv' || die "/editor markup missing the ar5iv wordmark"
echo "$EDITOR_HTML" | grep -q '/static/main.js' || die "/editor missing the main.js script tag"
ok "/editor serves the wired shell"

# Full lifecycle: mint a user, create a session, write a file, list it.
# Catches binary-side regressions in the session manager + file panel
# without touching the WebSocket convert path (which would need a WS
# client).
USER_ID=$(curl -fsS -X POST "http://127.0.0.1:$SMOKE_PORT/api/user" | jq -r '.user_id // empty')
require_nonempty "$USER_ID" "POST /api/user → user_id"
SESSION_ID=$(curl -fsS -X POST "http://127.0.0.1:$SMOKE_PORT/api/session" \
    -H "x-ar5iv-user: $USER_ID" -H 'content-type: application/json' \
    -d '{"slot":"blank"}' | jq -r '.id // empty')
require_nonempty "$SESSION_ID" "POST /api/session → id"
curl -fsS -X PUT "http://127.0.0.1:$SMOKE_PORT/api/session/$SESSION_ID/files/main.tex" \
    -H "x-ar5iv-user: $USER_ID" \
    --data-binary $'\\documentclass{article}\\begin{document}smoke\\end{document}\n' \
    >/dev/null
LIST=$(curl -fsS "http://127.0.0.1:$SMOKE_PORT/api/session/$SESSION_ID/files" \
    -H "x-ar5iv-user: $USER_ID" | jq -r '.files[].path' | tr '\n' ' ')
echo "$LIST" | grep -q 'main.tex' || die "session lifecycle failed (got: $LIST)"
ok "session lifecycle ok (user → session → put → list)"

# Convert round-trip: prove the engine actually renders something. The
# kernel dumps load lazily on the first conversion; the dump-file ls
# above proves the files exist on disk, but only this round-trip
# proves they parse and feed the engine. websocat is optional so the
# script still runs on machines without it (with a degraded smoke).
if ! command -v websocat >/dev/null 2>&1; then
    warn "websocat not installed — skipping convert round-trip (degraded smoke)"
    warn "  install: 'cargo install websocat' or 'brew install websocat' / 'apt install websocat'"
else
    # GNU `timeout` on Linux, `gtimeout` (via coreutils) on macOS;
    # fall through to no timeout if neither — websocat's `-n1` exits
    # naturally on the first response frame, so a missing timeout just
    # means "Ctrl+C if the server hangs".
    WS_TIMEOUT=""
    for cand in timeout gtimeout; do
        command -v "$cand" >/dev/null 2>&1 && { WS_TIMEOUT="$cand 60"; break; }
    done

    WS_URL="ws://127.0.0.1:$SMOKE_PORT/convert?session_id=$SESSION_ID&user_id=$USER_ID"
    WS_REQ=$(jq -nc '{
        id: 1,
        active_file: "main.tex",
        version: 0,
        profile: "fragment",
        format: "html5",
        preload: ["LaTeX.pool", "article.cls"]
    }')

    if ! WS_RESP=$(printf '%s\n' "$WS_REQ" | $WS_TIMEOUT websocat -n1 "$WS_URL" 2>&1); then
        die "WS convert round-trip failed: $WS_RESP"
    fi

    # status_code: 0 = clean, 2 = errors-but-still-rendered. Anything
    # else (3 = fatal, 4 = session_expired, …) is a release-blocker.
    WS_STATUS=$(echo "$WS_RESP" | jq -r '.status_code // -1')
    case "$WS_STATUS" in
        0|2) : ;;
        *)   die "convert returned status_code=$WS_STATUS — full response: $WS_RESP" ;;
    esac
    WS_RESULT_LEN=$(echo "$WS_RESP" | jq -r '(.result // "") | length')
    [[ "$WS_RESULT_LEN" -gt 100 ]] || die "convert produced suspiciously small result (${WS_RESULT_LEN} bytes)"
    echo "$WS_RESP" | jq -r '.result' | grep -q '<' || die "convert result has no HTML tags"
    ok "convert round-trip ok (status_code=$WS_STATUS, ${WS_RESULT_LEN}-byte HTML5)"
fi

# Tear down explicitly. The EXIT trap stays armed — it's a no-op
# once $SMOKE_NAME points at a removed container.
cleanup
SMOKE_NAME=""
phase_end

# ---------------------------------------------------------------------------
# B4. vnu service smoke test
# ---------------------------------------------------------------------------
phase_start "[B4] vnu smoke-test on :$VNU_SMOKE_PORT"
VNU_SMOKE_NAME="vnu-smoke-$(date +%s)-$$"
if ! VNU_CONTAINER_ID=$(docker run --rm -d -p "$VNU_SMOKE_PORT:8888" --name "$VNU_SMOKE_NAME" "$VNU_LATEST_TAG" 2>&1); then
    die "docker run failed for $VNU_LATEST_TAG: $VNU_CONTAINER_ID"
fi
deadline=$((SECONDS + 45))
until curl -fsS -A release-smoke "http://127.0.0.1:$VNU_SMOKE_PORT/" >/dev/null 2>&1; do
    if [[ $SECONDS -gt $deadline ]]; then
        say "${C_BAD}--- vnu container logs ---${C_RST}" >&2
        docker logs "$VNU_CONTAINER_ID" 2>&1 | tail -30 >&2 || true
        die "vnu service did not start serving HTTP within 45s"
    fi
    sleep 1
done
ok "vnu serving HTTP"
# Validation round-trip with the scholarly preset: a minimal LaTeXML
# page shell must come back clean, proving the schema bundle baked
# into this vnu.jar resolves and the preset is HTML-appropriate.
VNU_DOC='<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>s</title></head><body class="ltx_page_root"><div class="ltx_page_main"><div class="ltx_page_content"><article class="ltx_document"></article></div><footer class="ltx_page_footer"></footer></div></body></html>'
VNU_SCHEMA='http://s.validator.nu/html5-scholarly.rnc http://s.validator.nu/html5/assertions.sch http://c.validator.nu/all/'
VNU_RESP=$(printf '%s' "$VNU_DOC" | curl -fsS -A release-smoke \
    -H 'Content-Type: text/html; charset=utf-8' \
    --data-binary @- \
    "http://127.0.0.1:$VNU_SMOKE_PORT/?out=json&schema=$(jq -rn --arg s "$VNU_SCHEMA" '$s|@uri')" \
    2>&1) || die "vnu validation round-trip failed: $VNU_RESP"
VNU_ERRORS=$(echo "$VNU_RESP" | jq '[.messages[] | select(.type=="error")] | length')
[[ "$VNU_ERRORS" == "0" ]] || die "vnu smoke doc should be clean, got: $(echo "$VNU_RESP" | jq -c '.messages')"
ok "scholarly validation round-trip ok (0 errors)"
docker rm -f "$VNU_SMOKE_NAME" >/dev/null 2>&1 || true
VNU_SMOKE_NAME=""
phase_end

if [[ $PUSH -eq 0 ]]; then
    cat <<EOF

${C_OK}build complete — image NOT pushed (rerun with --push when ready).${C_RST}
  image:   $LATEST_TAG
  size:    $NEW_SIZE_HUMAN
  total:   $(( SECONDS - PIPE_START ))s

EOF
    exit 0
fi

# ---------------------------------------------------------------------------
# C. Push (latest + dated)
# ---------------------------------------------------------------------------
phase_start "[C] tag + push"
docker tag "$LATEST_TAG" "$DATED_TAG"
PUSH_START=$SECONDS
docker push "$LATEST_TAG"
docker push "$DATED_TAG"
docker tag "$VNU_LATEST_TAG" "$VNU_DATED_TAG"
docker push "$VNU_LATEST_TAG"
docker push "$VNU_DATED_TAG"
PUSH_DUR=$(( SECONDS - PUSH_START ))
ok "registry push completed in ${PUSH_DUR}s"
phase_end

# ---------------------------------------------------------------------------
# E1. Tag the source commit
# ---------------------------------------------------------------------------
if [[ $TAG_SOURCE -eq 1 ]]; then
    DEPLOY_TAG="deploy-$DATE_TAG-$LATEXML_SHA"
    phase_start "[E1] git tag $DEPLOY_TAG"
    # Idempotent recovery from a prior run that pushed the image but
    # failed before pushing the tag:
    #   - local exists, points at HEAD → reuse it (skip `tag -a`)
    #   - local exists, points elsewhere → abort (someone else moved it)
    #   - local doesn't exist → create it
    # In all cases that survive the above, push to origin. `git push`
    # is a no-op when origin already has the same ref at the same SHA,
    # so we recover automatically.
    HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
    if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$DEPLOY_TAG" >/dev/null; then
        EXISTING_SHA=$(git -C "$REPO_ROOT" rev-parse "$DEPLOY_TAG^{commit}")
        if [[ "$EXISTING_SHA" != "$HEAD_SHA" ]]; then
            die "tag $DEPLOY_TAG already exists on a different commit ($EXISTING_SHA, want $HEAD_SHA)"
        fi
        ok "local tag $DEPLOY_TAG already at HEAD; only pushing"
    else
        git -C "$REPO_ROOT" tag -a "$DEPLOY_TAG" \
            -m "deployed with latexml-oxide @${LATEXML_SHA} ($LATEXML_DATE)"
    fi
    git -C "$REPO_ROOT" push origin "refs/tags/$DEPLOY_TAG"
    phase_end
fi

# ---------------------------------------------------------------------------
# Cheat sheet
# ---------------------------------------------------------------------------
TOTAL=$(( SECONDS - PIPE_START ))
cat <<EOF

${C_BOLD}=========================================================${C_RST}
${C_OK}release done in ${TOTAL}s.${C_RST} tags pushed:
  $LATEST_TAG
  $DATED_TAG
  $VNU_LATEST_TAG
  $VNU_DATED_TAG
$([[ $TAG_SOURCE -eq 1 ]] && echo "  git tag pushed:  deploy-$DATE_TAG-$LATEXML_SHA")

next, on the deploy box (the .env pins BOTH images to dated tags):

    ssh root@<vultr-ip>
    cd /opt/ar5iv-editor/deploy
    sed -i -E 's|(ar5iv-editor:)[0-9]+-[0-9a-f]+|\1$DATE_TAG-$LATEXML_SHA|; s|(ar5iv-validator:)[0-9]+-[0-9a-f]+|\1$DATE_TAG-$LATEXML_SHA|' .env
    grep -q AR5IV_VALIDATOR_IMAGE .env || \\
        echo 'AR5IV_VALIDATOR_IMAGE=$VNU_DATED_TAG' >> .env
    docker compose pull
    docker compose up -d
    docker compose ps          # all three services up, two 'healthy'
    curl -fsS https://<your-domain>/api/version | jq .latexml_oxide.sha
    # → should print "$LATEXML_SHA"

rollback (if it goes sideways): repin .env to the previous dated tags,
then docker compose pull && docker compose up -d
${C_BOLD}=========================================================${C_RST}
EOF
