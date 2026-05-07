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
#                           (default: ghcr.io/<owner>/ar5iv-editor,
#                            owner inferred from origin url)
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

# -- arg parsing ------------------------------------------------------------
PUSH=0; TAG_SOURCE=0; SYNC=1; ALLOW_DIRTY=0; NO_CACHE=0; YES=0
for arg in "$@"; do
    case "$arg" in
        --push)         PUSH=1 ;;
        --tag-source)   TAG_SOURCE=1 ;;
        --no-sync)      SYNC=0 ;;
        --allow-dirty)  ALLOW_DIRTY=1 ;;
        --no-cache)     NO_CACHE=1 ;;
        --yes|-y)       YES=1 ;;
        -h|--help)      sed -n '2,52p' "$0"; exit 0 ;;
        *)              die "unknown arg: $arg (try --help)" ;;
    esac
done
[[ $TAG_SOURCE -eq 1 && $PUSH -eq 0 ]] && \
    die "--tag-source requires --push (no point tagging an unpushed build)"

# -- paths + dependency probe -----------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LATEXML_PATH="${LATEXML_PATH:-$(cd "$REPO_ROOT/.." && pwd)/latexml-oxide}"
LATEXML_OXIDE_REF="${LATEXML_OXIDE_REF:-master}"
IMAGE_BASE="${IMAGE_BASE:-ghcr.io/$(git -C "$REPO_ROOT" config --get remote.origin.url \
    | sed -E 's|.*[:/]([^/]+/[^/.]+)(\.git)?$|\1|')}"
SMOKE_PORT="${SMOKE_PORT:-3210}"
SMOKE_NAME="ar5iv-smoke-$(date +%s)-$$"

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
    # Don't `--quiet` — fetch/pull errors should reach stderr so we don't
    # build against stale state on a network blip or expired token.
    git -C "$LATEXML_PATH" fetch origin
    git -C "$LATEXML_PATH" checkout "$LATEXML_OXIDE_REF"
    # `pull --ff-only` is a no-op on a detached HEAD or annotated tag —
    # tolerate that with `|| true` only for those non-branch refs.
    if git -C "$LATEXML_PATH" symbolic-ref -q HEAD >/dev/null; then
        git -C "$LATEXML_PATH" pull --ff-only
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
    AUTH_OK=0
    if docker manifest inspect "$IMAGE_BASE:latest" >/dev/null 2>&1; then
        AUTH_OK=1
    elif docker manifest inspect "$IMAGE_BASE:latest" 2>&1 | grep -qE 'manifest unknown|not found|404'; then
        AUTH_OK=1   # 404 means we're authed, the tag just doesn't exist yet
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

# `deploy-YYYYMMDD-<sha>` already exists? Plan needs to know up front so
# we don't push the image and then fail on `git tag`.
if [[ $TAG_SOURCE -eq 1 ]]; then
    if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/deploy-$DATE_TAG-$LATEXML_SHA" >/dev/null; then
        warn "git tag deploy-$DATE_TAG-$LATEXML_SHA already exists — will skip the source-tag step"
        TAG_SOURCE=0
    fi
fi

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
    say "${C_DIM}push enabled — Ctrl+C within 5s to abort${C_RST}"
    for i in 5 4 3 2 1; do printf '%s ' "$i"; sleep 1; done
    say
fi

# ---------------------------------------------------------------------------
# B. Build (delegate to build-and-push.sh, no --push)
# ---------------------------------------------------------------------------
phase_start "[B] build $LATEST_TAG"
BUILD_ARGS=()
[[ $NO_CACHE -eq 1 ]] && BUILD_ARGS+=(--no-cache)

# build-and-push.sh respects $IMAGE; we don't pass --push because we
# want the smoke test to gate the registry push.
IMAGE="$LATEST_TAG" \
LATEXML_PATH="$LATEXML_PATH" \
LATEXML_OXIDE_REF="$LATEXML_OXIDE_REF" \
DOCKER_BUILDKIT=1 \
DOCKER_BUILD_EXTRA="${BUILD_ARGS[*]:-}" \
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

# Pre-emptively remove any stale container with this name (PID reuse
# is rare across reboots, but a previous aborted run can leave one).
docker rm -f "$SMOKE_NAME" >/dev/null 2>&1 || true

# Detect port collision via docker itself — that's portable across
# Linux/macOS where `ss` and `lsof` differ. If the run fails because
# the port is busy, fall back to an alternate port.
if ! CONTAINER_ID=$(docker run --rm -d -p "$SMOKE_PORT:3000" --name "$SMOKE_NAME" "$LATEST_TAG" 2>&1); then
    if echo "$CONTAINER_ID" | grep -qE 'address already in use|port is already allocated'; then
        warn "port $SMOKE_PORT busy, falling back to a random port"
        CONTAINER_ID=$(docker run --rm -d -P --name "$SMOKE_NAME" "$LATEST_TAG")
        SMOKE_PORT=$(docker port "$CONTAINER_ID" 3000/tcp | awk -F: 'NR==1{print $NF}')
    else
        die "docker run failed: $CONTAINER_ID"
    fi
