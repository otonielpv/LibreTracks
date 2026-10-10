import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  cancelAppClose,
  exitApp,
  isGuestMirrorMode,
  isMobileApp,
  isTauriApp,
  listenToAppCloseRequested,
  saveProject,
} from "../transport/desktopApi";
import { useSongStore } from "../transport/songStore";
import { registerAppCloseHandler } from "./appCloseService";

/** Cuanto se queda a la vista "Proyecto guardado" antes de cerrar solo. */
export const SAVED_NOTICE_MS = 1500;

type Phase =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; path: string | null }
  | { kind: "failed"; error: string };

// Cierre de la app, venga de la X de la ventana o de ARCHIVO > Salir: guarda la
// sesion, ENSEÑA que esta guardada y entonces cierra. En escritorio cerrar sin
// ver nada deja la duda de si el trabajo se ha perdido; esto la quita. Si el
// guardado falla no se cierra a ciegas: se pregunta.
export function AppCloseGuard() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const runningRef = useRef(false);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);

  const quit = useCallback(() => {
    void exitApp().catch(() => undefined);
  }, []);

  const requestClose = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;

    // A network-session guest shows the host's session, which the host saves:
    // there is nothing of this device's to save on the way out.
    if (!useSongStore.getState().song || isGuestMirrorMode()) {
      quit();
      return;
    }

    setPhase({ kind: "saving" });
    try {
      const snapshot = await saveProject();
      setPhase({ kind: "saved", path: snapshot.songFilePath ?? null });
    } catch (error) {
      setPhase({
        kind: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [quit]);

  useEffect(() => {
    if (!isTauriApp || isMobileApp) return;
    const unregister = registerAppCloseHandler(() => void requestClose());
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listenToAppCloseRequested(() => void requestClose())
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unregister();
      unlisten?.();
    };
  }, [requestClose]);

  useEffect(() => {
    if (phase.kind !== "saved") return;
    const timer = window.setTimeout(quit, SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [phase, quit]);

  useEffect(() => {
    if (phase.kind === "idle" || phase.kind === "saving") return;
    const id = window.requestAnimationFrame(() =>
      primaryButtonRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(id);
  }, [phase]);

  const stay = () => {
    runningRef.current = false;
    setPhase({ kind: "idle" });
    void cancelAppClose().catch(() => undefined);
  };

  if (phase.kind === "idle") {
    return null;
  }

  let title: string;
  let message: string;
  if (phase.kind === "saving") {
    title = t("appClose.savingTitle");
    message = t("appClose.savingMessage");
  } else if (phase.kind === "saved") {
    title = t("appClose.savedTitle");
    message = phase.path
      ? t("appClose.savedMessageAt", { path: phase.path })
      : t("appClose.savedMessage");
  } else {
    title = t("appClose.failedTitle");
    message = t("appClose.failedMessage", { error: phase.error });
  }

  return (
    <div role="presentation" className="lt-dialog-layer">
      <div
        role={phase.kind === "failed" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="lt-app-close-title"
        aria-describedby="lt-app-close-message"
        aria-busy={phase.kind === "saving"}
        className="lt-dialog-card"
        onKeyDown={(event) => {
          if (event.key === "Escape" && phase.kind === "failed") {
            event.stopPropagation();
            stay();
          }
        }}
      >
        <div className="lt-dialog-accent" aria-hidden="true" />
        <p className="lt-dialog-eyebrow">LibreTracks</p>
        <p id="lt-app-close-title" className="lt-dialog-message">
          <strong>{title}</strong>
        </p>
        <p
          id="lt-app-close-message"
          className="lt-dialog-message"
          style={{ whiteSpace: "pre-line", wordBreak: "break-word" }}
        >
          {message}
        </p>
        {phase.kind === "saved" ? (
          <div className="lt-dialog-actions">
            <button
              type="button"
              ref={primaryButtonRef}
              className="lt-dialog-button lt-dialog-button--primary"
              onClick={quit}
            >
              {t("appClose.closeNow")}
            </button>
          </div>
        ) : null}
        {phase.kind === "failed" ? (
          <div className="lt-dialog-actions">
            <button
              type="button"
              ref={primaryButtonRef}
              className="lt-dialog-button"
              onClick={stay}
            >
              {t("appClose.cancel")}
            </button>
            <button
              type="button"
              className="lt-dialog-button lt-dialog-button--primary"
              onClick={quit}
            >
              {t("appClose.closeWithoutSaving")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
