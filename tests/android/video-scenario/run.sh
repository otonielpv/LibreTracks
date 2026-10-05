#!/usr/bin/env bash
# End-to-end video scenario on an Android emulator (plan video-mobile, pasos
# 03-10). Drives the real app through its Tauri commands over DevTools, with
# the emulator's simulated secondary display as the projector; every check
# prints PASS/FAIL.
#
# Needs a DEBUG APK installed (WebView debugging and `run-as` only exist
# there), Node 22+ and ffmpeg (to make the test videos). WIPES the app's data
# (pm clear) on purpose: use a dedicated emulator (LT_Midi_Test).
#
#   ANDROID_HOME=... bash tests/android/video-scenario/run.sh
export MSYS_NO_PATHCONV=1
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
ADB="${SDK:+$SDK/platform-tools/}adb"
HERE="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
CDP="$HERE/../midi-scenario/cdp.mjs"
PKG=com.libretracks.app
FG="am start -n $PKG/com.libretracks.desktop.MainActivity"
WORK="${TMPDIR:-/tmp}/lt-video-scenario"
fails=0
js() { node "$CDP" "$1"; }
check() { # label, js returning true/false
  local out; out=$(js "$2")
  if [ "$out" = "true" ]; then echo "PASS $1"; else echo "FAIL $1 -> $out"; fails=$((fails+1)); fi
}
wait_for() { # label, js returning true/false, seconds
  local out
  for _ in $(seq 1 "$3"); do
    out=$(js "$2"); [ "$out" = "true" ] && { echo "PASS $1"; return; }
    sleep 1
  done
  echo "FAIL $1 -> $out"; fails=$((fails+1))
}
show() { echo "     $1: $(js "$2")"; }
state_is() { echo "(async () => (await inv(\"video_output_status\")).state.state === \"$1\")()"; }

mkdir -p "$WORK"
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=20" \
  -f lavfi -i "sine=frequency=440:duration=20" -c:v libx264 -pix_fmt yuv420p -g 30 \
  -c:a aac -shortest "$WORK/letras.mp4"
ffmpeg -y -loglevel error -f lavfi -i "testsrc=size=640x360:rate=25:duration=5" \
  -c:v prores_ks -profile:v 0 "$WORK/prores.mov"

$ADB shell settings delete global overlay_display_devices >/dev/null 2>&1
$ADB shell am force-stop $PKG
$ADB shell pm clear $PKG >/dev/null
$ADB shell $FG >/dev/null
for i in $(seq 1 60); do $ADB shell cat /proc/net/unix 2>/dev/null | grep -q webview_devtools_remote && break; sleep 3; done
sleep 15

# The videos go into the app's own files dir (run-as: debug APK only).
FILES=/data/user/0/$PKG/files
for f in letras.mp4 prores.mov; do
  $ADB push "$WORK/$f" /data/local/tmp/$f >/dev/null
  $ADB shell run-as $PKG cp /data/local/tmp/$f files/$f
done

echo "--- session"
js '(async () => { const p = await inv("open_demo_session"); await inv("start_open_project_from_path", { songFile: p }); return p; })()' >/dev/null
wait_for "demo session open" '(async () => { try { const s = await inv("get_song_view", { includeWaveforms: false }); return !!s && s.tracks.length > 0; } catch (e) { return false; } })()' 60

echo "--- 03: native backend"
check "video backend available on Android" '(async () => { const s = await inv("video_media_status"); return s.supportedPlatform && s.available; })()'

echo "--- 07: analysis"
check "H.264 analysed natively (duration, size, fps, audio)" "(async () => { const r = await inv(\"import_video_files\", { filePaths: [\"$FILES/letras.mp4\"], folderPath: null }); const a = r.assets[0]; return r.skipped.length === 0 && Math.abs(a.info.durationSeconds - 20) < 0.2 && a.info.width === 1280 && a.info.height === 720 && Math.round(a.info.fps) === 30 && a.info.hasAudio; })()"
show "letras.mp4" '(async () => (await inv("list_video_assets")).find(a => a.fileName === "letras.mp4")?.info)()'
js "inv(\"import_video_files\", { filePaths: [\"$FILES/prores.mov\"], folderPath: null })" >/dev/null
show "prores.mov" '(async () => (await inv("list_video_assets")).find(a => a.fileName === "prores.mov") ?? "skipped")()'
check "ProRes: not playable here, not missing" '(async () => { const a = (await inv("list_video_assets")).find(x => x.fileName === "prores.mov"); return !a || (!a.isMissing && typeof a.unplayableReason === "string"); })()'
js "inv(\"request_video_thumbnails\", { filePaths: [\"$FILES/letras.mp4\"], urgent: true })" >/dev/null
wait_for "thumbnails made by the system decoder" "(async () => { const t = await inv(\"get_video_thumbnails\", { filePath: \"$FILES/letras.mp4\" }); return !!t && t.frames.length === 20; })()" 60

