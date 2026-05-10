# Deploying ar5iv-editor

Production deployment puts [Anubis](https://github.com/TecharoHQ/anubis)
in front of the Axum binary so anonymous file uploads + LaTeX compute
aren't free for crawlers and abusive scripts. See `docs/FileUI.md`
"Abuse defence" for the rationale.

## Layout

```
ar5iv-editor/deploy/
├── Dockerfile          multi-stage build for the binary + frontend
├── docker-compose.yml  Anubis (:8080) → ar5iv-editor (:3000)
└── anubis.yaml         deny-by-default policy
```

The build COPYs `latexml-oxide`, `validator`, and `mathml-schema`
from the parent directory, so the docker build context needs to be
the directory that holds **all four** checkouts:

```
~/git/
├── ar5iv-editor/      # this repo
├── latexml-oxide/     # https://github.com/dginev/latexml-oxide  (private)
├── validator/         # https://github.com/dginev/validator      (latexml-html5 branch)
└── mathml-schema/     # https://github.com/w3c/mathml-schema
```

The last two carry the source `.rnc` files for the
`/schemas/<slug>/` documentation subtrees. `build-and-push.sh`
runs `latexml-oxide --schemadocs` against each on the host
*before* the docker build kicks off, so trang / Java / Node never
need to touch the build pipeline. The frontend bundle (`vite`
output) is generated locally for the same reason. Both land in
the staged build context and are copied verbatim into the runtime
stage. Override paths with `VALIDATOR_PATH` / `MATHML_SCHEMA_PATH`
env vars if your checkouts live elsewhere.

Local pre-build prerequisites:

- `npm` (Node.js 20+)
- `trang` (RNC → RNG converter; `apt install trang`)
- `cargo` — only needed if `latexml_oxide` / `genschema_oxide`
  haven't been built before; the script falls back to a release
  build under `~/git/latexml-oxide/target/release/`.

The latexml-oxide source is treated as **private**. The Dockerfile
is multi-stage so the published image contains only the compiled
binary and the frontend bundle — the latexml-oxide source is in
the throwaway `builder` stage and never ends up in the runtime
layers that `docker push` sends. To preserve that posture, also
keep the **ghcr.io package private** (the default for first-push
on ghcr.io); the deploy box authenticates with a read-scoped PAT.
See `cloud-demo.md` § "What ships, what doesn't" for the layer
breakdown.

## Quick start

```sh
cd ~/git/ar5iv-editor/deploy
# Mint a long-lived ed25519 private key for Anubis cookie signing.
echo "ANUBIS_KEY=$(openssl rand -hex 32)" > .env
# Optional: set the cookie domain so the same browser session works
# across subdomains.
echo "COOKIE_DOMAIN=editor.example.org" >> .env

docker compose build
docker compose up -d
```

Anubis listens on `:8080`. Front it with your TLS terminator (Caddy,
nginx, Cloudflare). The Axum binary listens internally on `:3000`
and is **not** exposed to the host.

## Smoke-test the WebSocket and upload paths

The two paths most likely to break under a reverse proxy are:

1. **WebSocket upgrade for `/convert`.** Anubis forwards
   `Upgrade: websocket` cleanly out of the box; verify by opening the
   editor in a browser and watching `<status>` reach "ok" on the
   first conversion.
2. **Streaming multipart bodies for archive imports.** ZIP / tar.gz
   uploads pass through as a stream; Anubis must not buffer the whole
   body. Verify by uploading the bundled
   `examples/arxiv/1709.07020v1.tar.gz` via the file panel's "Import
   archive" button and watching the file tree populate with three
   entries (`full_article.tex`, `full_article.bbl`,
   `preprint_inset.pdf`).

If either step fails, the symptom is immediate (no preview / no file
list); compare against direct-to-:3000 traffic to isolate Anubis vs.
the editor.

## Tunables

The Axum binary reads its configuration from environment variables
(see `crates/ar5iv-editor-server/src/config.rs`). The compose file
sets the deployment-relevant ones; everything else falls back to the
defaults documented in `README.md` § Configuration.

| Variable                          | Default                           |
|-----------------------------------|-----------------------------------|
| `AR5IV_EDITOR_BIND`               | `0.0.0.0:3000`                    |
| `AR5IV_EDITOR_STATIC_DIR`         | `/app/frontend/dist`              |
| `AR5IV_EDITOR_SESSIONS_DIR`       | `/var/ar5iv-sessions` (tmpfs)     |
| `AR5IV_EDITOR_SESSION_IDLE_SECS`  | `600` (10 minutes)                |
| `AR5IV_EDITOR_QUOTA_SESSION_BYTES`| `52428800` (50 MB)                |
| `AR5IV_EDITOR_QUOTA_PER_USER`     | `8`                               |
| `AR5IV_EDITOR_QUOTA_PER_IP`       | `16`                              |
| `AR5IV_EDITOR_QUOTA_ROOT_BYTES`   | `2147483648` (2 GB)               |

The full list lives in `config.rs::SessionConfig`.

## Operating notes

- **Disk hygiene.** The session registry sweeps orphan tmpdirs at
  startup, on every fresh session create, and every ~2 minutes
  thereafter. A server restart leaves nothing behind.
- **Privacy.** The 256-bit user_id and session_id tokens are pure
  capabilities; the server logs request-ids, not tokens, and the
  on-disk dir name is a separately-minted token unrelated to the
  URL-visible session id (see `docs/FileUI.md` "Session model"). A
  leaked URL or access-log line cannot be turned into a filesystem
  path.
- **Cookies.** Anubis uses a single signed cookie; the editor does
  not. State-changing requests are authorised by the
  `X-Ar5iv-User` custom header, so cross-origin requests cannot
  forge calls without explicit JS access.
