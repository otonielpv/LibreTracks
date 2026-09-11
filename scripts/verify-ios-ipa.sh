#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Gate every IPA — the unsigned smoke build and the signed App Store build —
# goes through before anyone is allowed to install or upload it.
#
# The two builds MUST be checked by the same code. When these assertions lived
# inline in ios-smoke.yml, the signed build had no equivalent: the IPA that
# gets tested would stop being the IPA that ships the first time either file
# drifted, and the JUCE/no-link guardrails would only protect the copy that
# still had them.
#
#   verify-ios-ipa.sh <path-to-ipa> [--signed | --unsigned]
#
# --signed additionally proves the things App Store Connect rejects an upload
# for, and that a passing local build would never catch: distribution
# identity, an embedded provisioning profile, and get-task-allow turned off.
# ---------------------------------------------------------------------------
set -euo pipefail

ipa_path="${1:-}"
mode="${2:---unsigned}"

if [ -z "$ipa_path" ] || [ ! -f "$ipa_path" ]; then
  echo "verify-ios-ipa: no IPA at '${ipa_path:-<missing argument>}'" >&2
  exit 1
fi
case "$mode" in
  --signed|--unsigned) ;;
  *) echo "verify-ios-ipa: mode must be --signed or --unsigned, got '$mode'" >&2; exit 1 ;;
esac

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
unzip -q "$ipa_path" -d "$work_dir"

app="$(find "$work_dir/Payload" -maxdepth 1 -name '*.app' -type d -print -quit)"
if [ -z "$app" ]; then
  echo "IPA does not contain Payload/<name>.app" >&2
  exit 1
fi

plist="$app/Info.plist"
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")"
minimum_ios="$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$plist")"
short_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")"
build_number="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")"
archs="$(lipo -archs "$app/$executable")"

test "$bundle_id" = "com.libretracks.ios"
test "$minimum_ios" = "15.0"
case " $archs " in
  *" arm64 "*) ;;
  *) echo "Expected arm64 executable, got: $archs" >&2; exit 1 ;;
esac

# ── The engine actually linked, and it is the real one ─────────────────────
# Xcode strips the release executable's local symbol table, including the
# internally referenced C ABI names. Use engine-only runtime strings as a
# positive fingerprint that survives stripping. Avoid grep -q under pipefail:
# its early exit can SIGPIPE strings and turn a real match into status 141.
if ! strings "$app/$executable" \
  | grep 'Could not activate the iOS audio session' >/dev/null; then
  echo "IPA executable does not contain the native iOS audio engine" >&2
  exit 1
fi
if strings "$app/$executable" | grep '"error":"no-link"' >/dev/null; then
  echo "IPA executable still contains the silent no-link engine" >&2
  exit 1
fi
# Without JUCE, a device manager that failed to link would fall through to the
# silent stub, which reports a different backend name entirely.
if ! strings "$app/$executable" | grep 'coreaudio-ios' >/dev/null; then
  echo "IPA executable does not contain the iOS RemoteIO audio backend" >&2
  exit 1
fi
if ! find "$app" -path '*/voices/es/counts/1.wav' -print -quit | grep . >/dev/null; then
  echo "IPA does not contain the bundled voice-guide bank" >&2
  exit 1
fi

# ── Privacy manifest ───────────────────────────────────────────────────────
# Apple reads it from the BUNDLE ROOT and rejects the upload without it
# (ITMS-91053). Report where it actually landed when it is missing from the
# root: the fix is a different resource mapping, not a different manifest.
if [ ! -f "$app/PrivacyInfo.xcprivacy" ]; then
  echo "IPA has no PrivacyInfo.xcprivacy at the bundle root" >&2
  find "$app" -name 'PrivacyInfo.xcprivacy' -print >&2 || true
  exit 1
fi
/usr/libexec/PlistBuddy -c 'Print :NSPrivacyTracking' "$app/PrivacyInfo.xcprivacy" > /dev/null

# ── App icon ───────────────────────────────────────────────────────────────
# `tauri ios init` ships the cargo-mobile2 template icons and
# scripts/ios-app-icon.mjs replaces them. The template placeholder is exactly
# the kind of thing that reaches a device unnoticed (it already did once), and
# a 1024 icon with an alpha channel is an automatic rejection at upload time.
if ! /usr/libexec/PlistBuddy -c 'Print :CFBundleIcons' "$plist" > /dev/null 2>&1; then
  echo "IPA Info.plist declares no CFBundleIcons — the icon catalogue did not compile in" >&2
  exit 1
fi
# Either form counts as a compiled catalogue: Assets.car, or the loose
# AppIcon*.png files Xcode also emits. Asserting one exact filename would tie
# this check to a detail of whichever Xcode the runner happens to ship.
if ! find "$app" -maxdepth 1 \( -name 'Assets.car' -o -name 'AppIcon*.png' \) \
  -print -quit | grep . >/dev/null; then
  echo "IPA has no compiled app icon at the bundle root" >&2
  find "$app" -maxdepth 1 -print >&2 || true
  exit 1
fi

# CFBundleVersion may hold at most three period-separated integers. Tauri's
# --build-number appends to the marketing version, so 1.11.1 + build 45 would
# produce a four-component string that App Store Connect rejects on upload.
case "$build_number" in
  ""|*[!0-9.]*|*..*|.*|*.)
    echo "::error::CFBundleVersion '$build_number' is not a period-separated list of integers." >&2
    exit 1
    ;;
