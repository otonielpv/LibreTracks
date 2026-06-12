#!/usr/bin/env bash
# Build a minimal, decoder-only, LGPL, universal (x86_64 + arm64) FFmpeg for
# macOS from source, and install it as universal shared libraries (.dylib) +
# pkg-config manifests the engine can link against.
#
# Why from source instead of Homebrew:
#   - LICENSE: Homebrew's FFmpeg is --enable-gpl (x264/x265/...); bundling it
#     into LibreTracks (MIT) is a license conflict. A vanilla FFmpeg WITHOUT the
#     --enable-gpl / external-encoder flags is LGPL and ships no GPL code. The
#     audio formats we need (AAC/M4A, ALAC, MP3, FLAC, PCM, Vorbis, Opus, ...)
#     all have built-in LGPL decoders — no third-party libs required.
#   - UNIVERSAL: Homebrew bottles are single-arch. We build each arch and lipo
#     them, so the universal-apple-darwin .app links and runs on both.
#   - REPRODUCIBLE: the version is pinned here, not whatever brew happens to ship.
#
# The engine only ever decodes (avformat_open_input + avcodec_find_decoder), so
# encoders/muxers/filters/devices/scaling are all disabled — that keeps the
# closure to the four libav* dylibs with no external dependencies, which
# scripts/macos-bundle-ffmpeg.sh then relocates into the .app as usual.
#
# Usage:
#   scripts/build-ffmpeg-universal.sh [OUT_PREFIX]
# OUT_PREFIX defaults to vendor/ffmpeg-universal (relative to repo root). Point
# the engine build at it with PKG_CONFIG_PATH="$OUT_PREFIX/lib/pkgconfig".
#
# macOS only. Requires clang + make + curl/tar (Xcode command line tools).
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.1}"
FFMPEG_SHA256="${FFMPEG_SHA256:-733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1}"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "build-ffmpeg-universal: not macOS, nothing to do."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
OUT_PREFIX="${1:-$REPO_ROOT/vendor/ffmpeg-universal}"
WORK="$REPO_ROOT/vendor/.ffmpeg-build"
SRC="$WORK/ffmpeg-$FFMPEG_VERSION"

mkdir -p "$WORK"

# ── Idempotency: skip the (slow) double build if the universal output is
#    already present and universal. Set FORCE=1 to rebuild from scratch. ───────
existing="$OUT_PREFIX/lib/libavformat.dylib"
if [[ -z "${FORCE:-}" && -f "$existing" ]]; then
  archs="$(lipo -archs "$existing" 2>/dev/null || echo '')"
  if [[ "$archs" == *x86_64* && "$archs" == *arm64* ]]; then
    echo "build-ffmpeg-universal: $OUT_PREFIX already built (universal). Set FORCE=1 to rebuild."
    echo "  PKG_CONFIG_PATH=$OUT_PREFIX/lib/pkgconfig"
    exit 0
  fi
fi

# ── Fetch + verify source (pinned) ──────────────────────────────────────────
TARBALL="$WORK/ffmpeg-$FFMPEG_VERSION.tar.xz"
if [[ ! -d "$SRC" ]]; then
  if [[ ! -f "$TARBALL" ]]; then
    echo "build-ffmpeg-universal: downloading FFmpeg $FFMPEG_VERSION"
    curl -fSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$TARBALL"
  fi
  echo "$FFMPEG_SHA256  $TARBALL" | shasum -a 256 -c -
  tar -xJf "$TARBALL" -C "$WORK"
fi

# Common config: strip everything we don't decode with, stay LGPL (no --enable-gpl
# and no external encoder libs), keep all built-in decoders/demuxers/parsers.
common_args=(
  --enable-shared --disable-static
  --disable-gpl --disable-nonfree
  --disable-programs --disable-doc
  --disable-encoders --disable-muxers
  --disable-avdevice --disable-avfilter --disable-swscale --disable-postproc
  --disable-network --disable-debug
  --disable-lzma              # liblzma (xz) is Homebrew, not a system lib — drop it
  --disable-videotoolbox      # we decode audio only; avoids CoreVideo + its newer-OS
                              # symbols (e.g. CVBufferCopyAttachments, macOS 12+) that
                              # crash on Catalina/Big Sur as a hard dependency
  --disable-x86asm            # no nasm/yasm dependency; audio decode is light
  # install_name points at the FINAL universal prefix (not the per-arch build
  # prefix). The engine links these by that absolute path, so at bundle time
  # scripts/macos-bundle-ffmpeg.sh copies the UNIVERSAL dylib (from OUT_PREFIX)
  # and rewrites every reference to @rpath — the same path used for any other
  # non-system dylib. Pointing at the per-arch prefix here would make the bundle
  # step copy a single-arch slice; forcing @rpath would make it skip them (it
  # only vendors absolute non-system paths).
  "--install-name-dir=$OUT_PREFIX/lib"
)

