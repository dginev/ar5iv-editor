# Demo deploy plan — your specific Vultr box

A linear, step-by-step plan for getting the editor running on the
Vultr HF 2 GB box you just provisioned. Estimated wall time ~25
minutes, most of it waiting for image build + first DNS propagation.

## Variables to fill in once

Replace these in your shell as you go:

```sh
VULTR_IP="<paste-from-vultr-dashboard>"      # e.g. 192.0.2.42
DOMAIN="<your-domain>"                        # e.g. demo.example.org
GH_USER="<your-github-username>"
GH_TOKEN="<github-pat-with-write-packages>"   # https://github.com/settings/tokens?type=beta
IMAGE="ghcr.io/${GH_USER}/ar5iv-editor:latest"
```

If you don't have a domain handy yet, we can defer the TLS step and
demo via `http://<vultr-ip>:8080` for the first round of testing.

---

## Step 1 — Build + push the image (your laptop, 5–10 min)

The Dockerfile is verified working locally (391 MB image,
end-to-end smoke green). Push it to ghcr.io so the Vultr box can
pull it.

```sh
cd ~/git/ar5iv-editor

# Login to ghcr.io once.
echo "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin

# Build + push in one shot.
IMAGE="$IMAGE" deploy/build-and-push.sh --push
```

The first build is ~5–10 min (Rust release build dominates).
Subsequent builds reuse layers and are much faster.

After the push, mark the package public on ghcr.io if you don't
want to log in on the Vultr box too: <https://github.com/USER>?tab=packages
→ click `ar5iv-editor` → "Package settings" → "Change visibility"
→ Public. Otherwise, plan on `docker login` on the Vultr box too.

---

## Step 2 — Wait for Vultr install, then SSH in

Watch the Vultr dashboard until status flips from "Installing" to
"Running". Usually 60–90 seconds.

```sh
ssh root@${VULTR_IP}
# (accept host key prompt)
```

If the connection hangs, the box may still be booting cloud-init —
wait another minute and retry.

---

## Step 3 — Bootstrap the box (5 min on the Vultr server)

Inside the SSH session:

```sh
# Update + install docker.
apt-get update && apt-get -y upgrade
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker --version  # sanity check
```

You can paste these as one block; they take ~3 min total on the HF
2 GB tier.

---

## Step 4 — Pull the image + bring up the stack

Still on the Vultr box. We pull the deploy/ folder via sparse
checkout so we don't drag the whole repo down for 5 small files:

```sh
mkdir -p /opt/ar5iv-editor && cd /opt/ar5iv-editor

git clone --filter=blob:none --no-checkout \
    https://github.com/${GH_USER}/ar5iv-editor .
git sparse-checkout set deploy
git checkout

# If your image is private, log in to ghcr.io.
# echo "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin

# Mint a long-lived ed25519 private key for Anubis cookie signing.
cat > deploy/.env <<EOF
ANUBIS_KEY=$(openssl rand -hex 32)
COOKIE_DOMAIN=
AR5IV_IMAGE=ghcr.io/${GH_USER}/ar5iv-editor:latest
EOF

cd deploy
docker compose pull
docker compose up -d
docker compose ps   # both services should be 'running' / healthy
```

(Leave `COOKIE_DOMAIN` empty until you've added DNS — Caddy
overrides it later.)

---

## Step 5 — Pre-DNS smoke test (no TLS, direct port 8080)

Verify Anubis + the editor are reachable on the box's public IP
before involving DNS. This isolates "is the deploy working" from
"is the cert / DNS working".

From your laptop:

```sh
curl -fsS http://${VULTR_IP}:8080/about | head -3
```

If that returns the marketing page HTML, you're golden — the whole
stack is up.

If it hangs or 502s, on the Vultr box:

```sh
cd /opt/ar5iv-editor/deploy
docker compose logs --tail=50 ar5iv-editor anubis
```

Common causes: image pull blocked by ghcr.io being private (login
on the box), `ANUBIS_KEY` missing/short (regenerate),
firewall on the host (Vultr rarely enables one by default).

⚠️ Vultr's Cloud Firewall *is* off by default but check
**Server → Settings → Firewall** if step 5 hangs.

---

## Step 6 — Add DNS (~5 min propagation)

Once `curl http://${VULTR_IP}:8080/about` works, point your domain
at the box. In your DNS provider's UI:

```
A    demo    192.0.2.42         (replace with your VULTR_IP)
AAAA demo    2001:db8::1        (Vultr also gives you an IPv6)
```

