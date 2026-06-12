#!/usr/bin/env bash
# Build a minimal, decoder-only, LGPL FFmpeg for Linux from source, and install
# it as shared libraries (.so) + pkg-config manifests the engine can link
# against. The Linux counterpart of scripts/build-ffmpeg-universal.sh (macOS).
#
# Why from source instead of the distro's libav*-dev:
#   - SELF-CONTAINED: the engine links our build and scripts/linux-bundle-ffmpeg.sh
#     vendors the .so next to it with an $ORIGIN rpath, so the .deb/.rpm/AppImage
#     run on machines that have no FFmpeg installed (and never depend on the
#     distro's libav SONAME, which differs across Ubuntu/Fedora/etc.).
#   - LICENSE: a vanilla FFmpeg WITHOUT --enable-gpl / external-encoder flags is
#     LGPL and ships no GPL code. The audio formats we need (AAC/M4A, ALAC, MP3,
#     FLAC, PCM, Vorbis, Opus, ...) all have built-in LGPL decoders.
#   - REPRODUCIBLE: the version is pinned here (same as the macOS build), not
#     whatever the runner image happens to ship.
#
# The engine only ever decodes (avformat_open_input + avcodec_find_decoder), so
# encoders/muxers/filters/devices/scaling are disabled — keeping the closure to
# the four libav* .so with no external dependencies, which
# scripts/linux-bundle-ffmpeg.sh then relocates next to the engine.
#
# Usage:
#   scripts/build-ffmpeg-linux.sh [OUT_PREFIX]
# OUT_PREFIX defaults to vendor/ffmpeg-linux (relative to repo root). Point the
# engine build at it with PKG_CONFIG_PATH="$OUT_PREFIX/lib/pkgconfig".
#
# Linux only. Requires a C compiler + make + curl/tar (build-essential).
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.1}"
FFMPEG_SHA256="${FFMPEG_SHA256:-733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1}"

if [[ "$(uname)" != "Linux" ]]; then
  echo "build-ffmpeg-linux: not Linux, nothing to do."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
OUT_PREFIX="${1:-$REPO_ROOT/vendor/ffmpeg-linux}"
WORK="$REPO_ROOT/vendor/.ffmpeg-build-linux"
SRC="$WORK/ffmpeg-$FFMPEG_VERSION"

mkdir -p "$WORK"

# ── Idempotency: skip the (slow) build if the output is already present.
#    Set FORCE=1 to rebuild from scratch. ───────────────────────────────────────
existing="$OUT_PREFIX/lib/libavformat.so"
if [[ -z "${FORCE:-}" && -e "$existing" ]]; then
  echo "build-ffmpeg-linux: $OUT_PREFIX already built. Set FORCE=1 to rebuild."
  echo "  PKG_CONFIG_PATH=$OUT_PREFIX/lib/pkgconfig"
  exit 0
fi

# ── Fetch + verify source (pinned) ──────────────────────────────────────────
TARBALL="$WORK/ffmpeg-$FFMPEG_VERSION.tar.xz"
if [[ ! -d "$SRC" ]]; then
  if [[ ! -f "$TARBALL" ]]; then
    echo "build-ffmpeg-linux: downloading FFmpeg $FFMPEG_VERSION"
    curl -fSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$TARBALL"
  fi
  echo "$FFMPEG_SHA256  $TARBALL" | sha256sum -c -
  tar -xJf "$TARBALL" -C "$WORK"
fi

# Config mirrors the macOS build: strip everything we don't decode with, stay
# LGPL (no --enable-gpl and no external encoder libs), keep all built-in
# decoders/demuxers/parsers.
#   - The final $ORIGIN rpath that makes the libs resolve as siblings is set by
#     scripts/linux-bundle-ffmpeg.sh with patchelf at bundle time — that's the
#     copy that ships. We don't fight FFmpeg configure's $ORIGIN escaping here.
#   - --disable-lzma: liblzma is a system lib we don't want to drag into the
#     dependency closure; the audio demuxers don't need it.
#   - --disable-x86asm: no nasm/yasm build dependency; audio decode is light.
common_args=(
  --enable-shared --disable-static
  --disable-gpl --disable-nonfree
  --disable-programs --disable-doc
  --disable-encoders --disable-muxers
  --disable-avdevice --disable-avfilter --disable-swscale --disable-postproc
  --disable-network --disable-debug
  --disable-lzma
  --disable-libxcb            # XCB (x11grab screen capture). FFmpeg also probes the
  --disable-xlib              # older Xlib path separately, so disable BOTH or the
                              # libav* still gain a libX11/libxcb dependency we'd have
                              # to vendor. We decode audio only — no X11 needed.
  --disable-x86asm
  --enable-pic
)

echo "build-ffmpeg-linux: configuring (FFmpeg $FFMPEG_VERSION, decoder-only LGPL)"
BUILDDIR="$WORK/build"
rm -rf "$BUILDDIR" "$OUT_PREFIX"
mkdir -p "$BUILDDIR"
(
  cd "$BUILDDIR"
  "$SRC/configure" \
    --prefix="$OUT_PREFIX" \
    --libdir="$OUT_PREFIX/lib" \
    "${common_args[@]}"
  make -j"$(nproc)"
  make install
)

echo "build-ffmpeg-linux: installed shared libs in $OUT_PREFIX/lib"
for f in "$OUT_PREFIX"/lib/lib*.so; do
  [ -e "$f" ] || continue
  printf '  %s\n' "$(basename "$f")"
done
echo "  PKG_CONFIG_PATH=$OUT_PREFIX/lib/pkgconfig"
