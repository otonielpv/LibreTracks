#!/usr/bin/env bash
# Relocate the non-system dylibs the audio engine links against so the app is
# self-contained, instead of pointing at a build-machine Homebrew prefix
# (/usr/local/opt/... or /opt/homebrew/opt/...). Without this the engine dylib
# carries absolute load paths that only resolve on the machine that built it,
# and dyld aborts at launch on every other Mac with:
#   Library not loaded: /usr/local/opt/ffmpeg/lib/libavformat.62.dylib
#
# FFmpeg is the headline dependency, but Homebrew's "full" FFmpeg pulls in a
# whole tree of third-party codec libraries (x264, x265, libvpx, svt-av1, lame,
# opus, dav1d, openssl, ...). dyld loads every dependent dylib when libavcodec
# loads, so leaving ANY of those absolute Homebrew paths in place still crashes
# on another Mac. We therefore vendor the full transitive closure of non-system
# dependencies (the dylibbundler approach), not just libav*.
#
# What it does, given the freshly built engine dylib in vendor/bin/native/:
#   1. Reads the engine's dependencies (otool -L), keeping any absolute path NOT
#      under /usr/lib or /System (those exist on every Mac).
#   2. Copies each one — and, recursively, its own non-system dependencies —
#      into the same dir.
#   3. Rewrites every such reference to @rpath/<name> using install_name_tool,
#      and sets each copied dylib's own id (install_name) to @rpath/<name>.
#
# After this, vendor/bin/native/ holds the engine dylib plus the full set of
# vendored dylibs, all @rpath-relative. Tauri then bundles them into
# Contents/Frameworks and the existing LC_RPATH (@executable_path/../Frameworks)
# resolves them.
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

# True for a dependency path that must be vendored: an absolute path that is
# NOT provided by macOS itself. /usr/lib and /System/Library hold the OS dylibs
# present on every Mac; everything else (Homebrew under /usr/local or
# /opt/homebrew, etc.) ships only on the build machine and must travel with the
# app. @rpath/@loader_path/@executable_path references are already relocatable.
needs_vendoring() {
  case "$1" in
    /usr/lib/* | /System/*) return 1 ;;
    /*) return 0 ;;
    *) return 1 ;;
  esac
}

# Collect the set of FFmpeg dylibs to vendor, walking the dependency graph.
# macOS ships bash 3.2 (no associative arrays), and the GitHub macOS runners do
# too, so track the seen set as a space-delimited string of " base " tokens.
seen=" "
queue=("$ENGINE")

is_seen() {
  # $1 = basename. Returns 0 if already recorded.
  case "$seen" in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

copy_and_record() {
  # $1 = absolute source path of an FFmpeg dylib. Copies it into NATIVE_DIR
  # (if not already there) and queues it for its own dependency scan.
  local src="$1"
  local base
  base="$(basename "$src")"
  local dest="$NATIVE_DIR/$base"
  if ! is_seen "$base"; then
    seen="$seen$base "
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
    if needs_vendoring "$dep"; then
      copy_and_record "$dep"
    fi
  done < <(otool -L "$current" | tail -n +2 | awk '{print $1}')
done

# Trimmed list of vendored basenames (from the " a b c " seen string).
vendored=($seen)

if [[ ${#vendored[@]} -eq 0 ]]; then
  echo "macos-bundle-ffmpeg: no non-system dependencies found (engine built without FFmpeg?) — nothing to relocate."
  exit 0
fi

# Rewrite references in the engine and in every copied dylib so all non-system
# loads go through @rpath, and each copied dylib advertises @rpath/<name> as its
# own id.
relocate() {
  local file="$1"
  chmod u+w "$file"
  # Each copied dylib's own id -> @rpath/<name> (no-op for the engine, whose id
  # is already @rpath/liblt_audio_engine_v2.dylib).
  local self
  self="$(basename "$file")"
  if is_seen "$self"; then
    install_name_tool -id "@rpath/$self" "$file"
  fi
  while IFS= read -r dep; do
    if needs_vendoring "$dep"; then
      local depbase
      depbase="$(basename "$dep")"
      install_name_tool -change "$dep" "@rpath/$depbase" "$file"
    fi
  done < <(otool -L "$file" | tail -n +2 | awk '{print $1}')
}

echo "macos-bundle-ffmpeg: relocating install_names to @rpath"
relocate "$ENGINE"
for base in "${vendored[@]}"; do
  relocate "$NATIVE_DIR/$base"
done

echo "macos-bundle-ffmpeg: done. Vendored dylibs (${#vendored[@]}):"
for base in "${vendored[@]}"; do
  echo "  - $base"
done

# Sanity: no vendored file (engine or copied dylib) may still reference an
# absolute non-system path — that's exactly the load that crashes on other Macs.
leak=0
for file in "$ENGINE" "${vendored[@]/#/$NATIVE_DIR/}"; do
  while IFS= read -r dep; do
    if needs_vendoring "$dep"; then
      echo "macos-bundle-ffmpeg: ERROR — $(basename "$file") still references $dep" >&2
      leak=1
    fi
  done < <(otool -L "$file" | tail -n +2 | awk '{print $1}')
done
if [[ "$leak" -ne 0 ]]; then
  exit 1
fi
echo "macos-bundle-ffmpeg: verified no absolute non-system paths remain in any vendored dylib."

# Tauri only copies into Contents/Frameworks what is listed in
# bundle.macOS.frameworks, and @rpath resolves there — the resources glob would
# drop these into Resources/ instead. Print the ready-to-paste list so drift
# (e.g. a Homebrew FFmpeg bump changing soname versions) is easy to reconcile
# against apps/desktop/src-tauri/tauri.conf.json. The paths are relative to that
# file (apps/desktop/src-tauri/), independent of how NATIVE_DIR was passed.
FW_PREFIX="../../../vendor/bin/native"
echo "macos-bundle-ffmpeg: bundle.macOS.frameworks entries (keep tauri.conf.json in sync):"
echo "      \"$FW_PREFIX/liblt_audio_engine_v2.dylib\","
echo "      \"$FW_PREFIX/bungee.framework\"$([ ${#vendored[@]} -gt 0 ] && echo ,)"
i=0
for base in "${vendored[@]}"; do
  i=$((i + 1))
  comma=,
  [ "$i" -eq "${#vendored[@]}" ] && comma=
  echo "      \"$FW_PREFIX/$base\"$comma"
done
