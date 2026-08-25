#!/usr/bin/env bash
# Build the minimal LGPL decoder stack as static arm64 archives for iPhoneOS.
# The result is linked into the main executable, so the unsigned IPA needs no
# separately signed FFmpeg frameworks or dylibs.
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.1}"
FFMPEG_SHA256="${FFMPEG_SHA256:-733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1}"
IOS_DEPLOYMENT_TARGET="${IOS_DEPLOYMENT_TARGET:-15.0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
OUT_PREFIX="${1:-$REPO_ROOT/vendor/ffmpeg-ios-arm64}"
WORK="$REPO_ROOT/vendor/.ffmpeg-ios-build"
SRC="$WORK/ffmpeg-$FFMPEG_VERSION"
TARBALL="$WORK/ffmpeg-$FFMPEG_VERSION.tar.xz"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "build-ffmpeg-ios: requires macOS/Xcode" >&2
  exit 1
fi

if [[ -z "${FORCE:-}" && -f "$OUT_PREFIX/lib/libavformat.a" ]]; then
  echo "build-ffmpeg-ios: $OUT_PREFIX already exists"
  exit 0
fi

mkdir -p "$WORK"
if [[ ! -d "$SRC" ]]; then
  if [[ ! -f "$TARBALL" ]]; then
    curl -fSL --retry 5 --retry-delay 3 --retry-all-errors \
      --connect-timeout 20 \
      "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
      -o "$TARBALL"
  fi
  echo "$FFMPEG_SHA256  $TARBALL" | shasum -a 256 -c -
  tar -xJf "$TARBALL" -C "$WORK"
fi

SDK_PATH="$(xcrun --sdk iphoneos --show-sdk-path)"
CC="$(xcrun --sdk iphoneos --find clang)"
BUILD="$WORK/build-arm64"
rm -rf "$BUILD" "$OUT_PREFIX"
mkdir -p "$BUILD"

(
  cd "$BUILD"
  "$SRC/configure" \
    --prefix="$OUT_PREFIX" \
    --target-os=darwin \
    --arch=arm64 \
    --enable-cross-compile \
    --cc="$CC" \
    --sysroot="$SDK_PATH" \
    --extra-cflags="-arch arm64 -miphoneos-version-min=$IOS_DEPLOYMENT_TARGET" \
    --extra-ldflags="-arch arm64 -miphoneos-version-min=$IOS_DEPLOYMENT_TARGET" \
    --enable-static --disable-shared \
    --disable-gpl --disable-nonfree \
    --disable-programs --disable-doc --disable-debug \
    --disable-encoders --disable-muxers \
    --disable-avdevice --disable-avfilter --disable-swscale --disable-postproc \
    --disable-network --disable-videotoolbox \
    --disable-bzlib --disable-iconv --disable-lzma --disable-zlib \
    --disable-x86asm
  make -j"$(sysctl -n hw.ncpu)"
  make install
)

for library in avformat avcodec avutil swresample; do
  test -f "$OUT_PREFIX/lib/lib${library}.a"
  lipo -info "$OUT_PREFIX/lib/lib${library}.a"
done
echo "build-ffmpeg-ios: static arm64 decoder stack ready at $OUT_PREFIX"