fi
cleanup() { docker rm -f "$SMOKE_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Wait for the /about healthcheck endpoint.
deadline=$((SECONDS + 30))
until curl -fsS "http://127.0.0.1:$SMOKE_PORT/about" >/dev/null 2>&1; do
    if [[ $SECONDS -gt $deadline ]]; then
        say "${C_BAD}--- container logs ---${C_RST}" >&2
        docker logs "$CONTAINER_ID" 2>&1 | tail -50 >&2 || true
        die "container did not become healthy within 30s"
    fi
    sleep 1
done
ok "container healthy"

# /api/version must report the SHA we just synced — guards against a
# stale build cache silently re-using an older binary.
LIVE_SHA=$(curl -fsS "http://127.0.0.1:$SMOKE_PORT/api/version" | jq -r '.latexml_oxide.sha')
[[ "$LIVE_SHA" == "$LATEXML_SHA" ]] || \
    die "image reports latexml_oxide.sha=$LIVE_SHA, expected $LATEXML_SHA"
ok "version marker matches: $LIVE_SHA"

# Kernel dumps must exist on disk inside the image. The HTTP layer
# above won't catch a missing dump file because dumps load lazily on
# first conversion — but a missing dump file IS the most common cause
# of "image looked fine, prod broke".
DUMPS=$(docker exec "$CONTAINER_ID" ls /app/dumps 2>/dev/null || true)
echo "$DUMPS" | grep -q 'plain.dump.txt' || die "/app/dumps/plain.dump.txt missing in image"
echo "$DUMPS" | grep -q 'latex.dump.txt' || die "/app/dumps/latex.dump.txt missing in image"
ok "kernel dumps present (plain.dump.txt, latex.dump.txt)"

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
USER_ID=$(curl -fsS -X POST "http://127.0.0.1:$SMOKE_PORT/api/user" | jq -r '.user_id')
SESSION_ID=$(curl -fsS -X POST "http://127.0.0.1:$SMOKE_PORT/api/session" \
    -H "x-ar5iv-user: $USER_ID" -H 'content-type: application/json' \
    -d '{"slot":"blank"}' | jq -r '.id')
curl -fsS -X PUT "http://127.0.0.1:$SMOKE_PORT/api/session/$SESSION_ID/files/main.tex" \
    -H "x-ar5iv-user: $USER_ID" \
    --data-binary $'\\documentclass{article}\\begin{document}smoke\\end{document}\n' \
    >/dev/null
LIST=$(curl -fsS "http://127.0.0.1:$SMOKE_PORT/api/session/$SESSION_ID/files" \
    -H "x-ar5iv-user: $USER_ID" | jq -r '.files[].path' | tr '\n' ' ')
echo "$LIST" | grep -q 'main.tex' || die "session lifecycle failed (got: $LIST)"
ok "session lifecycle ok (user → session → put → list)"

cleanup; trap - EXIT
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
docker push "$LATEST_TAG"
docker push "$DATED_TAG"
phase_end

# ---------------------------------------------------------------------------
# E1. Tag the source commit
# ---------------------------------------------------------------------------
if [[ $TAG_SOURCE -eq 1 ]]; then
    DEPLOY_TAG="deploy-$DATE_TAG-$LATEXML_SHA"
    phase_start "[E1] git tag $DEPLOY_TAG"
    git -C "$REPO_ROOT" tag -a "$DEPLOY_TAG" \
        -m "deployed with latexml-oxide @${LATEXML_SHA} ($LATEXML_DATE)"
    git -C "$REPO_ROOT" push origin "$DEPLOY_TAG"
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
$([[ $TAG_SOURCE -eq 1 ]] && echo "  git tag pushed:  deploy-$DATE_TAG-$LATEXML_SHA")

next, on the deploy box:

    ssh root@<vultr-ip>
    cd /opt/ar5iv-editor/deploy
    docker compose pull
    docker compose up -d
    docker compose ps          # both services 'healthy'
    curl -fsS https://<your-domain>/api/version | jq .latexml_oxide.sha
    # → should print "$LATEXML_SHA"

rollback (if it goes sideways):

    cd /opt/ar5iv-editor/deploy
    sed -i 's|/ar5iv-editor:latest|/ar5iv-editor:$DATE_TAG-$LATEXML_SHA|' .env
    docker compose pull && docker compose up -d
${C_BOLD}=========================================================${C_RST}
EOF
