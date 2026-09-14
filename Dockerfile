# PigTV Docker Image
#
# Hardware acceleration:
#   - VAAPI (Intel/AMD): Mount /dev/dri and add video/render groups
#   - NVIDIA NVENC: Requires nvidia-container-toolkit on host + --gpus flag
#   - Intel QSV: Mount /dev/dri
#
# Build: docker compose build
# Run with VAAPI: docker run --device /dev/dri:/dev/dri --group-add video ...

FROM ubuntu:24.04

# Install Node.js, FFmpeg, and hardware acceleration drivers
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && if [ "$TARGETARCH" = "amd64" ]; then \
        DRIVERS="mesa-va-drivers intel-media-va-driver vainfo"; \
    else \
        DRIVERS=""; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    ffmpeg \
    python3 \
    make \
    g++ \
    $DRIVERS \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installed
RUN ffmpeg -version && ffmpeg -encoders 2>/dev/null | grep -E "vaapi|nvenc|qsv|libx264" | head -10

# Comskip, for detecting commercial breaks in recordings.
#
# Not packaged for Ubuntu, so it is built here. Built in a throwaway layer and
# the build tools removed afterwards, since only the binary and the shared
# libraries FFmpeg already needs are wanted at runtime.
#
# The build is allowed to fail: ad detection is optional, and a transient
# problem fetching or compiling it should not stop PigTV being built. The
# server checks for the binary at startup and reports the feature as
# unavailable when it is missing.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential autoconf automake libtool pkg-config git \
        libargtable2-dev libavformat-dev libavcodec-dev libavutil-dev \
        libswscale-dev libsdl2-dev; \
    ( \
        git clone --depth 1 https://github.com/erikkaashoek/Comskip /tmp/comskip \
        && cd /tmp/comskip \
        && ./autogen.sh \
        && ./configure --bindir=/usr/local/bin \
        && make -j"$(nproc)" \
        && make install \
    ) || echo "WARNING: Comskip build failed; ad detection will be unavailable"; \
    rm -rf /tmp/comskip; \
    apt-get purge -y --auto-remove \
        build-essential autoconf automake libtool pkg-config git \
        libargtable2-dev libavformat-dev libavcodec-dev libavutil-dev \
        libswscale-dev libsdl2-dev; \
    apt-get install -y --no-install-recommends libargtable2-0; \
    rm -rf /var/lib/apt/lists/*; \
    command -v comskip && comskip --help 2>&1 | head -3 || echo "Comskip not available"

# Default Comskip tuning. Deliberately conservative: over-detection removes
# programme content, which is worse than leaving an advert in. Override by
# mounting your own file at this path once you know how your channels behave.
COPY docker/comskip.ini /app/config/comskip.ini

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (better-sqlite3 will build from source using g++ installed above)
RUN npm ci --only=production

# Copy application files
COPY . .

# Create data, cache, and DVR recordings directories
RUN mkdir -p /app/data /app/transcode-cache /app/recordings /app/config && chmod 777 /app/transcode-cache /app/recordings

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server/index.js"]