Wait for propagation. Test:

```sh
dig +short ${DOMAIN}
# Should return ${VULTR_IP}.
```

---

## Step 7 — Install Caddy for TLS

Back on the Vultr box:

```sh
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy localhost:8080 {
        # Anubis 500s without X-Real-Ip; Caddy's reverse_proxy
        # only sets X-Forwarded-For by default.
        header_up X-Real-Ip {remote_host}
    }
}
EOF

systemctl restart caddy
```

Caddy auto-issues a Let's Encrypt cert on the first request. Test
from your laptop:

```sh
curl -fsS https://${DOMAIN}/about | head -3
```

If that works, also update Anubis's cookie domain so the same
session works across subdomains (only matters if you'll have one):

```sh
cd /opt/ar5iv-editor/deploy
sed -i 's/^COOKIE_DOMAIN=.*/COOKIE_DOMAIN='"${DOMAIN}"'/' .env
docker compose up -d  # re-applies env
```

---

## Step 8 — Open the editor in a browser

```
https://${DOMAIN}/editor
```

You'll see Anubis's "checking your browser" challenge for ~1–3
seconds (it's a JS proof-of-work). Then the editor loads. Confirm:

- Three-pane layout renders.
- File panel shows `main.tex`.
- Type a character into the editor; preview updates within ~1 s.
- Pick the "arXiv: 1709.07020" example from the dropdown — file
  tree should show 3 files unpacked from the tarball.

---

## Step 9 — CPU sanity-check (1 min)

Verify Vultr didn't ship you slow silicon in your region. From your
laptop:

```sh
cd ~/git/ar5iv-editor
URL="https://${DOMAIN}" deploy/cpu-sanity-check.sh
```

Look for `median=` under 90 ms. If it's >150 ms, the box is on
slower silicon than the typical HF tier promises — destroy and
redeploy in a different region (Atlanta, NYC, Frankfurt are the
most consistent).

---

## Step 10 — Take a Vultr snapshot

Dashboard → your server → Snapshots → **Take Snapshot**. ~$1/mo
storage cost, single-click rollback if you misconfigure something
later. Worth it.

---

## Step 11 — Optional: lock down SSH

```sh
# Disable password auth (you should already be on key-only).
sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/' \
    /etc/ssh/sshd_config
systemctl restart sshd

# Optional: disable root login over SSH, create an admin user first.
adduser deyan
usermod -aG sudo,docker deyan
mkdir -p /home/deyan/.ssh
cp /root/.ssh/authorized_keys /home/deyan/.ssh/
chown -R deyan:deyan /home/deyan/.ssh
sed -i 's/^#*PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart sshd
# Test as `ssh deyan@<box>` BEFORE closing the root session.
```

Skippable for a temporary demo.

---

## What to do if something breaks

| Symptom                                  | Likely cause / fix                                                       |
|------------------------------------------|--------------------------------------------------------------------------|
| `docker compose pull` 401-unauthorized   | ghcr.io image is private; `docker login ghcr.io` on the box.            |
| `docker compose up` exits 1, Anubis logs `ED25519_PRIVATE_KEY_HEX missing` | `.env` not being read; ensure you're in `/opt/ar5iv-editor/deploy` when running compose. |
| Editor loads but preview never updates   | Open browser devtools → Network → look for `/convert` WS upgrade. If 502, Caddy isn't forwarding `Upgrade: websocket` (it should by default; check Caddyfile). |
| Caddy fails first cert issuance          | DNS hasn't propagated yet, or rate-limited from too many restart cycles. `journalctl -u caddy -f` for details; add `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` to the Caddyfile while iterating. |
| CPU sanity-check median > 150 ms         | Slow silicon in your region. Destroy + redeploy elsewhere.              |
| Out of memory on first conversion        | Tmpfs `size=512m` plus engine peak hits 2 GB ceiling. Either resize to HF 4 GB or shrink the tmpfs to 256 MB. |

---

## Post-deploy quick tweaks

If the demo will be public-public (Hacker News risk):

```sh
# In deploy/.env on the box:
echo "AR5IV_EDITOR_QUOTA_PER_IP=2" >> .env
echo "AR5IV_EDITOR_SESSION_IDLE_SECS=180" >> .env
docker compose up -d
```

Or enable Vultr DDoS Protection (+$10/mo) at the dashboard — adds
a transparent layer-3/4 scrubber upstream.

---

When you're at Step 2 (SSH'd in), let me know and I'll watch for
issues live as you go through the rest.
