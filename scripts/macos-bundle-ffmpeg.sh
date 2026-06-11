#!/usr/bin/env bash
# Relocate the FFmpeg/libav dylibs the audio engine links against so the app
# is self-contained, instead of pointing at a build-machine Homebrew prefix
# (/usr/local/opt/ffmpeg/... or /opt/homebrew/opt/ffmpeg/...). Without this the
# engine dylib carries an absolute load path that only resolves on the machine
# that built it, and dyld aborts at launch on every other Mac with:
#   Library not loaded: /usr/local/opt/ffmpeg/lib/libavformat.62.dylib
#
# What it does, given the freshly built engine dylib in vendor/bin/native/:
#   1. Reads the engine's FFmpeg dependencies (otool -L), filtered to libav*.
#   2. Copies each one — and, recursively, FFmpeg's own inter-dependencies
#      (libavcodec needs libavutil/libswresample, etc.) — into the same dir.
#   3. Rewrites every reference to @rpath/<name> using install_name_tool, and
#      sets each copied dylib's own id (install_name) to @rpath/<name>.
#
# After this, vendor/bin/native/ holds the engine dylib plus all libav*.dylib,
# all @rpath-relative. Tauri then bundles them into Contents/Frameworks and the
# existing LC_RPATH (@executable_path/../Frameworks) resolves them.
#
# macOS only. Requires otool + install_name_tool (Xcode command line tools).
# Run from the repo root after the engine build copies its dylib into
# vendor/bin/native/.
set -euo pipefail

NATIVE_DIR="${1:-vendor/bin/native}"
ENGINE="$NATIVE_DIR/liblt_audio_engine_v2.dylib"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macos-bundle-ffmpeg: not macOS, nothing to do."
  exit 0
fi

if [[ ! -f "$ENGINE" ]]; then
  echo "macos-bundle-ffmpeg: engine dylib not found at $ENGINE" >&2
  exit 1
fi

# Matches the absolute, non-@rpath path of an FFmpeg/libav dylib in otool -L
# output. Homebrew uses libavformat.62.dylib style names.
is_ffmpeg_path() {
  case "$1" in
    /*/lib*av*.dylib | /*/libsw*.dylib | /*/libpostproc*.dylib) return 0 ;;
    *) return 1 ;;
  esac
}

# Collect the set of FFmpeg dylibs to vendor, walking the dependency graph.
declare -A seen=()
queue=("$ENGINE")

copy_and_record() {
  # $1 = absolute source path of an FFmpeg dylib. Copies it into NATIVE_DIR
  # (if not already there) and queues it for its own dependency scan.
  local src="$1"
  local base
  base="$(basename "$src")"
  local dest="$NATIVE_DIR/$base"
  if [[ -z "${seen[$base]:-}" ]]; then
    seen[$base]=1
    if [[ ! -f "$dest" ]]; then
      echo "  copy  $src -> $dest"
      cp "$src" "$dest"
      chmod u+w "$dest"
    fi
    queue+=("$dest")
  fi
}

echo "macos-bundle-ffmpeg: scanning $ENGINE"
while [[ ${#queue[@]} -gt 0 ]]; do
  current="${queue[0]}"
  queue=("${queue[@]:1}")
  # otool -L lists dependencies (skip the first line, which is the file itself).
  while IFS= read -r dep; do
    if is_ffmpeg_path "$dep"; then
      copy_and_record "$dep"
    fi
  done < <(otool -L "$current" | tail -n +2 | awk '{print $1}')
done

if [[ ${#seen[@]} -eq 0 ]]; then
  echo "macos-bundle-ffmpeg: no FFmpeg dependencies found (engine built without FFmpeg?) — nothing to relocate."
  exit 0
fi

# Rewrite references in the engine and in every copied FFmpeg dylib so all
# libav* loads go through @rpath, and each copied dylib advertises @rpath/<name>
# as its own id.
relocate() {
  local file="$1"
  chmod u+w "$file"
  # Each copied dylib's own id -> @rpath/<name> (no-op for the engine, whose id
  # is already @rpath/liblt_audio_engine_v2.dylib).
  local self
  self="$(basename "$file")"
  if [[ -n "${seen[$self]:-}" ]]; then
    install_name_tool -id "@rpath/$self" "$file"
  fi
  while IFS= read -r dep; do
    if is_ffmpeg_path "$dep"; then
      local depbase
      depbase="$(basename "$dep")"
      install_name_tool -change "$dep" "@rpath/$depbase" "$file"
    fi
  done < <(otool -L "$file" | tail -n +2 | awk '{print $1}')
}

echo "macos-bundle-ffmpeg: relocating install_names to @rpath"
relocate "$ENGINE"
for base in "${!seen[@]}"; do
  relocate "$NATIVE_DIR/$base"
done

echo "macos-bundle-ffmpeg: done. Vendored FFmpeg dylibs:"
for base in "${!seen[@]}"; do
  echo "  - $base"
done

# Sanity: the engine must no longer reference any absolute FFmpeg path.
if otool -L "$ENGINE" | tail -n +2 | awk '{print $1}' | grep -E '^/.*lib(av|sw|postproc)' >/dev/null; then
  echo "macos-bundle-ffmpeg: ERROR — engine still has an absolute FFmpeg path:" >&2
  otool -L "$ENGINE" | grep -E '^\s+/.*lib(av|sw|postproc)' >&2
  exit 1
fi
echo "macos-bundle-ffmpeg: verified no absolute FFmpeg paths remain in the engine."
