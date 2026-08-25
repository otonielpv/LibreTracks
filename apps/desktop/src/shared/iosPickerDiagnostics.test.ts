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
const projectCommands = readFileSync(
  resolve(tauriDir, "src/commands/project.rs"),
  "utf8",
);
const pickerBridge = readFileSync(
  resolve(tauriDir, "plugins/ios-folder-picker/src/lib.rs"),
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

  it("no bloquea el hilo principal mientras Swift espera al usuario", () => {
    expect(projectCommands).toContain("pub async fn pick_session_folder");
    expect(projectCommands).toContain("pub async fn start_open_project_from_dialog");
    expect(projectCommands).toContain(
      "pub async fn start_import_session_package_from_dialog",
    );
    expect(pickerBridge).toContain("spawn_blocking");
    expect(pickerBridge).toContain("run_mobile_plugin");
  });

  it("importa .ltset con un selector de documento nativo en iOS", () => {
    expect(swift).toContain("@objc public func pickFile");
    expect(swift).toContain("forOpeningContentTypes: [.data]");
    expect(pickerBridge).toContain('run_mobile_plugin::<PickFileResponse>("pickFile"');
    expect(projectCommands).toContain(
      "libretracks_ios_folder_picker::pick_file(app.clone()).await?",
    );
    expect(projectCommands).toContain(
      "libretracks_ios_folder_picker::pick_folder(app.clone()).await?",
    );
  });
});
