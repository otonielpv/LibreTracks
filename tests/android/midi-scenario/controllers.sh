#!/usr/bin/env bash
# MIDI controller scenario on an Android emulator (plan midi-controllers):
# MIDI Map mode driven by TAPPING the phone UI, learning a track's mute from
# the loopback, the mute then following the hardware without a disk write,
# and a strip binding resolving against the bank.
#
# Same requirements as run.sh: a DEBUG APK (loopback + WebView debugging),
# Node 22+, a dedicated emulator (pm clear wipes the app's data).
#
#   ANDROID_HOME=... bash tests/android/midi-scenario/controllers.sh
export MSYS_NO_PATHCONV=1
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
ADB="${SDK:+$SDK/platform-tools/}adb"
HERE="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
CDP="$HERE/cdp.mjs"
FG='am start -n com.libretracks.app/com.libretracks.desktop.MainActivity'
SHOTS="${SHOTS:-$HERE/shots}"
fails=0
js() { node "$CDP" "$1"; }
check() { # label, js returning true/false
  local out; out=$(js "$2")
  if [ "$out" = "true" ]; then echo "PASS $1"; else echo "FAIL $1 -> $out"; fails=$((fails+1)); fi
}
wait_ui() { sleep "${1:-2}"; }
shot() { mkdir -p "$SHOTS"; $ADB exec-out screencap -p > "$SHOTS/$1.png"; echo "shot $SHOTS/$1.png"; }
# Taps an element by CSS selector through a real click (React handlers run).
tap() { js "(async () => { const el = document.querySelector('$1'); if (!el) return 'missing $1'; el.click(); return true; })()"; }
track_id() { js "(async () => (await inv('get_song_view', { includeWaveforms: false })).tracks.find(t => t.name === '$1').id)()" | tr -d '"'; }
muted() { js "(async () => (await inv('get_song_view', { includeWaveforms: false })).tracks.find(t => t.name === '$1').muted)()"; }
note() { js "(async () => { await inv('send_midi_test_note', { channel: 1, note: $1 }); await new Promise(r => setTimeout(r, 1200)); return true; })()" >/dev/null; }

$ADB shell am force-stop com.libretracks.app
$ADB shell pm clear com.libretracks.app >/dev/null
$ADB shell $FG >/dev/null
for i in $(seq 1 60); do $ADB shell cat /proc/net/unix 2>/dev/null | grep -q webview_devtools_remote && break; sleep 3; done
sleep 15

echo "--- setup: a song with two tracks, the loopback as controller"
js '(async () => {
  await inv("start_create_song_named_at", { name: "MIDI Map " + Date.now(), parentDir: null });
  for (let i = 0; i < 60 && !(await inv("get_song_view", { includeWaveforms: false })); i += 1) {
    await new Promise((r) => setTimeout(r, 500));
  }
  await inv("create_track", { name: "Bajo", kind: "audio", insertAfterTrackId: null, parentTrackId: null });
  await inv("create_track", { name: "Teclas", kind: "audio", insertAfterTrackId: null, parentTrackId: null });
  const s = await inv("get_settings");
  Object.assign(s, { selectedMidiDevice: "LT Loopback", selectedMidiOutputDevice: "LT Loopback", midiMappings: {} });
  await inv("update_audio_settings", { settings: s });
  await inv("save_settings", { settings: s });
  location.reload();
  return true;
})()' >/dev/null
sleep 12
# First-run screens (privacy consent, tours menu) would cover the shots.
js '(async () => {
  document.querySelector(".lt-telemetry-actions .lt-secondary-button")?.click();
  await new Promise((r) => setTimeout(r, 800));
  for (let i = 0; i < 3; i += 1) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  }
  return true;
})()' >/dev/null
wait_ui
shot 00-first-run-dismissed
BASS=$(track_id Bajo)
echo "Bajo = $BASS"
check "song has the two tracks" '(async () => (await inv("get_song_view", { includeWaveforms: false })).tracks.length === 2)()'

