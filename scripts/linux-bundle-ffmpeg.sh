#!/usr/bin/env bash
# Vendor the FFmpeg shared libraries the audio engine links against into the
# same dir as the engine .so, and set an $ORIGIN rpath on every vendored ELF so
# they resolve from that dir — making the Linux bundle self-contained instead of
# depending on the distro's libav* packages. The Linux counterpart of
# scripts/macos-bundle-ffmpeg.sh.
#
# Without this the engine .so carries a DT_NEEDED of libavformat.so.NN that only
# resolves if the user installed FFmpeg, and the SONAME version differs across
# distros — so the .deb/.rpm/AppImage would fail to load on a clean machine with
# the Linux equivalent of the macOS dyld crash.
#
# What it does, given the freshly built engine .so in vendor/bin/native/:
#   1. Walks the engine's dependency graph (patchelf --print-needed), collecting
#      every NEEDED lib that resolves (via our FFmpeg prefix) to a non-system,
#      FFmpeg/libav* shared object.
#   2. Copies each one — resolving the SONAME symlink to the real file and naming
#      the copy after the SONAME — into vendor/bin/native/.
#   3. Sets rpath '$ORIGIN' on the engine and on every copied .so, so each loads
#      its siblings from the bundle dir, not from /usr/lib.
#
# Tauri then bundles vendor/bin/native/* as resources (see tauri.conf.json), and
# the engine + its libav* siblings travel together with a relative rpath.
#
# Linux only. Requires patchelf (apt: patchelf) and the FFmpeg prefix built by
# scripts/build-ffmpeg-linux.sh. Run from the repo root after the engine build
# copies its .so into vendor/bin/native/.
set -euo pipefail

NATIVE_DIR="${1:-vendor/bin/native}"
FFMPEG_PREFIX="${2:-vendor/ffmpeg-linux}"
ENGINE="$NATIVE_DIR/liblt_audio_engine_v2.so"

if [[ "$(uname)" != "Linux" ]]; then
  echo "linux-bundle-ffmpeg: not Linux, nothing to do."
  exit 0
fi

if [[ ! -f "$ENGINE" ]]; then
  echo "linux-bundle-ffmpeg: engine .so not found at $ENGINE" >&2
  exit 1
fi
if ! command -v patchelf >/dev/null 2>&1; then
  echo "linux-bundle-ffmpeg: patchelf not found (apt-get install -y patchelf)" >&2
  exit 1
fi

FFMPEG_LIBDIR="$FFMPEG_PREFIX/lib"
if [[ ! -d "$FFMPEG_LIBDIR" ]]; then
  echo "linux-bundle-ffmpeg: FFmpeg prefix '$FFMPEG_LIBDIR' missing — run scripts/build-ffmpeg-linux.sh first." >&2
  exit 1
fi

# A NEEDED entry we must vendor: one of our libav* shared objects. (System libs
# like libc/libm/libpthread are present on every Linux and stay external; only
# FFmpeg travels with the app.)
is_ffmpeg_soname() {
  case "$1" in
    libavformat.so* | libavcodec.so* | libavutil.so* | libswresample.so* \
      | libswscale.so* | libavfilter.so* | libavdevice.so*) return 0 ;;
    *) return 1 ;;
  esac
}

# Resolve a SONAME (e.g. libavformat.so.61) to the real file in our FFmpeg
# prefix, following symlinks, and echo its absolute path. Empty if absent.
resolve_in_prefix() {
  local soname="$1"
  local candidate="$FFMPEG_LIBDIR/$soname"
  [[ -e "$candidate" ]] && { readlink -f "$candidate"; return 0; }
  return 1
}

seen=" "
queue=("$ENGINE")
vendored=()

is_seen() { case "$seen" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

echo "linux-bundle-ffmpeg: scanning $ENGINE"
while [[ ${#queue[@]} -gt 0 ]]; do
  current="${queue[0]}"
  queue=("${queue[@]:1}")
  while IFS= read -r need; do
    [[ -z "$need" ]] && continue
    is_ffmpeg_soname "$need" || continue
    if is_seen "$need"; then continue; fi
    real="$(resolve_in_prefix "$need")" || {
      echo "linux-bundle-ffmpeg: ERROR — engine needs $need but it is not in $FFMPEG_LIBDIR" >&2
      exit 1
    }
    seen="$seen$need "
    dest="$NATIVE_DIR/$need"   # name the copy after the SONAME the loader asks for
    if [[ ! -f "$dest" ]]; then
      echo "  copy  $real -> $dest"
      cp "$real" "$dest"
      chmod u+w "$dest"
    fi
    vendored+=("$need")
    queue+=("$dest")          # scan its own NEEDED for transitive libav* deps
  done < <(patchelf --print-needed "$current")
done

if [[ ${#vendored[@]} -eq 0 ]]; then
  echo "linux-bundle-ffmpeg: no libav* dependencies found (engine built without FFmpeg?) — nothing to relocate."
  exit 0
fi

# Set rpath '$ORIGIN' so each ELF finds its siblings in the bundle dir.
echo "linux-bundle-ffmpeg: setting rpath '\$ORIGIN'"
patchelf --set-rpath '$ORIGIN' "$ENGINE"
for soname in "${vendored[@]}"; do
  patchelf --set-rpath '$ORIGIN' "$NATIVE_DIR/$soname"
done

echo "linux-bundle-ffmpeg: done. Vendored libs (${#vendored[@]}):"
for soname in "${vendored[@]}"; do
  echo "  - $soname"
done

# Sanity: with the bundle dir as the only search path, ldd must resolve every
# libav* NEEDED to a sibling — none may fall through to the system or go missing.
echo "linux-bundle-ffmpeg: verifying self-contained resolution"
leak=0
for f in "$ENGINE" "${vendored[@]/#/$NATIVE_DIR/}"; do
  while IFS= read -r line; do
    # ldd lines: "<soname> => <path> (0x..)" or "<soname> => not found".
    soname="${line%% =>*}"; soname="${soname##*[[:space:]]}"
    is_ffmpeg_soname "$soname" || continue
    case "$line" in
      *"not found"*)
        echo "linux-bundle-ffmpeg: ERROR — $(basename "$f") cannot resolve $soname" >&2
        leak=1 ;;
      *"=> $NATIVE_DIR/"* | *"=> $(readlink -f "$NATIVE_DIR")/"*) ;;  # sibling: good
      *)
        echo "linux-bundle-ffmpeg: WARN — $(basename "$f") resolves $soname outside the bundle: $line" >&2 ;;
    esac
  done < <(LD_LIBRARY_PATH="$NATIVE_DIR" ldd "$f" 2>/dev/null || true)
done
if [[ "$leak" -ne 0 ]]; then
  exit 1
fi
echo "linux-bundle-ffmpeg: verified the engine and all libav* siblings resolve within the bundle."
