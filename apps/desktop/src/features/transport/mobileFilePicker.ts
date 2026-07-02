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
