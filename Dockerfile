# PigTV Docker Image
#
# Two stages: a builder that holds the compilers (native modules, Comskip) and
# a runtime image that holds none of them. The runtime keeps only ffmpeg, the
# VAAPI drivers, Node and what Comskip links against.
#
# Runs as PUID:PGID (default 99:100, Unraid's nobody:users) - see
# docker/entrypoint.sh and docs/OPERATIONS.md.
#
# Hardware acceleration:
#   - VAAPI (Intel/AMD): Mount /dev/dri; the entrypoint joins the device's group
#   - NVIDIA NVENC: Requires nvidia-container-toolkit on host + --gpus flag
#   - Intel QSV: Mount /dev/dri
#
# Build: docker compose build
# Run with VAAPI: docker run --device /dev/dri:/dev/dri ...

# ---------------------------------------------------------------- builder ---
FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends \
    nodejs python3 make g++ \
    build-essential autoconf automake libtool pkg-config git \
    libargtable2-dev libavformat-dev libavcodec-dev libavutil-dev \
    libswscale-dev libsdl2-dev \
    && rm -rf /var/lib/apt/lists/*

# Comskip, for detecting commercial breaks in recordings. Not packaged for
# Ubuntu, so it is built here and only the binary is carried across.
#
# The build is allowed to fail: ad detection is optional, and a transient
# problem fetching or compiling it should not stop PigTV being built. The
# server checks for the binary at startup and reports the feature as
# unavailable when it is missing. (The COPY below takes a directory so it
# works whether or not a binary exists.)
RUN mkdir -p /out/bin; \
    ( \
        # Pinned to a specific commit (checked with `git ls-remote` on 23 Sept
        # 2026) rather than cloning master, so the image is reproducible: an
        # upstream force-push or a broken commit on master should never change
        # what a rebuild produces.
        set -e; \
        mkdir -p /tmp/comskip && cd /tmp/comskip \
        && git init -q \
        && git fetch --depth 1 https://github.com/erikkaashoek/Comskip a140b6ac8bc8f596729e9052819affc779c3b377 \
        && git checkout -q FETCH_HEAD \
        && ./autogen.sh \
        && ./configure --bindir=/usr/local/bin \
        && make -j"$(nproc)" \
        && make install \
        && cp /usr/local/bin/comskip /out/bin/ \
    ) || echo "WARNING: Comskip build failed; ad detection will be unavailable"; \
    rm -rf /tmp/comskip; \
    ls /out/bin

WORKDIR /app
COPY package*.json ./
# better-sqlite3 compiles here, against the same Node the runtime stage has.
RUN npm ci --omit=dev

# ---------------------------------------------------------------- runtime ---
FROM ubuntu:24.04

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && if [ "$TARGETARCH" = "amd64" ]; then \
        DRIVERS="mesa-va-drivers intel-media-va-driver vainfo"; \
    else \
        DRIVERS=""; \
    fi \
    && apt-get install -y --no-install-recommends \
    nodejs \
    ffmpeg \
    libargtable2-0 \
    util-linux \
    $DRIVERS \
    && apt-get purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installed
RUN ffmpeg -version && ffmpeg -encoders 2>/dev/null | grep -E "vaapi|nvenc|qsv|libx264" | head -10

COPY --from=builder /out/bin/ /usr/local/bin/
# Comskip is optional, but if it is here it must be able to start: say so at
# build time if a shared library it needs is missing.
RUN if command -v comskip >/dev/null; then \
        if ldd /usr/local/bin/comskip | grep -q "not found"; then \
            echo "WARNING: comskip is missing a shared library:"; ldd /usr/local/bin/comskip | grep "not found"; \
        else echo "Comskip OK"; fi; \
    else echo "Comskip not available"; fi

# Default Comskip tuning. Deliberately conservative: over-detection removes
# programme content, which is worse than leaving an advert in. Override by
# mounting your own file at this path once you know how your channels behave.
COPY docker/comskip.ini /app/config/comskip.ini

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# The container's own writable folders. Ownership is settled by the entrypoint
# at start (the mounts only exist then), so nothing here is world-writable.
RUN mkdir -p /app/data /app/transcode-cache /app/recordings /app/config \
    && chmod +x /app/docker/entrypoint.sh

# Build identity (optional). A CI or manual build can stamp the image with its
# git SHA and build time, which version.js then reports via /api/version:
#   docker build --build-arg PIGTV_COMMIT=$(git rev-parse --short HEAD) \
#                --build-arg PIGTV_BUILT_AT=$(date -u +%FT%TZ) ...
# Left unset, version.js reports commit 'dev' / builtAt null and a plain build
# still works - the committed `build` number in version.js is the primary
# identifier either way.
ARG PIGTV_COMMIT=dev
ARG PIGTV_BUILT_AT=
ENV PIGTV_COMMIT=${PIGTV_COMMIT} \
    PIGTV_BUILT_AT=${PIGTV_BUILT_AT}

EXPOSE 3000

# Readiness: /api/health answers 503 only when the database is unusable. Node
# does the request, so no curl is needed in the image. start-period covers the
# first-run migrations.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Starts as root only to prepare folders and drop to PUID:PGID, then execs node.
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "server/index.js"]