# ── Build one architecture into its own prefix ──────────────────────────────
build_one() {
  local arch="$1" minver="$2" prefix="$3"
  local ffarch builddir host_arch
  host_arch="$(uname -m)"
  case "$arch" in
    arm64) ffarch=aarch64 ;;
    x86_64) ffarch=x86_64 ;;
    *) echo "build-ffmpeg-universal: unknown arch $arch" >&2; return 1 ;;
  esac
  builddir="$WORK/build-$arch"
  rm -rf "$builddir" "$prefix"
  mkdir -p "$builddir"
  echo "build-ffmpeg-universal: configuring $arch (min macOS $minver)"
  local cross=()
  if [[ "$arch" != "$host_arch" ]]; then
    cross=(--enable-cross-compile --arch="$ffarch" --target-os=darwin)
  fi
  (
    cd "$builddir"
    "$SRC/configure" \
      --prefix="$prefix" \
      --cc="clang -arch $arch" \
      --extra-cflags="-arch $arch -mmacosx-version-min=$minver" \
      --extra-ldflags="-arch $arch -mmacosx-version-min=$minver" \
      ${cross[@]+"${cross[@]}"} \
      "${common_args[@]}"
    make -j"$(sysctl -n hw.ncpu)"
    make install
  )
}

# arm64 only exists from macOS 11; x86_64 carries our 10.15 floor.
build_one x86_64 10.15 "$WORK/prefix-x86_64"
build_one arm64  11.0  "$WORK/prefix-arm64"

# ── Fuse the two into a universal prefix ────────────────────────────────────
echo "build-ffmpeg-universal: lipo-merging into $OUT_PREFIX"
rm -rf "$OUT_PREFIX"
# Headers + pkg-config are arch-independent; take the x86_64 prefix as the base.
cp -R "$WORK/prefix-x86_64" "$OUT_PREFIX"

# Replace each real dylib with a universal one (skip the symlinks brew-style
# sonames create: operate on regular files only).
while IFS= read -r dylib; do
  rel="${dylib#"$WORK/prefix-x86_64/"}"
  arm="$WORK/prefix-arm64/$rel"
  if [[ ! -f "$arm" ]]; then
    echo "build-ffmpeg-universal: ERROR — missing arm64 counterpart for $rel" >&2
    exit 1
  fi
  lipo -create "$dylib" "$arm" -output "$OUT_PREFIX/$rel"
done < <(find "$WORK/prefix-x86_64/lib" -type f -name '*.dylib')

# Repoint the pkg-config paths at the universal tree so the engine build finds
# these headers/libs via PKG_CONFIG_PATH="$OUT_PREFIX/lib/pkgconfig". FFmpeg's
# .pc files hardcode ABSOLUTE libdir/includedir (not ${prefix}-derived), and
# `Libs: -L${libdir}` uses that absolute libdir — so rewriting only `prefix=`
# leaves the linker pointing at the per-arch prefix-x86_64 tree, which is
# x86_64-only and makes the arm64 link fail with "ignoring file ... found
# architecture 'x86_64', required architecture 'arm64'". Rewrite every absolute
# path (prefix/exec_prefix/libdir/includedir) that points at the per-arch build.
while IFS= read -r pc; do
  /usr/bin/sed -i '' \
    -e "s#^prefix=.*#prefix=$OUT_PREFIX#" \
    -e "s#^exec_prefix=.*#exec_prefix=$OUT_PREFIX#" \
    -e "s#^libdir=.*#libdir=$OUT_PREFIX/lib#" \
    -e "s#^includedir=.*#includedir=$OUT_PREFIX/include#" \
    "$pc"
done < <(find "$OUT_PREFIX/lib/pkgconfig" -name '*.pc')

echo "build-ffmpeg-universal: done. Universal FFmpeg at $OUT_PREFIX"
echo "  PKG_CONFIG_PATH=$OUT_PREFIX/lib/pkgconfig"
for f in "$OUT_PREFIX"/lib/*.dylib; do
  [[ -f "$f" ]] || continue
  printf '  %-28s %s\n' "$(basename "$f")" "$(lipo -archs "$f")"
done
