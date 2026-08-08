// In-app prompt/confirm dialogs.
//
// Why: the desktop app runs in Tauri's WKWebView, where the browser's native
// window.prompt() (and, depending on the version, window.confirm()) is not
// wired up and silently returns null/false — so features built on them (rename
// song, create marker, edit BPM/time signature, ...) appeared to do nothing.
// These promise-based helpers drive a React modal (DialogHost) instead, which
// works identically on every macOS version.
//
// Usage (anywhere, including non-component modules):
//   const name = await promptDialog("New name", current);   // string | null
//   if (await confirmDialog("Delete this?")) { ... }         // boolean

type Resolver<T> = (value: T) => void;

interface PromptRequest {
  type: "prompt";
  message: string;
  defaultValue: string;
  resolve: Resolver<string | null>;
}

interface ConfirmRequest {
  type: "confirm";
  message: string;
  resolve: Resolver<boolean>;
}

interface AlertRequest {
  type: "alert";
  message: string;
  resolve: Resolver<void>;
}

export type DialogRequest = PromptRequest | ConfirmRequest | AlertRequest;

let host: ((request: DialogRequest) => void) | null = null;

// DialogHost registers itself here on mount. Only one host is expected.
export function registerDialogHost(handler: (request: DialogRequest) => void): () => void {
  host = handler;
  return () => {
    if (host === handler) {
      host = null;
    }
  };
}

export function promptDialog(message: string, defaultValue = ""): Promise<string | null> {
  return new Promise((resolve) => {
    if (!host) {
      // No host mounted (e.g. during early startup or tests) — behave like a
      // cancelled prompt rather than hang forever.
      resolve(null);
      return;
    }
    host({ type: "prompt", message, defaultValue: defaultValue ?? "", resolve });
  });
}

export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host) {
      resolve(false);
      return;
    }
    host({ type: "confirm", message, resolve });
  });
}

/// Single-button modal for failures the user MUST see. The status bar is easy
/// to miss (it can sit off-screen on a wide window), so a rejected drop that
/// only wrote there read as "nothing happened" — or worse, as a broken file,
/// because the only visible feedback was the clip's generic "Error al importar".
///
/// Resolves `true` when the user actually dismissed the dialog, and `false`
/// when there was no host to show it (early startup, tests). Callers that clean
/// up on dismissal must check: treating "never shown" as "acknowledged" would
/// silently discard the very state the message refers to.
export function alertDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host) {
      resolve(false);
      return;
    }
    host({ type: "alert", message, resolve: () => resolve(true) });
  });
}
