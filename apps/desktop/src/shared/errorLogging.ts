import { appendFrontendError } from "@libretracks/shared/desktopApi";

let installed = false;

/// Forward uncaught frontend errors and unhandled promise rejections to the
/// backend error log (logs/errors.log), so a user reporting a problem can send
/// us a single file that includes both Rust and JS failures. Best-effort and
/// idempotent — never throws.
export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;

  window.addEventListener("error", (event) => {
    const detail =
      event.error instanceof Error
        ? `${event.error.message}\n${event.error.stack ?? ""}`
        : event.message || "unknown error";
    const where = event.filename
      ? ` (${event.filename}:${event.lineno}:${event.colno})`
      : "";
    void appendFrontendError(`uncaught: ${detail}${where}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const detail =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? ""}`
        : String(reason);
    void appendFrontendError(`unhandledrejection: ${detail}`);
  });
}
