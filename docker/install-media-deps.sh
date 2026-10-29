#!/bin/bash
# Ubuntu 24.04, matching the runtime ABI. Called as root in Docker / via sudo in CI.
set -euo pipefail
. /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 || "$(uname -m)" != x86_64 ]]; then
    echo 'The production media recipe requires Ubuntu 24.04 amd64' >&2; exit 1
fi
runtime=(libx264-164 libx265-199 libvpx9 libmp3lame0 libopus0 libass9 libfontconfig1
    libfreetype6 libgnutls30t64 libsrt1.5-gnutls libva2 libva-drm2 libdrm2 libvpl2 libmfx1 libmfx-gen1.2
    libdav1d7 libxml2 libharfbuzz0b libfribidi0 libzimg2 liblzma5 libbz2-1.0 zlib1g fonts-dejavu-core)
build=(build-essential pkg-config nasm clang curl ca-certificates xz-utils
    libx264-dev libx265-dev libvpx-dev libmp3lame-dev libopus-dev libass-dev
    libfontconfig1-dev libfreetype6-dev libgnutls28-dev libsrt-gnutls-dev
    libva-dev libdrm-dev libvpl-dev libdav1d-dev libxml2-dev libharfbuzz-dev libfribidi-dev libzimg-dev liblzma-dev libbz2-dev zlib1g-dev)
case "${1:-}" in
    build) packages=("${runtime[@]}" "${build[@]}");;
    runtime) packages=("${runtime[@]}");;
    *) echo 'Usage: install-media-deps.sh build|runtime' >&2; exit 1;;
esac
apt-get update
apt-get install -y --no-install-recommends "${packages[@]}"
