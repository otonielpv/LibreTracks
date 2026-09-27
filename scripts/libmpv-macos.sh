#!/usr/bin/env bash
# Builds a self-contained libmpv for macOS (video plan, paso 15a / D1).
#
#   scripts/libmpv-macos.sh [--arch x86_64|arm64|universal] [--out DIR] [--work DIR]
#
# Output: DIR/libmpv.2.dylib (default vendor/bin/libmpv/macos/). Every
# dependency is built from pinned sources as a STATIC library and linked into
# that one dylib, which exports only mpv_* (the audio engine already loads its
# own libav*.dylib into the process: two exported FFmpegs would clash).
#
# - LGPL build: FFmpeg without --enable-gpl, mpv with -Dgpl=false.
# - macOS 12.0 minimum (tauri.conf.json bundle.macOS.minimumSystemVersion).
# - No Swift, no Lua/JavaScript: nothing that needs extra entitlements or the
#   Swift runtime in the bundle.
# - Never Homebrew dylibs in the result (memory "macOS FFmpeg dylib crash").
#   Homebrew may provide build TOOLS only (meson, ninja, nasm, pkg-config).
#
# The name does not start with "build": the root .gitignore's `build*` would
# swallow it and a clean clone (the CI) would not see it.
#
# Needs: Xcode command line tools, python3 with meson + jinja2 (libplacebo),
# ninja, nasm (x86_64 FFmpeg asm), pkg-config or pkgconf, git, curl.

set -euo pipefail

ARCH=universal
OUT=""
WORK="${LIBMPV_WORK:-$HOME/.cache/libretracks-libmpv}"
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    *) echo "argumento desconocido: $1" >&2; exit 2 ;;
  esac
done
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$REPO/vendor/bin/libmpv/macos}"
MIN_MACOS=12.0

# --- Pinned sources ---------------------------------------------------------
FFMPEG_URL=https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz
FFMPEG_SHA=733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1
FREETYPE_URL=https://download.savannah.gnu.org/releases/freetype/freetype-2.13.3.tar.xz
FREETYPE_SHA=0550350666d427c74daeb85d5ac7bb353acba5f76956395995311a9c6f063289
FRIBIDI_URL=https://github.com/fribidi/fribidi/releases/download/v1.0.16/fribidi-1.0.16.tar.xz
FRIBIDI_SHA=1b1cde5b235d40479e91be2f0e88a309e3214c8ab470ec8a2744d82a5a9ea05c
HARFBUZZ_URL=https://github.com/harfbuzz/harfbuzz/releases/download/10.4.0/harfbuzz-10.4.0.tar.xz
HARFBUZZ_SHA=480b6d25014169300669aa1fc39fb356c142d5028324ea52b3a27648b9beaad8
LIBASS_URL=https://github.com/libass/libass/releases/download/0.17.3/libass-0.17.3.tar.xz
LIBASS_SHA=eae425da50f0015c21f7b3a9c7262a910f0218af469e22e2931462fed3c50959
# libplacebo's archives lack its `glad` submodule: cloned at a pinned tag.
LIBPLACEBO_GIT=https://code.videolan.org/videolan/libplacebo.git
LIBPLACEBO_TAG=v7.349.0
MPV_URL=https://github.com/mpv-player/mpv/archive/refs/tags/v0.40.0.tar.gz
MPV_SHA=10a0f4654f62140a6dd4d380dcf0bbdbdcf6e697556863dc499c296182f081a3

log() { printf '\n=== %s\n' "$*"; }

fetch() { # url sha -> path of the verified archive
  local url="$1" sha="$2" file="$WORK/src/$(basename "$1")"
  mkdir -p "$WORK/src"
  [ -f "$file" ] || curl -fsSL -o "$file.part" "$url" && { [ ! -f "$file.part" ] || mv "$file.part" "$file"; }
  local got; got="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  if [ "$got" != "$sha" ]; then
    echo "SHA-256 inesperado para $file: $got (esperado $sha)" >&2
    exit 1
  fi
  echo "$file"
}

