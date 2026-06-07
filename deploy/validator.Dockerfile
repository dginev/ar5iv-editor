# vnu (Nu validator) web service — companion container for ar5iv-editor.
#
# The jar is built on the host by deploy/build-and-push.sh (pure Java,
# platform-independent — same rationale as the frontend bundle and the
# schema docs) from the `validator` submodule, and staged into the build
# context at vnu/vnu.jar. This image is just a JRE wrapping it.
#
# `nu.validator.servlet.Main` is the embedded-Jetty service that powers
# validator.w3.org/nu: the form UI on GET /, the REST API on POST /
# (?out=json|gnu|xml…). ar5iv-editor proxies to it via /api/validate
# (schema defaulting, body caps, and the Anubis bypass live there) —
# this container is never published directly.
#
# Robustness model (see docker-compose.yml for the memory caps):
#  * -XX:+ExitOnOutOfMemoryError — a heap-exhausted JVM exits instead
#    of limping, so `restart: unless-stopped` heals it.
#  * -Xmx384m — well under the compose mem_limit so Metaspace/threads
#    don't trip the container ceiling during normal operation.

FROM eclipse-temurin:21-jre-jammy

# curl for the container healthcheck (the JRE base ships without it).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY vnu/vnu.jar /app/vnu.jar

EXPOSE 8888

# Jetty + schema preload take ~5-10 s; start-period covers it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s \
    CMD curl -fsS http://127.0.0.1:8888/ >/dev/null || exit 1

# max-file-size: the servlet's resource cap defaults to 2 MB —
# book-sized scholarly HTML runs well past it. 35 MB matches the
# proxy's post-decompression body cap. The heap rides along (the
# servlet buffers the whole document, UTF-16 doubled, plus the
# parse tree): 512m is the most that fits under the 640m compose
# mem_limit once metaspace/threads/Jetty native overhead is counted.
CMD ["java", "-Xmx512m", "-XX:+ExitOnOutOfMemoryError", \
     "-Dnu.validator.servlet.max-file-size=36700160", \
     "-cp", "/app/vnu.jar", "nu.validator.servlet.Main", "8888"]
