# Local rehearsal — run the deploy stack on your laptop

Same image, same compose, same Anubis policy as the cloud deploy —
just on localhost without TLS. Catches misconfigurations in the
deploy/ artefacts before they bite on a remote box.

Wall time: ~5 minutes (assuming the image is already built).

## 1. Build the image (skip if already done)

```sh
cd ~/git/ar5iv-editor
deploy/build-and-push.sh   # builds locally, doesn't push
```

Verify with:

```sh
docker images ar5iv-editor
# Look for a row tagged whatever IMAGE you used (default
# ghcr.io/<user>/ar5iv-editor:latest).
```

## 2. Set up an isolated test directory

Don't pollute `/opt/ar5iv-editor` on your laptop; use a tmpdir that
mirrors the layout the Vultr box will see.

```sh
mkdir -p /tmp/ar5iv-local-test && cd /tmp/ar5iv-local-test

# Copy just the deploy artefacts.
cp -r ~/git/ar5iv-editor/deploy .

# Mint a key + point at the locally-built image.
cat > deploy/.env <<EOF
ANUBIS_KEY=$(openssl rand -hex 32)
COOKIE_DOMAIN=
AR5IV_IMAGE=ar5iv-editor:test-build
EOF
```

(`AR5IV_IMAGE` overrides the default `ghcr.io/...` and points at
the locally-built `ar5iv-editor:test-build` tag.)

## 3. Bring it up

```sh
cd deploy
# Layer the local override on top of the production compose. The
# override flips Anubis to USE_REMOTE_ADDRESS=true so it doesn't
# 500 without an X-Real-Ip header from a non-existent Caddy.
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
docker compose ps     # both services should be 'running'
```

Anubis listens on `127.0.0.1:8080` (the compose binds to localhost
explicitly so it doesn't conflict with anything else on your LAN).

## 4. Smoke test — bypass Anubis first

The marketing pages are allowlisted, so this should work without
JS challenge:

```sh
curl -fsS http://127.0.0.1:8080/about | head -3
```

Expect HTML.

## 5. Smoke test — through Anubis with a real browser

Open <http://127.0.0.1:8080/editor> in a browser. You'll see
Anubis's "checking your browser" challenge for 1-3 seconds, then
the editor loads.

What to verify:

- ✅ Three-pane shell renders (files / source / preview).
- ✅ File tree shows `main.tex` highlighted as active.
- ✅ Welcome content (`\documentclass{article} \begin{document}
  Hello, world!...`) is in the source pane.
- ✅ Preview pane converts within ~1 s and shows the rendered
  hello-world with MathML.
- ✅ Pick "Equations" from the dropdown — preview repaints with
  the new doc.
- ✅ Pick "arXiv: 1709.07020" — file tree shows 3 unpacked files.
- ✅ Click on `preprint_inset.pdf` — source pane shows the
  binary-stub metadata, not garbled bytes.
- ✅ Click "Download project as ZIP" (⬇ icon in file panel header)
  — your browser downloads `ar5iv-session-XXXXXXXX.zip`.

## 6. The auto-convert promise

This one is the headline UX feature; verify it works through the
Anubis-fronted stack:

1. Pick the "Calculus" example.
2. Watch the preview render the integral.
3. Type a single keystroke in the editor.
4. The preview should update within ~1 second.
5. Save a small test fixture file (e.g. drag-and-drop a `.png`
   from your desktop onto the file panel) — preview re-converts
   without any further action.

If any of those break, the issue is between Anubis and the WS
upgrade or in our `requestPreview` chain. Use:

```sh
docker compose logs -f --tail=100 ar5iv-editor anubis
```

to watch in real time.

## 7. Tear down

```sh
docker compose down -v
# `-v` also drops the named volume (the tmpfs sessions). Without
# `-v` your test sessions persist across runs.
rm -rf /tmp/ar5iv-local-test
```

Done. Now you know the deploy/ artefacts are sound, and the
Vultr-side work is just "do the same thing on a remote box, plus
DNS + TLS".

## What this rehearsal catches

| Failure                                       | Caught locally? |
|-----------------------------------------------|-----------------|
| Anubis policy YAML syntax error               | ✅              |
| docker-compose env-var typos                  | ✅              |
| Image too tightly bound to host CPU features  | ✅ (different host CPU) |
| Tmpfs sizing too small for typical workload   | ✅              |
| Anubis breaking the WS upgrade                | ✅              |
| Anubis breaking streaming multipart uploads   | ✅              |
| Frontend bundle missing static assets         | ✅              |
| HEALTHCHECK timing out under load             | ✅              |
| TLS / Let's Encrypt issues                    | ❌ (DNS-bound)  |
| Region-specific slow CPU                      | ❌              |
| Vultr firewall surprises                      | ❌              |

The bottom three are the only things that have to wait for the real
box. Everything else can — and should — die in the local rehearsal.