echo "--- MIDI Map mode by touch: Settings > MIDI Learn > button"
tap '[data-lt-tour="side-nav-settings"]' >/dev/null; wait_ui
tap '#lt-settings-tab-midiLearn' >/dev/null; wait_ui
shot 01-midi-learn-tab
tap '.lt-midi-learn-activate' >/dev/null; wait_ui
check "settings closed and the banner shows the way out" '(async () => !!document.querySelector(".lt-midi-map-banner") && !document.querySelector("#lt-settings-tab-midiLearn"))()'
check "the M/S of the tracks are tinted and still visible" '(async () => {
  const mutes = [...document.querySelectorAll(".lt-track-toggle-mute, .lt-compact-mixer-toggle.is-mute")];
  if (mutes.length === 0) return "no mute buttons";
  return mutes.every((b) => { const r = b.getBoundingClientRect(); return r.width > 4 && r.height > 4 && !!b.querySelector(".lt-midi-mappable-layer"); });
})()'
shot 02-map-mode
js "(async () => { const b = document.querySelector('.lt-track-toggle-mute, .lt-compact-mixer-toggle.is-mute'); b.click(); return true; })()" >/dev/null
wait_ui 1
check "tapping M armed the learn without muting" "(async () => document.querySelector('.lt-midi-map-banner')?.textContent.length > 0)()"
shot 03-armed
note 60
check "the note became track:<id>:mute" "(async () => { const m = (await inv('get_settings')).midiMappings; const k = Object.keys(m).find(k => k.startsWith('track:') && k.endsWith(':mute')); return !!k && m[k].status === 144 && m[k].data1 === 60; })()"
check "the learn left map mode" '(async () => !document.querySelector(".lt-midi-map-banner"))()'
shot 04-learned
MUTED_KEY_TRACK=$(js "(async () => { const m = (await inv('get_settings')).midiMappings; return Object.keys(m).find(k => k.startsWith('track:')).split(':')[1]; })()" | tr -d '"')
NAME=$(js "(async () => (await inv('get_song_view', { includeWaveforms: false })).tracks.find(t => t.id === '$MUTED_KEY_TRACK').name)()" | tr -d '"')
echo "learned on: $NAME"

echo "--- the hardware drives the mute, off the disk"
BEFORE=$(js 'inv("get_midi_control_diagnostics")')
note 60
check "first press mutes $NAME" "(async () => (await inv('get_song_view', { includeWaveforms: false })).tracks.find(t => t.name === '$NAME').muted === true)()"
check "the on-screen M follows" "(async () => [...document.querySelectorAll('.lt-track-toggle-mute.is-active, .lt-compact-mixer-toggle.is-mute.is-on')].length === 1)()"
shot 05-muted-from-hardware
note 60
check "second press unmutes" "(async () => (await inv('get_song_view', { includeWaveforms: false })).tracks.find(t => t.name === '$NAME').muted === false)()"
AFTER=$(js 'inv("get_midi_control_diagnostics")')
echo "diagnostics before: $BEFORE"
echo "diagnostics after:  $AFTER"
check "two presses: no disk write, one commit each" "(async () => { const b = $BEFORE, a = $AFTER; return a.settingsDiskWrites === b.settingsDiskWrites && a.trackCommits - b.trackCommits === 2; })()"

echo "--- strips: strip:2:solo resolves against the bank"
js '(async () => { const s = await inv("get_settings"); s.midiMappings["strip:2:solo"] = { status: 144, data1: 62, isCc: false }; await inv("update_audio_settings", { settings: s }); await inv("save_settings", { settings: s }); return true; })()' >/dev/null
sleep 2
note 62
check "strip 2 soloed the second track of the bank" '(async () => { const v = await inv("get_song_view", { includeWaveforms: false }); const b = await inv("get_midi_bank"); return b.trackIds.length === 2 && v.tracks.find(t => t.id === b.trackIds[1]).solo === true; })()'
check "the bank indicator rings the two tracks" '(async () => document.querySelectorAll(".is-midi-bank").length >= 2)()'
shot 06-strip-solo

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; fi
exit "$fails"
