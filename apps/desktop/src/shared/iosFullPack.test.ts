import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const read = (relative: string) => readFileSync(resolve(repo, relative), "utf8");

// The iPhone build is assembled by two composite actions and checked by one
// script, so the contract lives there rather than in either workflow. The
// workflows only have to keep USING them — which is what the last test below
// guards: the moment one of them inlines its own engine build, the IPA that
// gets tested stops being the IPA that ships.
const smokeWorkflow = read(".github/workflows/ios-smoke.yml");
const releaseWorkflow = read(".github/workflows/ios-release.yml");
const nativeDeps = read(".github/actions/ios-native-deps/action.yml");
const xcodeProject = read(".github/actions/ios-xcode-project/action.yml");
const verifyScript = read("scripts/verify-ios-ipa.sh");
const iosConfig = read("apps/desktop/src-tauri/tauri.ios.conf.json");
const engineCmake = read("native/audio-engine-v2/CMakeLists.txt");
const rustLinker = read("crates/lt-audio-engine-v2/build.rs");

describe("iOS full-pack build contract", () => {
  it("builds the real Bungee and FFmpeg backends", () => {
    expect(nativeDeps).toContain("Build Bungee for iPhone");
    expect(nativeDeps).toContain("Build LGPL FFmpeg for iPhone");
    expect(nativeDeps).toContain("-DLT_ENGINE_USE_BUNGEE=ON");
    expect(nativeDeps).toContain("-DLT_ENGINE_USE_FFMPEG=ON");
    expect(nativeDeps).not.toContain("-DLT_ENGINE_USE_BUNGEE=OFF");
    expect(nativeDeps).not.toContain("-DLT_ENGINE_USE_FFMPEG=OFF");
  });

  it("links every static archive required by the iPhone executable", () => {
    expect(engineCmake).toContain('"${LT_BUNGEE_DIR}/ios-arm64"');
    for (const archive of [
      "libbungee.a",
      "libpffft.a",
      "libavformat.a",
      "libavcodec.a",
      "libswresample.a",
      "libavutil.a",
    ]) {
      expect(rustLinker).toContain(archive);
      expect(nativeDeps).toContain(archive);
    }
  });

  it("bundles the voice-guide bank instead of nulling iOS resources", () => {
    const config = JSON.parse(iosConfig) as {
      build: { beforeBuildCommand: string };
      bundle: { resources: Record<string, string> | null };
    };
    expect(config.build.beforeBuildCommand).toContain("build:remote");
    expect(config.bundle.resources).not.toBeNull();
    expect(config.bundle.resources?.["resources/voices"]).toBe("voices");
    for (const workflow of [smokeWorkflow, releaseWorkflow]) {
      expect(workflow).toContain("Build bundled remote frontend");
      expect(workflow).toContain("npm run build:remote");
    }
    expect(verifyScript).toContain("voices/es/counts/1.wav");
  });

  it("keeps JUCE out of the binary that can reach the App Store", () => {
    // Its AGPLv3 option is incompatible with store distribution, and on iOS it
    // only ever wrapped RemoteIO. A silent flip back to ON would build a
    // shippable-looking IPA that cannot legally ship.
    expect(nativeDeps).toContain("-DLT_ENGINE_USE_JUCE=OFF");
    expect(nativeDeps).toContain("LT_ENGINE_USE_JUCE:BOOL=OFF");
    expect(verifyScript).toContain("coreaudio-ios");
    expect(verifyScript).toContain('"error":"no-link"');
  });

  it("assembles and checks both IPAs the same way", () => {
    for (const workflow of [smokeWorkflow, releaseWorkflow]) {
      expect(workflow).toContain("uses: ./.github/actions/ios-native-deps");
      expect(workflow).toContain("uses: ./.github/actions/ios-xcode-project");
      expect(workflow).toContain("scripts/verify-ios-ipa.sh");
    }
    // Apple reads the privacy manifest from the bundle root and rejects the
    // upload without it (ITMS-91053); the icon step is what keeps the
    // cargo-mobile2 placeholder off real devices.
    expect(xcodeProject).toContain("ios-add-privacy-manifest.rb");
    expect(xcodeProject).toContain("ios-app-icon.mjs");
    expect(verifyScript).toContain("PrivacyInfo.xcprivacy");
  });

  it("signs the App Store build and refuses to upload a half-signed one", () => {
    expect(releaseWorkflow).toContain("--export-method app-store-connect");
    expect(releaseWorkflow).toContain("verify-ios-ipa.sh");
    expect(releaseWorkflow).toContain("--signed");
    expect(releaseWorkflow).toContain("altool --validate-app");
    // Partial credentials must fail the run: an IPA signed with half the set
    // only fails at upload, after the whole build has been paid for.
    expect(releaseWorkflow).toContain("IOS_CERTIFICATE is set but");
    expect(verifyScript).toContain("Authority=Apple Distribution");
    expect(verifyScript).toContain("get-task-allow");
  });
});
