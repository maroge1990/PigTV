#!/bin/bash
# Build the same pinned ffmpeg/ffprobe for Docker and CI; never install a moving PPA/binary.
set -euo pipefail
media_dir=$(cd -- "$(dirname -- "$0")" && pwd)
. "$media_dir/media-toolchain.conf"
media_work=$(mktemp -d)
trap 'rm -rf "$media_work"' EXIT
media_downloads=${MEDIA_DOWNLOAD_DIR:-$media_work/downloads}
mkdir -p "$media_downloads"
verify() {
    local url=$1 file=$2 expected=$3 actual
    if [[ ! -f "$file" ]]; then curl --fail --location --retry 3 "$url" -o "$file"; fi
    if command -v sha256sum >/dev/null; then actual=$(sha256sum "$file"); else actual=$(shasum -a 256 "$file"); fi
    if [[ "${actual%% *}" != "$expected" ]]; then echo "Checksum mismatch: $(basename "$file")" >&2; exit 1; fi
}
ff_archive="$media_downloads/ffmpeg-$FFMPEG_RELEASE.tar.xz"
nv_archive="$media_downloads/nv-codec-headers-$NV_CODEC_RELEASE.tar.gz"
verify "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_RELEASE.tar.xz" "$ff_archive" "$FFMPEG_SHA256"
verify "https://github.com/FFmpeg/nv-codec-headers/archive/refs/tags/n$NV_CODEC_RELEASE.tar.gz" "$nv_archive" "$NV_CODEC_SHA256"
if [[ "${1:-}" == --verify-only ]]; then echo "Verified FFmpeg $FFMPEG_RELEASE and codec headers $NV_CODEC_RELEASE"; exit 0; fi
media_prefix=${1:-/opt/pigtv-ffmpeg}
# Installation cleanup below must only touch a dedicated tool directory.
if [[ "$media_prefix" != /* || "$media_prefix" == / || ( -e "$media_prefix" && ! -d "$media_prefix" ) ]] ||
    [[ -d "$media_prefix" && -n "$(ls -A "$media_prefix")" ]]; then
    echo 'Install prefix must be a new or empty absolute directory' >&2; exit 1
fi
if [[ "$(uname -s)" != Linux ]]; then echo 'Build the Linux production recipe on Ubuntu 24.04; see docs/MEDIA-TOOLCHAIN.md' >&2; exit 1; fi
tar -xJf "$ff_archive" -C "$media_work"
tar -xzf "$nv_archive" -C "$media_work"
make -C "$media_work/nv-codec-headers-n$NV_CODEC_RELEASE" PREFIX="$media_work/headers" install
cd "$media_work/ffmpeg-$FFMPEG_RELEASE"
# Static FFmpeg libraries avoid colliding with Comskip's Ubuntu libav* ABI. External
# codec/driver libraries stay Ubuntu 24.04's; no session/output flags are changed.
PKG_CONFIG_PATH="$media_work/headers/lib/pkgconfig:${PKG_CONFIG_PATH:-}" ./configure \
    --prefix="$media_prefix" --disable-shared --enable-static --disable-debug --disable-doc \
    --disable-ffplay --disable-autodetect --enable-pthreads --enable-gpl \
    --enable-zlib --enable-bzlib --enable-lzma --enable-gnutls --enable-libsrt \
    --enable-libx264 --enable-libx265 --enable-libvpx --enable-libmp3lame --enable-libopus \
    --enable-libass --enable-libfontconfig --enable-libfreetype --enable-libzimg \
    --enable-libdrm --enable-vaapi --enable-libvpl \
    --enable-libdav1d --enable-libxml2 --enable-iconv --enable-libharfbuzz --enable-libfribidi \
    --enable-ffnvcodec --enable-nvenc --enable-nvdec --enable-cuvid --enable-cuda-llvm
make -j"${MEDIA_BUILD_JOBS:-$(nproc)}"
make install
# Headers/static libraries are build products, unnecessary in the runtime image/cache.
rm -rf "$media_prefix/include" "$media_prefix/lib" "$media_prefix/share"
