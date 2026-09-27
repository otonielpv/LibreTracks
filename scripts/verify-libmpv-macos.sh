#!/usr/bin/env bash
# Checks a macOS libmpv before it goes into the .app (video plan, paso 15, C1).
#
#   scripts/verify-libmpv-macos.sh [path/to/libmpv.2.dylib] [--single-arch]
#
# Fails when the dylib:
#   - is not universal (x86_64 + arm64), unless --single-arch (local builds);
#   - links anything outside /usr/lib, /System or @rpath (a Homebrew or build
#     machine path: the app would crash on a clean Mac — memory "macOS FFmpeg
#     dylib crash");
#   - exports anything but mpv_* (above all FFmpeg's av*/sws_/swr_: the audio
#     engine already loads its own libav* into the process);
#   - targets a macOS newer than 12.0 (the app's minimumSystemVersion);
#   - does not identify itself as @rpath/libmpv.2.dylib.
#
# The name does not start with "build" (root .gitignore `build*`).

set -euo pipefail

DYLIB="vendor/bin/libmpv/macos/libmpv.2.dylib"
SINGLE_ARCH=0
for arg in "$@"; do
  case "$arg" in
    --single-arch) SINGLE_ARCH=1 ;;
    *) DYLIB="$arg" ;;
  esac
done
MIN_MACOS=12.0
failures=0
fail() { echo "FALLO: $*" >&2; failures=$((failures + 1)); }

[ -f "$DYLIB" ] || { echo "FALLO: no existe $DYLIB" >&2; exit 1; }
echo "Verificando $DYLIB"

archs="$(lipo -archs "$DYLIB")"
echo "  arquitecturas: $archs"
if [ "$SINGLE_ARCH" = 0 ]; then
  case " $archs " in *" x86_64 "*) ;; *) fail "no incluye x86_64" ;; esac
  case " $archs " in *" arm64 "*) ;; *) fail "no incluye arm64" ;; esac
fi

id="$(otool -D "$DYLIB" | sed -n 2p)"
[ "$id" = "@rpath/libmpv.2.dylib" ] || fail "install name '$id' (se espera @rpath/libmpv.2.dylib)"

for arch in $archs; do
  # Linked libraries: only the system and @rpath.
  while read -r lib; do
    case "$lib" in
      /usr/lib/*|/System/*|@rpath/libmpv.2.dylib) ;;
      *) fail "[$arch] enlaza $lib" ;;
    esac
  done < <(otool -arch "$arch" -L "$DYLIB" | tail -n +2 | awk '{print $1}')

  # Exported symbols: mpv_* only. Read once: `grep -q` on a pipe closes it
  # early and pipefail would count nm's SIGPIPE as a failure.
  exported="$(nm -arch "$arch" -gU "$DYLIB" | awk '{print $3}')"
  others="$(printf '%s\n' "$exported" | grep -v '^_mpv_' | grep -v '^$' || true)"
  if [ -n "$others" ]; then
    fail "[$arch] exporta $(printf '%s\n' "$others" | wc -l | tr -d ' ') símbolos que no son mpv_*: $(printf '%s\n' "$others" | head -5 | tr '\n' ' ')"
  fi
  count="$(printf '%s\n' "$exported" | grep -c '^_mpv_' || true)"
  [ "$count" -gt 0 ] || fail "[$arch] no exporta la API de mpv"
  grep -qx '_mpv_render_context_create' <<< "$exported" \
    || fail "[$arch] no exporta la API de render (mpv_render_context_create)"

  # Minimum macOS the binary was built for.
  minos="$(otool -arch "$arch" -l "$DYLIB" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"
  if [ -z "$minos" ]; then
    minos="$(otool -arch "$arch" -l "$DYLIB" | awk '/LC_VERSION_MIN_MACOSX/{f=1} f&&/version/{print $2; exit}')"
  fi
  echo "  [$arch] minos $minos, $count símbolos mpv_*"
  if [ -z "$minos" ] || [ "$(printf '%s\n%s\n' "$minos" "$MIN_MACOS" | sort -V | tail -1)" != "$MIN_MACOS" ]; then
    fail "[$arch] macOS mínimo $minos > $MIN_MACOS"
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "libmpv NO válida ($failures fallos)" >&2
  exit 1
fi
echo "libmpv válida"
