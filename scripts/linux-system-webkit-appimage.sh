#!/usr/bin/env bash
# Repack a Tauri AppImage so GTK/WebKit/Mesa come from the target system.
#
# linuxdeploy's GTK plugin bundles the complete UI stack from the build runner
# and forces X11. On rolling/atomic distributions that old Wayland/GLib stack is
# then loaded alongside the host Mesa driver, which can fail with
# EGL_BAD_PARAMETER and a blank window. It also prevents native Wayland and can
# make rendering noticeably slower.

set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "Usage: $0 <input.AppImage> [output.AppImage] [linuxdeploy-plugin-appimage.AppImage]" >&2
  exit 2
fi

APPIMAGE="$(realpath "$1")"
OUTPUT="${2:-$APPIMAGE}"
OUTPUT="$(realpath -m "$OUTPUT")"
PACKAGER="${3:-${HOME}/.cache/tauri/linuxdeploy-plugin-appimage.AppImage}"
PACKAGER="$(realpath "$PACKAGER")"

if [[ ! -f "$APPIMAGE" || ! -x "$APPIMAGE" ]]; then
  echo "AppImage not found or not executable: $APPIMAGE" >&2
  exit 1
fi
if [[ ! -f "$PACKAGER" || ! -x "$PACKAGER" ]]; then
  echo "AppImage packager not found or not executable: $PACKAGER" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

cd "$WORK_DIR"
"$APPIMAGE" --appimage-extract >/dev/null
APP_DIR="$WORK_DIR/squashfs-root"
LIB_DIR="$APP_DIR/usr/lib"

for required in \
  liblt_audio_engine_v2.so \
  libbungee.so \
  libavformat.so.61 \
  libavcodec.so.61 \
  libavutil.so.59 \
  libswresample.so.5 \
  libbz2.so.1.0 \
  LibreTracks; do
  if [[ ! -e "$LIB_DIR/$required" ]]; then
    echo "Expected AppImage payload is missing usr/lib/$required" >&2
    exit 1
  fi
done

# Keep only LibreTracks resources and its private audio dependency set. The UI
# libraries must be resolved as one coherent stack from the target distro.
for entry in "$LIB_DIR"/*; do
  case "$(basename "$entry")" in
    LibreTracks|liblt_audio_engine_v2.so|libbungee.so|libavformat.so.61|libavcodec.so.61|libavutil.so.59|libswresample.so.5|libbz2.so.1.0)
      ;;
    *)
      rm -rf -- "$entry"
      ;;
  esac
done

# Bypass the GTK hook and AppRun.wrapped: they force X11 and override the host's
# GStreamer/GTK search paths with directories copied from the build machine.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -e' \
  'APPDIR="${APPDIR:-$(dirname "$(readlink -f "$0")")}"' \
  'export LD_LIBRARY_PATH="$APPDIR/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"' \
  'exec "$APPDIR/usr/bin/libretracks-desktop" "$@"' \
  > "$APP_DIR/AppRun"
chmod +x "$APP_DIR/AppRun"
rm -rf -- "$APP_DIR/apprun-hooks" "$APP_DIR/AppRun.wrapped"

mkdir "$WORK_DIR/output"
cd "$WORK_DIR/output"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$PACKAGER" --appdir="$APP_DIR"

REPACKED="$(find "$WORK_DIR/output" -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
if [[ -z "$REPACKED" ]]; then
  echo "The AppImage packager did not produce an artifact" >&2
  exit 1
fi

chmod +x "$REPACKED"
mv -f -- "$REPACKED" "$OUTPUT"
echo "Repacked system-WebKit AppImage: $OUTPUT"