unpack() { # archive destdir
  rm -rf "$2"; mkdir -p "$2"
  tar -xf "$1" -C "$2" --strip-components 1
}

# pkg-config: meson and FFmpeg look for that name; pip's pkgconf installs
# `pkgconf`. A shim keeps the build independent of Homebrew.
ensure_pkg_config() {
  if ! command -v pkg-config >/dev/null 2>&1; then
    command -v pkgconf >/dev/null 2>&1 || { echo "falta pkg-config/pkgconf" >&2; exit 1; }
    mkdir -p "$WORK/shims"
    ln -sf "$(command -v pkgconf)" "$WORK/shims/pkg-config"
    export PATH="$WORK/shims:$PATH"
  fi
}

# mpv 0.40's `cocoa` feature assumes the Swift build: app_bridge.m and the
# macOS clipboard include the Swift-generated header. With Swift, libmpv would
# also hook into the HOST app's NSApp on every mpv_create (media keys, input
# monitors) — not wanted inside LibreTracks. So: no Swift, and a minimal patch
# that (1) drops the macOS clipboard backend (unused: no OSD, no keyboard) and
# (2) gives app_bridge.m no-op versions of the Swift-only entry points the
# core calls under HAVE_COCOA. The one that is not a no-op: the core creates a
# "mac" client for the Swift app hub and waits for every client to start
# before playing anything, so without Swift that client must be released
# (mpv_destroy) or playback never begins. Verified on the pinned tag.
patch_mpv_without_swift() {
  python3 - "$1" <<'PYEOF'
import pathlib, sys
root = pathlib.Path(sys.argv[1])

def patch(rel, old, new):
    path = root / rel
    text = path.read_text()
    if text.count(old) != 1:
        sys.exit(f"parche de mpv no aplica en {rel}: {old[:60]!r}")
    path.write_text(text.replace(old, new))

patch("meson.build",
      "'osdep/mac/app_bridge.m',\n                     'player/clipboard/clipboard-mac.m')",
      "'osdep/mac/app_bridge.m')")
patch("player/clipboard/clipboard.c",
      "#if HAVE_COCOA\n    &clipboard_backend_mac,",
      "#if HAVE_COCOA && HAVE_SWIFT\n    &clipboard_backend_mac,")
patch("osdep/mac/app_bridge.m",
      '#include "osdep/mac/swift.h"',
      '#if HAVE_SWIFT\n#include "osdep/mac/swift.h"\n#endif')
text = (root / "osdep/mac/app_bridge.m").read_text()
tail = text.rstrip()
if not tail.endswith("#endif"):
    sys.exit("parche de mpv no aplica: app_bridge.m no termina en #endif")
stubs = """#else
void cocoa_init_media_keys(void) {}
void cocoa_uninit_media_keys(void) {}
void cocoa_set_input_context(struct input_ctx *input_context) {}
void cocoa_set_mpv_handle(struct mpv_handle *ctx) { mpv_destroy(ctx); }
void cocoa_init_cocoa_cb(void) {}
int cocoa_main(int argc, char *argv[]) { return 1; }
#endif
"""
(root / "osdep/mac/app_bridge.m").write_text(tail[: -len("#endif")] + stubs)
PYEOF
}

