import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const workflow = readFileSync(
  resolve(repo, ".github/workflows/ios-smoke.yml"),
  "utf8",
);
const iosConfig = readFileSync(
  resolve(repo, "apps/desktop/src-tauri/tauri.ios.conf.json"),
  "utf8",
);
const engineCmake = readFileSync(
  resolve(repo, "native/audio-engine-v2/CMakeLists.txt"),
  "utf8",
);
const rustLinker = readFileSync(
  resolve(repo, "crates/lt-audio-engine-v2/build.rs"),
  "utf8",
);

describe("iOS full-pack build contract", () => {
  it("builds the real Bungee and FFmpeg backends", () => {
    expect(workflow).toContain("Build Bungee for iPhone");
    expect(workflow).toContain("Build LGPL FFmpeg for iPhone");
    expect(workflow).toContain("-DLT_ENGINE_USE_BUNGEE=ON");
    expect(workflow).toContain("-DLT_ENGINE_USE_FFMPEG=ON");
    expect(workflow).not.toContain("-DLT_ENGINE_USE_BUNGEE=OFF");
    expect(workflow).not.toContain("-DLT_ENGINE_USE_FFMPEG=OFF");
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
      expect(workflow).toContain(archive);
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
    expect(workflow).toContain("voices/es/counts/1.wav");
  });
});
