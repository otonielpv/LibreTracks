import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Source-level guard for the Android output-device list.
 *
 * ## What broke
 *
 * A tester plugged a USB audio interface into their phone and LibreTracks
 * never offered it, while other Android DAWs did. The JNI enumeration was not
 * missing — `platform/android_audio_devices.rs` reads
 * `AudioManager.getDevices()` correctly, and has since the Android port. What
 * was missing is that it was only merged in `engine_v2_list_devices`, a Tauri
 * command the frontend never invokes. The two paths that decide what the user
 * actually gets — the Settings dropdown (`AudioController::list_devices`, via
 * `get_audio_output_devices`) and the "is my saved device still there?" probe
 * in `apply_settings` — asked the engine alone.
 *
 * On Android the engine alone is the Oboe backend, and it only knows the
 * AAudio *default route*: one virtual "system output" entry, never the
 * concrete endpoints. So the interface was invisible in Settings, and a saved
 * selection pointing at one was treated as gone and wiped on every launch.
 *
 * ## Why the check is textual
 *
 * The real path needs a live engine on a phone with hardware plugged in, so
 * there is nothing to unit-test in-process. And `#[cfg(target_os = "android")]`
 * code is compiled by nothing in desktop CI, so even a Rust test would not
 * cover the interesting half. What CAN be checked cheaply is the invariant
 * that broke: every engine enumeration merges the platform endpoints.
 *
 * ## If this test fails
 *
 * You added (or restored) a call to the engine's device list. Follow it with
 * `crate::platform::append_platform_output_devices(&mut devices)` and bump
 * EXPECTED_CALL_SITES. Skipping the merge is only correct if the list is never
 * shown to the user and never compared against a saved selection.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const tauriSrc = resolve(testDir, "../../../../src-tauri/src");

/** Rust files that enumerate output devices through the engine. */
const SOURCES = ["audio/engine.rs", "commands/engine_v2.rs"];

/** Lines allowed between the enumeration and its merge. */
const WINDOW_LINES = 12;

/**
 * Pinned so a rename can't turn this guard into a test that scans nothing and
 * passes. Settings list + saved-device probe + the engine_v2 command.
 */
const EXPECTED_CALL_SITES = 3;

describe("android output-device enumeration", () => {
  it("merges the platform endpoints at every engine device listing", () => {
    const offenders: string[] = [];
    let callSites = 0;

    for (const relative of SOURCES) {
      const lines = readFileSync(resolve(tauriSrc, relative), "utf8").split(
        /\r?\n/,
      );

      lines.forEach((line, index) => {
        // These names appear in prose all over the file; only calls count.
        if (line.trimStart().startsWith("//")) return;
        if (
          !line.includes(".list_devices()") &&
          !line.includes(".list_devices_ext(")
        ) {
          return;
        }

        callSites += 1;
        const merged = lines
          .slice(index, index + WINDOW_LINES)
          .some((candidate) =>
            candidate.includes("append_platform_output_devices"),
          );
        if (!merged) {
          offenders.push(`${relative}:${index + 1} — ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      "engine device list built without platform::append_platform_output_devices; " +
        "on Android that list is ONLY the AAudio default route, so a plugged-in " +
        "USB audio interface would be invisible there",
    ).toEqual([]);
    expect(callSites).toBe(EXPECTED_CALL_SITES);
  });
});