build_arch() {
  local arch="$1"
  local cpu_family cpu
  if [ "$arch" = arm64 ]; then cpu_family=aarch64; cpu=arm64; else cpu_family=x86_64; cpu=x86_64; fi
  local root="$WORK/$arch"
  local prefix="$root/prefix"
  local flags="-arch $arch -mmacosx-version-min=$MIN_MACOS -fPIC"
  mkdir -p "$prefix"

  # Only this prefix's .pc files: nothing from the system or Homebrew.
  export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
  export PKG_CONFIG_PATH=""

  local cross="$root/cross.ini"
  cat > "$cross" <<EOF
[binaries]
c = 'clang'
cpp = 'clang++'
objc = 'clang'
objcpp = 'clang++'
ar = 'ar'
strip = 'strip'
pkg-config = 'pkg-config'

[built-in options]
c_args = ['-arch', '$arch', '-mmacosx-version-min=$MIN_MACOS']
cpp_args = ['-arch', '$arch', '-mmacosx-version-min=$MIN_MACOS']
objc_args = ['-arch', '$arch', '-mmacosx-version-min=$MIN_MACOS']
c_link_args = ['-arch', '$arch', '-mmacosx-version-min=$MIN_MACOS']
cpp_link_args = ['-arch', '$arch', '-mmacosx-version-min=$MIN_MACOS']
objc_link_args = ['-arch', '$arch', '-mmacosx-version-min=$MIN_MACOS']

[host_machine]
system = 'darwin'
cpu_family = '$cpu_family'
cpu = '$cpu'
endian = 'little'
EOF

  meson_static() { # srcdir [options...]
    local src="$1"; shift
    meson setup "$src/_b" "$src" --cross-file "$cross" --prefix "$prefix" --libdir lib \
      --buildtype release --default-library static -Db_ndebug=true --wrap-mode=nodownload "$@"
    ninja -C "$src/_b"
    ninja -C "$src/_b" install
  }

  if [ ! -f "$prefix/lib/libavcodec.a" ]; then
    log "[$arch] FFmpeg"
    unpack "$(fetch $FFMPEG_URL $FFMPEG_SHA)" "$root/ffmpeg"
    local ffarch=x86_64; [ "$arch" = arm64 ] && ffarch=aarch64
    (cd "$root/ffmpeg" && ./configure --prefix="$prefix" \
      --enable-cross-compile --arch="$ffarch" --target-os=darwin --cc=clang \
      --extra-cflags="$flags" --extra-ldflags="$flags" \
      --enable-static --disable-shared --enable-pic \
      --disable-programs --disable-doc --disable-debug --disable-network \
      --disable-autodetect --enable-videotoolbox --enable-audiotoolbox --enable-zlib \
      --disable-encoders --enable-encoder=mjpeg,png \
      --disable-muxers --disable-devices \
      --disable-protocols --enable-protocol=file,pipe,data \
      && make -j"$(sysctl -n hw.ncpu)" && make install)
  fi

  if [ ! -f "$prefix/lib/libfreetype.a" ]; then
    log "[$arch] freetype"
    unpack "$(fetch $FREETYPE_URL $FREETYPE_SHA)" "$root/freetype"
    meson_static "$root/freetype" -Dbrotli=disabled -Dbzip2=disabled -Dharfbuzz=disabled \
      -Dpng=disabled -Dzlib=disabled -Dtests=disabled
  fi

  if [ ! -f "$prefix/lib/libfribidi.a" ]; then
    log "[$arch] fribidi"
    unpack "$(fetch $FRIBIDI_URL $FRIBIDI_SHA)" "$root/fribidi"
    meson_static "$root/fribidi" -Ddocs=false -Dbin=false -Dtests=false
  fi

  if [ ! -f "$prefix/lib/libharfbuzz.a" ]; then
    log "[$arch] harfbuzz"
    unpack "$(fetch $HARFBUZZ_URL $HARFBUZZ_SHA)" "$root/harfbuzz"
    meson_static "$root/harfbuzz" -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled \
      -Dcairo=disabled -Dicu=disabled -Dgraphite2=disabled -Dcoretext=disabled \
      -Dtests=disabled -Ddocs=disabled -Dutilities=disabled -Dintrospection=disabled
  fi

  if [ ! -f "$prefix/lib/libass.a" ]; then
    log "[$arch] libass"
    unpack "$(fetch $LIBASS_URL $LIBASS_SHA)" "$root/libass"
    (cd "$root/libass" && \
      CC=clang CFLAGS="$flags" LDFLAGS="$flags" \
      ./configure --host="$cpu_family-apple-darwin" --prefix="$prefix" \
        --enable-static --disable-shared --disable-fontconfig --disable-require-system-font-provider \
        --disable-asm && make -j"$(sysctl -n hw.ncpu)" && make install)
  fi

  if [ ! -f "$prefix/lib/libplacebo.a" ]; then
    log "[$arch] libplacebo"
    rm -rf "$root/libplacebo"
    git clone -q --depth 1 --branch "$LIBPLACEBO_TAG" --recurse-submodules --shallow-submodules \
      "$LIBPLACEBO_GIT" "$root/libplacebo"
    meson_static "$root/libplacebo" -Dvulkan=disabled -Dopengl=enabled -Dd3d11=disabled \
      -Dshaderc=disabled -Dglslang=disabled -Dlcms=disabled -Ddovi=disabled -Dlibdovi=disabled \
      -Ddemos=false -Dtests=false -Dxxhash=disabled -Dunwind=disabled
  fi

  if [ ! -f "$root/mpv/_b/libmpv.2.dylib" ]; then
    log "[$arch] mpv"
    unpack "$(fetch $MPV_URL $MPV_SHA)" "$root/mpv"
    patch_mpv_without_swift "$root/mpv"
    # Default: every optional feature off; only what LibreTracks needs on.
    # `cocoa` here only links the system frameworks (no Swift); `gl-cocoa`
    # is what `videotoolbox-gl` needs for zero-copy hardware decoding into
    # the OpenGL render API the app draws with (paso 15, D5).
    # Export mpv_* only: the static FFmpeg, libplacebo, harfbuzz… stay
    # hidden inside (T3: the audio engine loads its own libav*).
    # libmpv has Objective-C sources, so meson links with objc_link_args:
    # the list goes into every *_link_args of an mpv-only cross file.
    printf '_mpv_*\n' > "$root/mpv-exports.txt"
    local export_flag="-Wl,-exported_symbols_list,$root/mpv-exports.txt"
    sed -E "s#^(c|cpp|objc)_link_args = \[(.*)\]\$#\1_link_args = [\2, '$export_flag']#" "$cross" > "$root/cross-mpv.ini"
    grep -q "exported_symbols_list" "$root/cross-mpv.ini" || { echo "no se pudo preparar cross-mpv.ini" >&2; exit 1; }
    meson setup "$root/mpv/_b" "$root/mpv" --cross-file "$root/cross-mpv.ini" --prefix "$prefix" --libdir lib \
      --buildtype release -Db_ndebug=true --wrap-mode=nodownload \
      --default-library shared -Dauto_features=disabled \
      -Dlibmpv=true -Dcplayer=false -Dgpl=false \
      -Dgl=enabled -Dlibavdevice=disabled -Dzlib=enabled -Diconv=disabled \
      -Dcocoa=enabled -Dgl-cocoa=enabled -Dvideotoolbox-gl=enabled -Dcoreaudio=enabled \
      -Dswift-build=disabled -Dmacos-cocoa-cb=disabled -Dmacos-media-player=disabled \
      -Dmacos-touchbar=disabled
    ninja -C "$root/mpv/_b"
  fi
}

ensure_pkg_config
case "$ARCH" in
  universal) ARCHES="x86_64 arm64" ;;
  x86_64|arm64) ARCHES="$ARCH" ;;
  *) echo "arquitectura no válida: $ARCH" >&2; exit 2 ;;
esac
for arch in $ARCHES; do
  build_arch "$arch"
done

mkdir -p "$OUT"
inputs=()
for arch in $ARCHES; do inputs+=("$WORK/$arch/mpv/_b/libmpv.2.dylib"); done
if [ "${#inputs[@]}" -gt 1 ]; then
  lipo -create "${inputs[@]}" -output "$OUT/libmpv.2.dylib"
else
  cp "${inputs[0]}" "$OUT/libmpv.2.dylib"
fi
install_name_tool -id @rpath/libmpv.2.dylib "$OUT/libmpv.2.dylib"
log "libmpv lista: $OUT/libmpv.2.dylib"
lipo -info "$OUT/libmpv.2.dylib"
