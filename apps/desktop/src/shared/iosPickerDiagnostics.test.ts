import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(here, "../../src-tauri");
const swift = readFileSync(
  resolve(
    tauriDir,
    "plugins/ios-folder-picker/ios/Sources/IosFolderPickerPlugin.swift",
  ),
  "utf8",
);
const plist = readFileSync(resolve(tauriDir, "Info.ios.plist"), "utf8");
const systemCommands = readFileSync(
  resolve(tauriDir, "src/commands/system.rs"),
  "utf8",
);

describe("diagnóstico del selector de carpetas iOS", () => {
  it("expone Documents en Archivos para recuperar el registro", () => {
    expect(plist).toContain("UIFileSharingEnabled");
    expect(plist).toContain("LSSupportsOpeningDocumentsInPlace");
    expect(plist.match(/<true\/>/g)).toHaveLength(2);
  });

  it("Rust y Swift escriben el mismo archivo sin registrar rutas elegidas", () => {
    expect(systemCommands).toContain('"LibreTracks-picker.log"');
    expect(swift).toContain('appendingPathComponent("LibreTracks-picker.log")');
    expect(swift).not.toContain('diagnostic("selected: \\(url.path)');
  });

  it("registra la resolución y presentación del controlador UIKit", () => {
    expect(swift).toContain("resolving presenter");
    expect(swift).toContain("presenting picker from");
    expect(swift).toContain("presentation completion");
    expect(swift).toContain("pickerWindowAttached");
  });
});
