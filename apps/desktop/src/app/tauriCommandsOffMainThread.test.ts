import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Guardarraíl: ningún comando de Tauri puede volver al hilo principal.
 *
 * Tauri ejecuta un `#[tauri::command]` normal *inline en el handler de IPC*, es
 * decir, en el hilo principal: el bucle GTK que además dibuja WebKitGTK en
 * Linux, y el que gobierna la ventana anfitriona de WebView2 en Windows. Casi
 * todos nuestros comandos toman el lock de sesión, escriben a disco o bajan al
 * FFI del motor, donde un seek llega a bloquear 750ms esperando a que el audio
 * de destino esté en RAM. Inline, eso es la ventana congelada durante todo ese
 * rato — el síntoma que se reportó como "doy varios clics para saltar y la UI
 * se congela y después continúa".
 *
 * `#[tauri::command(async)]` sobre un `fn` síncrono (o un `async fn` sin más)
 * mueve el mismo cuerpo al threadpool y no cambia nada más.
 *
 * ## Si este test falla
 *
 * Marca el comando nuevo como `#[tauri::command(async)]`. Sólo se añade a
 * EXCEPTIONS lo que de verdad necesita el hilo principal: abrir un diálogo
 * modal nativo (rfd) o pilotar el gestor de archivos del sistema. Y si un
 * comando así hace trabajo pesado DESPUÉS del diálogo, ese trabajo va a un hilo
 * (`spawn_project_work`), no al hilo principal.
 *
 * Ojo con los comandos que la UI envía en ráfaga (arrastre de un fader, de un
 * clip, un seek): al ser `(async)` pueden solaparse y aplicarse desordenados.
 * Sus llamadores los serializan en JS — ver
 * `src/features/transport/latestWinsStream.ts`.
 */
const COMMANDS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src-tauri/src/commands",
);

/** Comandos que SÍ deben quedarse en el hilo principal, y por qué. */
const EXCEPTIONS: Record<string, string> = {
  // Abren un diálogo modal nativo (rfd) y delegan el trabajo pesado a
  // spawn_project_work, así que el threadpool no les aportaría nada.
  start_pick_and_import_song_from_dialog: "rfd dialog",
  pick_and_import_external_project_into_session_from_dialog: "rfd dialog",
  start_create_song: "rfd dialog",
  start_save_session_as_template: "rfd dialog",
  start_create_song_from_template_path: "rfd dialog",
  start_create_song_from_template_file: "rfd dialog",
  start_save_project_as: "rfd dialog",
  open_project_from_dialog: "rfd dialog",
  pick_library_files: "rfd dialog",
  start_import_library_assets_from_dialog: "rfd dialog",
  export_session_package: "rfd dialog",
  // Lanza el gestor de archivos del sistema, que en macOS es API de hilo
  // principal.
  reveal_error_log: "OS file manager",
};

type Command = { file: string; name: string; offMainThread: boolean };

function parseCommands(file: string): Command[] {
  const lines = readFileSync(join(COMMANDS_DIR, file), "utf8").split("\n");
  const commands: Command[] = [];

  lines.forEach((line, index) => {
    const attribute = line.trim();
    if (!attribute.startsWith("#[tauri::command")) return;

    // The signature is a line or two below the attribute (other attributes and
    // `#[cfg(...)]` can sit in between).
    for (let i = index + 1; i < Math.min(index + 8, lines.length); i += 1) {
      const match = /\b(?:pub\s+)?(async\s+)?fn\s+(\w+)/.exec(lines[i]);
      if (!match) continue;
      commands.push({
        file,
        name: match[2],
        // Either spelling takes the command off the main thread: the attribute
        // argument, or the fn being async in the first place.
        offMainThread:
          attribute === "#[tauri::command(async)]" || Boolean(match[1]),
      });
      return;
    }
  });

  return commands;
}

describe("Tauri commands stay off the main thread", () => {
  const commands = readdirSync(COMMANDS_DIR)
    .filter((file) => file.endsWith(".rs"))
    .flatMap(parseCommands);

  it("finds the command surface (guards against the parser silently matching nothing)", () => {
    expect(commands.length).toBeGreaterThan(150);
  });

  it("has no command running inline on the main thread outside the exceptions", () => {
    const onMainThread = commands
      .filter((command) => !command.offMainThread)
      .filter((command) => !(command.name in EXCEPTIONS))
      .map((command) => `${command.file}::${command.name}`);

    expect(onMainThread).toEqual([]);
  });

  it("keeps the exception list honest — every entry still exists and is inline", () => {
    const inlineNames = new Set(
      commands.filter((c) => !c.offMainThread).map((c) => c.name),
    );
    const stale = Object.keys(EXCEPTIONS).filter(
      (name) => !inlineNames.has(name),
    );

    expect(stale).toEqual([]);
  });
});
