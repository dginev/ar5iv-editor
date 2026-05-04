#!/usr/bin/env bash
# vultr-bootstrap.sh — one-shot bring-up of the ar5iv-editor stack
# on a fresh Vultr (or any Debian/Ubuntu) box.
#
# Combines Steps 3–4 of deploy/PLAN.md: install docker, sparse-checkout
# `deploy/`, mint an Anubis ed25519 cookie key, log in to ghcr.io, pull
# the private image, bring the compose stack up.
#
# Usage (from your laptop, root SSH already working on the box):
#
#   ssh root@${VULTR_IP} \
#       GH_USER="$GH_USER" GH_TOKEN="$GH_TOKEN" \
#       'bash -s' < deploy/vultr-bootstrap.sh
#
# Or copy + run on the box:
#
#   GH_USER=... GH_TOKEN=... ./vultr-bootstrap.sh
#
# Idempotent: re-running re-pulls the image and `compose up -d`s
# again. Will NOT clobber an existing .env (re-running keeps the
# Anubis key, so cookies issued earlier stay valid).

set -euo pipefail

# ---------- inputs ----------
: "${GH_USER:?set GH_USER to your github username for ghcr.io login}"
: "${GH_TOKEN:?set GH_TOKEN to a PAT with read:packages scope}"
GH_REPO="${GH_REPO:-ar5iv-editor}"
INSTALL_DIR="${INSTALL_DIR:-/opt/ar5iv-editor}"
IMAGE="${IMAGE:-ghcr.io/${GH_USER}/${GH_REPO}/${GH_REPO}:latest}"

echo "==> bootstrap target: ${INSTALL_DIR}"
echo "==> image:           ${IMAGE}"

# ---------- 1. base packages + docker ----------
# Skip the package step if docker is already installed (re-runs).
if ! command -v docker >/dev/null 2>&1; then
    echo "==> installing docker..."
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
    DEBIAN_FRONTEND=noninteractive apt-get -y install ca-certificates curl git openssl
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
else
    echo "==> docker already installed: $(docker --version)"
fi

# ---------- 2. sparse checkout of deploy/ ----------
mkdir -p "${INSTALL_DIR}"
cd "${INSTALL_DIR}"

if [ ! -d .git ]; then
    echo "==> sparse-checkout deploy/ from github..."
    git clone --filter=blob:none --no-checkout \
        "https://github.com/${GH_USER}/${GH_REPO}" .
    git sparse-checkout set deploy
    git checkout
else
    echo "==> repo already present, pulling latest deploy/"
    git fetch --depth=1 origin main
    git checkout origin/main -- deploy
fi

# ---------- 3. ghcr.io login ----------
echo "==> docker login ghcr.io as ${GH_USER}"
echo "${GH_TOKEN}" | docker login ghcr.io -u "${GH_USER}" --password-stdin

# ---------- 4. .env ----------
ENV_FILE="${INSTALL_DIR}/deploy/.env"
if [ ! -f "${ENV_FILE}" ]; then
    echo "==> minting fresh deploy/.env"
    # Anubis expects 32 raw bytes (= 64 hex chars). Don't change to
    # `-hex 64` — that produces 64 raw bytes and Anubis rejects it.
    KEY=$(openssl rand -hex 32)
    cat > "${ENV_FILE}" <<EOF
ANUBIS_KEY=${KEY}
COOKIE_DOMAIN=
AR5IV_IMAGE=${IMAGE}
EOF
    chmod 600 "${ENV_FILE}"
else
    echo "==> deploy/.env exists — keeping existing Anubis key"
    # Ensure AR5IV_IMAGE is in sync with the requested IMAGE.
    if ! grep -q "^AR5IV_IMAGE=${IMAGE}$" "${ENV_FILE}"; then
        sed -i "s|^AR5IV_IMAGE=.*|AR5IV_IMAGE=${IMAGE}|" "${ENV_FILE}"
        echo "==> updated AR5IV_IMAGE in .env to ${IMAGE}"
    fi
fi

# ---------- 5. pull + up ----------
cd "${INSTALL_DIR}/deploy"
echo "==> docker compose pull"
docker compose pull
echo "==> docker compose up -d"
docker compose up -d

echo
docker compose ps
echo
echo "==> bootstrap done. Smoke-test from your laptop:"
echo "    curl -fsS http://<vultr-ip>:8080/about | head -3"
