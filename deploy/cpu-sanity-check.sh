#!/usr/bin/env bash
# CPU quality sanity-check for the demo box.
#
# Runs three real warm conversions through the latexml-oxide engine
# inside the deployed container and prints per-stage timings. Bails
# if warm conversions consistently land above 150 ms — a sign of a
# slow-silicon region, contended noisy-neighbour vCPU, or a
# misconfigured CPU governor.
#
# Usage on the deploy box (after `docker compose up -d`):
#
#     ./deploy/cpu-sanity-check.sh
#
# Or on your laptop pointed at the public URL:
#
#     URL=https://demo.example.org ./deploy/cpu-sanity-check.sh

set -euo pipefail

URL="${URL:-http://127.0.0.1:8080}"
SLOW_MS=150
MIN_RUNS=5

# Mint a user + session; PUT a small fragment; convert it 5 times.
HEADERS_USER="X-Ar5iv-User: $(curl -fsS -X POST "$URL/api/user" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["user_id"])')"

SID=$(curl -fsS -X POST "$URL/api/session" \
    -H "$HEADERS_USER" \
    -H 'content-type: application/json' \
    -d '{"slot":"blank"}' \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

# Replace main.tex with a small TeX fragment.
curl -fsS -X PUT "$URL/api/session/$SID/files/main.tex" \
    -H "$HEADERS_USER" \
    --data-binary $'Hello: \\(x^2 + y^2 = z^2\\). \\[\\int_0^1 x\\,dx\\]' \
    >/dev/null

# Use a tiny Python WS driver since `wscat` isn't always installed.
# We send one warmup convert (cold; ignore) plus N timed runs.
python3 - <<PY
import asyncio, json, statistics, sys, time
import urllib.request, urllib.parse
try:
    import websockets
except ImportError:
    sys.exit("error: pip install --user websockets, or run inside a venv")

async def go():
    qs = urllib.parse.urlencode({
        "session_id": "$SID",
        "user_id": "${HEADERS_USER#X-Ar5iv-User: }",
    })
    url = "ws$([[ "$URL" == https://* ]] && echo s)://${URL#http*://}/convert?" + qs
    times = []
    async with websockets.connect(url) as ws:
        # Warm-up.
        await ws.send(json.dumps({
            "id": 0, "active_file": "main.tex", "version": 1,
            "preamble": None, "profile": "fragment", "format": "html5",
            "preload": [
                "LaTeX.pool", "article.cls", "amsmath.sty", "amsthm.sty",
                "amstext.sty", "amssymb.sty", "eucal.sty",
                "[dvipsnames]xcolor.sty", "url.sty", "hyperref.sty",
                "[ids,mathlexemes]latexml.sty",
            ],
        }))
        await ws.recv()
        for i in range(1, $MIN_RUNS + 1):
            t0 = time.perf_counter()
            await ws.send(json.dumps({
                "id": i, "active_file": "main.tex", "version": 1,
                "preamble": None, "profile": "fragment", "format": "html5",
                "preload": [
                    "LaTeX.pool", "article.cls", "amsmath.sty", "amsthm.sty",
                    "amstext.sty", "amssymb.sty", "eucal.sty",
                    "[dvipsnames]xcolor.sty", "url.sty", "hyperref.sty",
                    "[ids,mathlexemes]latexml.sty",
                ],
            }))
            resp = json.loads(await ws.recv())
            dt = (time.perf_counter() - t0) * 1000
            t = resp.get("timings", {}) or {}
            print(f"  run {i:>2}: total={dt:5.1f} ms  "
                  f"convert={t.get('convert_ms', '?')} ms  "
                  f"post={t.get('post_ms', '?')} ms  "
                  f"status='{resp.get('status', '?')}'")
            times.append(dt)
    median = statistics.median(times)
    p95 = sorted(times)[int(0.95 * len(times))]
    print()
    print(f"median={median:5.1f} ms  p95={p95:5.1f} ms  (warm conversions only)")
    if median > $SLOW_MS:
        print(f"WARN: median > $SLOW_MS ms — slow silicon or contention.", file=sys.stderr)
        sys.exit(2)

asyncio.run(go())
PY