echo "--- 06/10: displays and output"
js "inv(\"place_video_clips\", { items: [{ filePath: \"$FILES/letras.mp4\", durationSeconds: 20 }], timelineStartSeconds: 0, targetTrackId: null })" >/dev/null
check "clip placed on a new video track" '(async () => (await inv("get_song_view", { includeWaveforms: false })).videoClips.length === 1)()'
js '(async () => { const s = await inv("get_settings"); await inv("video_apply_settings", { settings: { ...(s.videoOutput ?? {}), enabled: true, display: null } }); return true; })()' >/dev/null
wait_for "no external display: noDisplay" "$(state_is noDisplay)" 10
check "phone screen not listed" '(async () => (await inv("video_list_displays")).length === 0)()'

$ADB shell settings put global overlay_display_devices 1280x720/213
wait_for "projector plugged: output ready by itself" "$(state_is ready)" 15
check "external display listed" '(async () => { const d = await inv("video_list_displays"); return d.length === 1 && d[0].width === 1280; })()'
show "status" '(async () => { const s = await inv("video_output_status"); return { state: s.state, monitor: s.monitorName, dual: s.dualPlayers, note: s.playersNote }; })()'

echo "--- 05: playback in sync"
js 'inv("play_transport")' >/dev/null
wait_for "player reports time and moves" '(async () => { const a = (await inv("video_output_status")).players[0]; if (a.timePos == null) return false; const t0 = a.timePos; await new Promise(r => setTimeout(r, 1500)); const b = (await inv("video_output_status")).players[0]; return b.timePos > t0 + 0.8; })()' 20
sleep 4
show "sync stats" 'inv("video_sync_stats")'
$ADB exec-out screencap -p > "$WORK/playing.png" && echo "     screenshot: $WORK/playing.png"

echo "--- 10: black"
js 'inv("video_live_action", { action: "black" })' >/dev/null
wait_for "black at one tap" '(async () => (await inv("video_output_status")).brightness <= -99)()' 5
js 'inv("video_live_action", { action: "black" })' >/dev/null
wait_for "black lifted" '(async () => (await inv("video_output_status")).brightness >= -1)()' 5

echo "--- 06: unplug and replug"
# Back inside the 20 s clip: past its end there is nothing to show.
js 'inv("seek_transport", { positionSeconds: 1 })' >/dev/null
sleep 2
$ADB shell settings delete global overlay_display_devices
wait_for "unplugged: displayLost, audio keeps running" "(async () => { const s = await inv(\"video_output_status\"); const t = await inv(\"get_transport_snapshot\"); return s.state.state === \"displayLost\" && t.playbackState === \"playing\"; })()" 10
$ADB shell settings put global overlay_display_devices 1280x720/213
wait_for "replugged: ready again by itself" "$(state_is ready)" 10
wait_for "replugged: picture resumes" '(async () => (await inv("video_output_status")).players.some(p => p.timePos != null))()' 15

echo "--- 06: background and back"
js 'inv("seek_transport", { positionSeconds: 1 })' >/dev/null
$ADB shell input keyevent HOME; sleep 4
show "in background" '(async () => (await inv("video_output_status")).state)()'
$ADB shell $FG >/dev/null
wait_for "back in the foreground: ready" "$(state_is ready)" 10

echo "--- 10: test pattern"
check "test pattern image installed and shown" '(async () => { try { await inv("video_test_pattern", { on: true }); await inv("video_test_pattern", { on: false }); return true; } catch (e) { return String(e); } })()'

js 'inv("pause_transport")' >/dev/null 2>&1
$ADB shell settings delete global overlay_display_devices >/dev/null
echo "--- result: $fails failure(s)"
