#!/usr/bin/env bash
# End-to-end MIDI scenario on an Android emulator (plan mobile-midi, pasos
# 03, 04, 08 y 10). Drives the real app through its Tauri commands over
# DevTools, using the debug-only "LT Loopback" device as the MIDI hardware;
# every check prints PASS/FAIL.
#
# Needs a DEBUG APK installed (the loopback and the WebView debugging only
# exist there) and Node 22+. WIPES the app's data (pm clear) on purpose, so
# every run starts from the same state: use a dedicated emulator.
#
#   ANDROID_HOME=... bash tests/android/midi-scenario/run.sh
export MSYS_NO_PATHCONV=1
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
ADB="${SDK:+$SDK/platform-tools/}adb"
HERE="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
CDP="$HERE/cdp.mjs"
TOGGLE=com.libretracks.app/com.libretracks.desktop.LtLoopbackToggleReceiver
FG='am start -n com.libretracks.app/com.libretracks.desktop.MainActivity'
fails=0
js() { node "$CDP" "$1"; }
check() { # label, js returning true/false
  local out; out=$(js "$2")
  if [ "$out" = "true" ]; then echo "PASS $1"; else echo "FAIL $1 -> $out"; fails=$((fails+1)); fi
}
# Sends note 60 (bound to toggle_metronome) and reports whether it toggled.
TOGGLES='(async () => { const m = async () => (await inv("get_settings")).metronomeEnabled; const b = await m(); try { await inv("send_midi_test_note", { channel: 1, note: 60 }); } catch (e) {} await new Promise(r => setTimeout(r, 2000)); return (await m()) !== b; })()'
NOT_TOGGLES="(async () => !(await ${TOGGLES}))()"
status() { js 'inv("get_midi_status")'; }
settings_patch() { js "(async () => { const s = await inv(\"get_settings\"); Object.assign(s, $1); await inv(\"update_audio_settings\", { settings: s }); await new Promise(r => setTimeout(r, 2500)); return true; })()" >/dev/null; }

$ADB shell am force-stop com.libretracks.app
$ADB shell pm clear com.libretracks.app >/dev/null
$ADB shell $FG >/dev/null
for i in $(seq 1 60); do $ADB shell cat /proc/net/unix 2>/dev/null | grep -q webview_devtools_remote && break; sleep 3; done
sleep 15

echo "--- 03: JNI bridge"
check "capabilities available + virtual + bluetooth" '(async () => { const c = await inv("get_midi_capabilities"); return c.available && c.virtualPorts && c.bluetoothPairing && !c.networkSession; })()'
check "LT Loopback listed both ways" '(async () => { const s = await inv("get_midi_status"); return s.inputs.includes("LT Loopback") && s.outputs.includes("LT Loopback"); })()'
settings_patch '{ selectedMidiDevice: "LT Loopback", selectedMidiOutputDevice: "LT Loopback", midiMappings: { "action:toggle_metronome": { status: 144, data1: 60, isCc: false } } }'
check "ports open" '(async () => { const s = await inv("get_midi_status"); return s.inputConnected && s.outputConnected; })()'
check "round trip: output -> loopback -> input -> MIDI Learn" "$TOGGLES"
check "round trip again (no stuck state)" "$TOGGLES"
check "unbound note does nothing" '(async () => { const m = async () => (await inv("get_settings")).metronomeEnabled; const b = await m(); await inv("send_midi_test_note", { channel: 1, note: 61 }); await new Promise(r => setTimeout(r, 2000)); return (await m()) === b; })()'
settings_patch '{ selectedMidiOutputDevice: null }'
check "no output selected: nothing arrives" "$NOT_TOGGLES"
settings_patch '{ selectedMidiOutputDevice: "LT Loopback" }'
check "output chosen again reopens (settings copy fix)" "$TOGGLES"

echo "--- 04: hot-plug"
$ADB shell am broadcast -n $TOGGLE --ez enabled false >/dev/null; sleep 3
check "unplugged: both ports waiting" '(async () => { const s = await inv("get_midi_status"); return s.inputWaiting && s.outputWaiting && !s.inputs.includes("LT Loopback"); })()'
check "unplugged: nothing arrives" "$NOT_TOGGLES"
$ADB shell am broadcast -n $TOGGLE --ez enabled true >/dev/null; sleep 4
check "replugged: both ports reconnected by themselves" '(async () => { const s = await inv("get_midi_status"); return s.inputConnected && s.outputConnected; })()'
check "replugged: round trip works without touching settings" "$TOGGLES"

echo "--- 10: virtual port"
settings_patch '{ midiVirtualPort: true }'
check "LibreTracks In/Out listed exactly once, own device filtered" '(async () => { const s = await inv("get_midi_status"); const n = (l, x) => l.filter(v => v === x).length; return n(s.inputs, "LibreTracks In") === 1 && n(s.outputs, "LibreTracks Out") === 1 && !s.inputs.includes("LibreTracks") && !s.outputs.includes("LibreTracks"); })()'
if $ADB shell dumpsys midi | grep -q LtVirtualMidiService; then echo "PASS system publishes the LibreTracks device"; else echo "FAIL system does not publish it"; fails=$((fails+1)); fi
check "loopback still works after the package re-registered its services" "$TOGGLES"
settings_patch '{ midiVirtualPort: false }'
if $ADB shell dumpsys midi | grep -q LtVirtualMidiService; then echo "FAIL device still published"; fails=$((fails+1)); else echo "PASS setting off: no LibreTracks device for other apps"; fi
check "LibreTracks In/Out gone from the lists" '(async () => { const s = await inv("get_midi_status"); return !s.inputs.includes("LibreTracks In") && !s.outputs.includes("LibreTracks Out"); })()'
check "loopback still works after turning it off" "$TOGGLES"

echo "--- 08: background"
$ADB shell input keyevent HOME; sleep 4
check "background, keep on (default): pedal still works" "$TOGGLES"
$ADB shell $FG >/dev/null; sleep 5
check "foreground: still works" "$TOGGLES"
settings_patch '{ keepMidiInBackground: false }'
$ADB shell input keyevent HOME; sleep 4
check "background, keep off: input closed, no badge" '(async () => { const s = await inv("get_midi_status"); return !s.inputConnected && !s.inputWaiting; })()'
check "background, keep off: pedal ignored" "$NOT_TOGGLES"
$ADB shell $FG >/dev/null; sleep 5
check "back in the foreground: input reopened" '(async () => { const s = await inv("get_midi_status"); return s.inputConnected && s.outputConnected; })()'
check "back in the foreground: round trip works" "$TOGGLES"

echo "--- result: $fails failure(s)"
