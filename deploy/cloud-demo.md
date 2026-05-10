# Cloud demo deploy — Vultr High-Frequency

Step-by-step recipe for putting a public-facing demo on a
Vultr High-Frequency 2 GB instance ($12/mo). Total time: ~15 minutes.
Total cost: $12/mo + a domain.

The plan: provision the box, build the image locally, push to ghcr.io,
pull on the box, run docker-compose with Anubis in front, terminate
TLS with Caddy on the host.

## What ships, what doesn't

The Dockerfile is multi-stage. The published image (~484 MB)
contains **only the compiled binary + frontend bundle**. The
intermediate stages — which carried the latexml-oxide source, the
Rust build cache, and the npm tree — are discarded after each
stage; nothing from them ends up in the layers that get pushed.

| Stage         | What it does                            | In the pushed image? |
|---------------|-----------------------------------------|----------------------|
| `builder`     | Rust release build of ar5iv-editor      | No — discarded       |
| `frontend`    | Vite production bundle                  | No — discarded       |
| `runtime`     | Debian slim + texlive + ImageMagick + Ghostscript + the binary + the frontend bundle | **Yes** — this is what `docker push` sends |

The `examples/` tree (including the arXiv tarball) IS embedded in
the binary at compile time via `include_dir!`, so demo content is
extractable from the image. That's intentional — the demo content
isn't sensitive.

**The latexml-oxide source is not in the image.** The image is a
binary derivative of that source, however, so we keep the
published ghcr.io package **private** (only the deploy box pulls
via `docker login`). Do not flip it to public without revisiting
that decision against the latexml-oxide repo's license.

If conversions feel under load, dashboard → Resize → HF 4 GB. Same IP,
same data, ~5 min downtime. See the "Upgrade path" section.

## 0. Pre-reqs (your laptop)

- A GitHub account (free `ghcr.io` registry for public images, or
  swap to Docker Hub if you prefer).
- A domain name with DNS you can edit.
- `docker` running locally.
- All four source repos checked out as siblings &mdash; e.g.
  `~/git/ar5iv-editor/`, `~/git/latexml-oxide/`, `~/git/validator/`
  (on the `latexml-html5` branch), and `~/git/mathml-schema/`. The
  last two carry the schema sources for the `/schemas` doc subtrees.

## 1. Provision the Vultr box

Vultr dashboard → **Deploy New Server** → **Optimized Cloud Compute** →
**High Frequency**.

