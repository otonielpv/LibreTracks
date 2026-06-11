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

export type DialogRequest = PromptRequest | ConfirmRequest;

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