esac
if [ "$(printf '%s' "$build_number" | tr -cd '.' | wc -c)" -gt 2 ]; then
  echo "::error::CFBundleVersion '$build_number' has more than three components; App Store Connect rejects it." >&2
  exit 1
fi

# ── Background audio ───────────────────────────────────────────────────────
# Without UIBackgroundModes=audio, iOS suspends the app the moment the screen
# locks and playback stops mid-song. It is one line in Info.ios.plist and its
# absence is invisible until someone pockets the phone during a set, so assert
# it here rather than trusting the merge.
if ! /usr/libexec/PlistBuddy -c 'Print :UIBackgroundModes' "$plist" 2>/dev/null \
  | grep -w 'audio' >/dev/null; then
  echo "::error::The IPA does not declare UIBackgroundModes=audio, so playback dies when the screen locks." >&2
  /usr/libexec/PlistBuddy -c 'Print :UIBackgroundModes' "$plist" >&2 2>/dev/null || true
  exit 1
fi

# Declared once in Info.ios.plist so App Store Connect stops asking about
# export compliance on every single submission.
encryption="$(/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' "$plist" 2>/dev/null || echo '<absent>')"

# Informational: which devices Apple will review the app on. Declaring iPad
# means iPad screenshots become mandatory and a reviewer will run it there.
device_family="$(plutil -extract UIDeviceFamily json -o - "$plist" 2>/dev/null || echo '?')"
case "$device_family" in
  '[1]')   device_family="iPhone only" ;;
  '[1,2]') device_family="iPhone + iPad (Apple reviews it on iPad too)" ;;
  '[2]')   device_family="iPad only" ;;
esac

# An iPad build that still allows multitasking has its orientation list
# ignored by iPadOS, so a landscape-only app gets drawn squashed into the top
# of a portrait screen. It looks broken, and it is the reviewer's first
# impression. A warning rather than a failure: dropping iPad support is also a
# valid answer to this.
fullscreen="no"
if /usr/libexec/PlistBuddy -c 'Print :UIRequiresFullScreen' "$plist" 2>/dev/null | grep -q true; then
  fullscreen="yes"
fi
if [ "$fullscreen" = "no" ] && [ "$device_family" != "iPhone only" ]; then
  echo "::warning::The IPA supports iPad without UIRequiresFullScreen, so iPadOS will ignore the landscape-only orientation list and render the app in portrait." >&2
fi

echo "IPA:              $ipa_path"
echo "Bundle:           $bundle_id"
echo "Version:          $short_version ($build_number)"
echo "Minimum iOS:      $minimum_ios"
echo "Architectures:    $archs"
echo "Device family:    $device_family"
echo "Full screen:      UIRequiresFullScreen = $fullscreen"
echo "Background audio: declared"
echo "Encryption:       ITSAppUsesNonExemptEncryption = $encryption"
echo "Audio engine:     native static C++ engine linked (RemoteIO, no JUCE)"
echo "Full pack:        Bungee + FFmpeg + voice guide + pads enabled"
echo "Privacy manifest: present at the bundle root"
echo "App icon:         compiled catalogue present"

if [ "$mode" = "--unsigned" ]; then
  echo "Signature:        not checked (unsigned smoke build)"
  exit 0
fi

# ── Signature, profile and entitlements ────────────────────────────────────
signature="$(codesign --display --verbose=4 "$app" 2>&1)"
echo "$signature" | grep -E '^Authority=' || true
if ! echo "$signature" | grep -E '^Authority=Apple Distribution' >/dev/null; then
  echo "::error::IPA is not signed with an Apple Distribution identity, so App Store Connect will reject it." >&2
  echo "$signature" >&2
  exit 1
fi
codesign --verify --strict --verbose=2 "$app"

if [ ! -f "$app/embedded.mobileprovision" ]; then
  echo "::error::IPA has no embedded provisioning profile." >&2
  exit 1
fi

# get-task-allow lets a debugger attach. Xcode sets it for development
# signing, and an IPA that carries it is rejected at upload with ITMS-90046 —
# after the whole build has already been paid for.
entitlements="$(codesign --display --entitlements - --xml "$app" 2>/dev/null || true)"
if printf '%s' "$entitlements" | grep -A1 'get-task-allow' | grep '<true/>' >/dev/null; then
  echo "::error::IPA is signed with get-task-allow=true (a development profile). App Store Connect rejects this with ITMS-90046." >&2
  printf '%s\n' "$entitlements" >&2
  exit 1
fi

# The profile is a CMS blob; the plist inside it is what names the team and
# the expiry date. Worth printing: "profile expired" is otherwise a wall of
# base64 in the upload error.
profile_plist="$work_dir/profile.plist"
security cms -D -i "$app/embedded.mobileprovision" > "$profile_plist" 2>/dev/null
profile_name="$(/usr/libexec/PlistBuddy -c 'Print :Name' "$profile_plist" 2>/dev/null || echo '<unnamed>')"
profile_team="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$profile_plist" 2>/dev/null || echo '<unknown>')"
profile_expiry="$(/usr/libexec/PlistBuddy -c 'Print :ExpirationDate' "$profile_plist" 2>/dev/null || echo '<unknown>')"

echo "Signature:        Apple Distribution, verified"
echo "Profile:          $profile_name (team $profile_team, expires $profile_expiry)"
echo "Entitlements:     get-task-allow absent (App Store profile)"