| Field            | Pick                                                    |
|------------------|---------------------------------------------------------|
| Region           | NYC, Atlanta, Frankfurt, Tokyo, or Sydney (full HF lineup; future upgrades aren't blocked) |
| Plan             | High Frequency 2 GB ($12/mo, 1 vCPU, 64 GB NVMe)        |
| Image            | **Ubuntu 24.04 LTS** (Vultr defaults to an EOL image — change it) |
| SSH keys         | Add yours via Account → SSH Keys *before* provisioning  |
| Auto-backups     | **Off** (sessions are tmpfs; nothing to back up)        |
| IPv6             | **On** (free; some edges are faster on v6)              |
| DDoS protection  | Optional ($10/mo); skip for a private demo              |

Wait ~60 seconds for the instance to come up. Note the IPv4 address.

Point your domain's A record (and AAAA if IPv6 is on) at the box.
DNS propagation usually takes 1-5 minutes.

## 2. Bootstrap the box

```sh
ssh root@<vultr-ip>

# Install docker.
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Caddy for TLS termination. The official apt repo gets you
# automatic Let's Encrypt cert issuance + renewal.
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# Make a working directory for the deploy.
mkdir -p /opt/ar5iv-editor && cd /opt/ar5iv-editor
```

## 3. Build the image (laptop)

Back on your laptop:

```sh
cd ~/git/ar5iv-editor
# First-time login to ghcr.io — needs a personal-access token
# with write:packages scope.
echo $GITHUB_TOKEN | docker login ghcr.io -u <your-github-user> --password-stdin

IMAGE=ghcr.io/<your-github-user>/ar5iv-editor:latest \
    deploy/build-and-push.sh --push
```

The script symlinks `latexml-oxide` next to the repo, runs the
multi-stage Dockerfile, and pushes the resulting image. First build
takes ~10 minutes (the latexml-oxide tree is large); subsequent
incremental builds are fast.

The image is ~700-800 MB compressed (TeX Live dominates).

## 4. Wire it together on the box

On the Vultr box, in `/opt/ar5iv-editor`:

```sh
# Pull just the deploy/ folder from your fork — sparse-checkout
# avoids the 100-MB git clone for what's really 4 small files.
git clone --filter=blob:none --no-checkout \
    https://github.com/<your-github-user>/ar5iv-editor .
git sparse-checkout set deploy
git checkout

# Mint a long-lived ed25519 private key for Anubis cookie signing
# (32 bytes hex). This stays on the server — don't commit it.
cat > deploy/.env <<EOF
ANUBIS_KEY=$(openssl rand -hex 32)
COOKIE_DOMAIN=<your-domain>
AR5IV_IMAGE=ghcr.io/<your-github-user>/ar5iv-editor:latest
EOF

# The image is private (the latexml-oxide source we built it from
# is treated as private; the binary stays in step). Log in with a
# read-scoped PAT.
echo $GITHUB_TOKEN | docker login ghcr.io -u <user> --password-stdin

cd deploy
docker compose pull
docker compose up -d
```

`docker compose ps` should show both `anubis` and `ar5iv-editor`
healthy. Test internally:

```sh
curl -fsS http://127.0.0.1:8080/about | head -5
```

That should return the marketing page (Anubis allowlists `/about`
for search engines, so no challenge for `curl`).

## 5. Add TLS via Caddy

```sh
cat > /etc/caddy/Caddyfile <<EOF
<your-domain> {
    reverse_proxy localhost:8080 {
        # Anubis insists on X-Real-Ip being set by the upstream
        # proxy and 500s without it. Caddy's `reverse_proxy` only
        # sets X-Forwarded-For by default — we have to add X-Real-Ip
        # explicitly. Without this every request through Caddy
        # turns into a 500 from Anubis.
        header_up X-Real-Ip {remote_host}
    }
}
EOF
systemctl restart caddy
```

Caddy auto-issues a Let's Encrypt cert on first request. Hit
`https://<your-domain>/editor` in a browser — you should see Anubis's
JS challenge, clear it, then land on the editor.

## 6. Sanity-check the CPU

This is the demo-quality check. SSH in and time a real warm
conversion:

```sh
docker compose exec ar5iv-editor /app/ar5iv-editor &
# Wait ~2 seconds for the worker thread to spin up the engine.
# Then in another shell on the host:
time curl -fsS \
    -X POST http://127.0.0.1:8080/api/user \
    -H 'content-type: application/json'
```

Or run the bundled benchmark from the `target/release/` build (only
works if you cargo-built on the box, which we don't normally do).
The simpler check: open the editor in a browser, watch the
"timings" strip in the preview pane after typing a single keystroke
into the example slot.

You want the **`total`** field to land in the **40-90 ms** range for
warm conversions on the calculus or pythagoras examples. If you see
`total > 150 ms` consistently, something is throttling — Vultr
sometimes ships HF instances on older Skylake hardware in less-popular
regions. If that happens, destroy the instance and redeploy in a
different region.

## 7. (Optional) Resize when you outgrow it

When demo load starts costing you:

```
Vultr dashboard → server → Settings → Change Plan →
    pick High Frequency 4 GB ($24/mo) →
    confirm reboot
```

Same IP, same `/opt/ar5iv-editor`, same data, ~5 min downtime.

If you do resize:

1. The compose file's `cpuset: "0"` becomes meaningful (you now have
   2 cores). The convert worker pins to core 0; Anubis + Caddy +
   kernel use core 1.
2. Bump the tmpfs from 512 MB → 1 GB:
   ```yaml
   o: "size=1024m"
   ```
3. Loosen the demo quotas back toward the library defaults if
   you're letting more users on:
   ```yaml
   AR5IV_EDITOR_QUOTA_PER_IP: "16"
   AR5IV_EDITOR_SESSION_IDLE_SECS: "600"
   AR5IV_EDITOR_QUOTA_ROOT_BYTES: "2147483648"
   ```
4. `docker compose up -d` to apply.

## Snapshots

Take a Vultr snapshot ($1/mo) immediately after the first
successful end-to-end demo. Single-click rollback if you misconfigure
something while iterating on Anubis or Caddy.

## Logging

`docker compose logs -f --tail=200 ar5iv-editor` is your friend.
Anubis is quieter (~one line per request when challenged); the
Axum binary logs every conversion with stage timings.

## Common gotchas

- **Anubis challenge fails on Safari < 16.4.** Modern Safari is fine.
  Old iPads will see a 403; check Anubis logs.
- **Cert issuance fails** with rate-limit errors if you blow up
  Caddy's `/etc/caddy/Caddyfile` and restart repeatedly while
  testing — Let's Encrypt has tight per-domain rate limits.
  Use `--issuer staging` in the Caddyfile while iterating.
- **The image is large (~800 MB)** because of TeX Live. First pull
  takes 30-60 seconds on a fresh box. Subsequent updates are
  layer-deltas and pull in seconds.
- **Vultr HF 2 GB has 1 vCPU.** `cpuset: "0"` works because docker
  treats the lone core as core 0. After resizing to HF 4 GB you'll
  have cores 0-1 and the pinning becomes effective.
