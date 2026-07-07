/**
 * File picking via the WebView's own `<input type="file">` chooser.
 *
 * On Android the native desktop dialogs (`rfd`) don't exist, but the system
 * document picker is reachable through the WebView input element and hands us
 * the file CONTENTS (not a filesystem path — Android files live behind
 * content:// URIs the Rust side can't read). The bytes go through the same
 * `import_audio_files_from_bytes` pipeline the web drag-drop flow already
 * uses, which copies them into the session's audio/ folder.
 */
// Slice size for staging picked files to the Rust side. Small enough that
// the WebView's JS heap never holds more than one slice per file (low-RAM
// phones OOM-killed the renderer when whole songs were read into a single
// Uint8Array), large enough that a 26 MB multitrack WAV stages in ~13
// round-trips.
const STAGE_CHUNK_BYTES = 2 * 1024 * 1024;

// Base64-encode a slice via the browser's native encoder (FileReader data
// URL). Chunk-safe: no giant call-stack String.fromCharCode tricks.
function sliceToBase64(slice: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : "");
    };
    reader.readAsDataURL(slice);
  });
}

/**
 * Stream a picked File to the backend in base64 slices and resolve with the
 * staged temp-file path, which then goes through the same paths-based import
 * pipeline as desktop dialogs. Base64-in-args rather than a raw invoke body
 * because Android's WebView can't hand POST bodies to the intercepted custom
 * scheme — Tauri IPC falls back to the string bridge there.
 */
export async function stageFileForImport(
  file: File,
  isFirstOfBatch: boolean,
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const fileId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `staged-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  let stagedPath: string | null = null;
  let offset = 0;
  try {
    do {
      const end = Math.min(offset + STAGE_CHUNK_BYTES, file.size);
      const chunkBase64 = await sliceToBase64(file.slice(offset, end));
      stagedPath = await invoke<string | null>("stage_imported_audio_chunk", {
        fileId,
        fileName: file.name,
        chunkBase64,
        isLast: end >= file.size,
        batchReset: isFirstOfBatch && offset === 0,
      });
      offset = end;
    } while (offset < file.size);
  } catch (error) {
    // This invoke bypasses the shared invokeCommand logger; capture the
    // failure in the error log ourselves or staging errors are invisible.
    void invoke("append_frontend_error", {
      message: `stage_imported_audio_chunk("${file.name}", ${file.size}B @${offset}): ${String(error)}`,
    }).catch(() => {});
    throw error;
  }

  if (!stagedPath) {
    throw new Error(`No se pudo preparar "${file.name}" para importar`);
  }
  return stagedPath;
}

export function pickFilesViaWebView(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const settle = (files: File[]) => {
      if (settled) {
        return;
      }
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener("change", () => {
      settle(Array.from(input.files ?? []));
    });
    // Fired by Chromium (and the Android WebView) when the chooser is
    // dismissed without picking anything.
    input.addEventListener("cancel", () => {
      settle([]);
    });

    input.click();
  });
}
