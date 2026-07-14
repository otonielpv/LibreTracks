import { useState } from "react";
import { useTranslation } from "react-i18next";

import { pickSessionFolder } from "../desktopApi";

type MobileLandingProps = {
  /** Create the session under `parentDir` (a folder the user picked) — the
   * caller places it in the default folder when `parentDir` is omitted. */
  onCreateSession: (name: string, parentDir?: string) => void;
  /** Browse for a .ltsession anywhere on the device via the system picker
   * (which remembers the app's last folder) — the desktop "Open" flow. */
  onOpenSessionFromPicker?: () => void;
  /** Import a whole `.ltset` as a new session via the system file picker.
   * Optional so the embedded "Sesiones…" modal can omit it. */
  onImportSession?: () => void;
  /** Render just the card (no full-stage backdrop) — used inside the
   * "Sesiones…" modal reachable from the FILE menu once a session is open. */
  embedded?: boolean;
};

/**
 * Landing screen for Android, where native file dialogs are limited: sessions
 * are created by name (the user still picks where to save via the folder
 * picker) and opened through the system file picker, which can reach a
 * `.ltsession` anywhere on the device. We deliberately do NOT list the app's
 * default songs folder here — sessions live scattered across the device, so a
 * partial list keyed to one folder is misleading. Replaces the desktop
 * empty-state card, whose flows all go through `rfd` dialogs.
 */
export function MobileLanding({
  onCreateSession,
  onOpenSessionFromPicker,
  onImportSession,
  embedded = false,
}: MobileLandingProps) {
  const { t } = useTranslation();
  const [sessionName, setSessionName] = useState("");
  const [isNamingSession, setIsNamingSession] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [isPickingFolder, setIsPickingFolder] = useState(false);

  const trimmedName = sessionName.trim();

  const submitCreate = () => {
    if (!trimmedName || isPickingFolder) {
      return;
    }
    const name = trimmedName;
    // Ask where to save first; cancelling the folder cancels the whole create
    // (no silent fallback to the app's private folder). Only after we have a
    // destination do we close the form and hand off to the backend.
    setFolderError(null);
    setIsPickingFolder(true);
    void pickSessionFolder(name)
      .then((parentDir) => {
        if (!parentDir) {
          // User cancelled the folder picker — leave the form as-is.
          return;
        }
        setIsNamingSession(false);
        setSessionName("");
        onCreateSession(name, parentDir);
      })
      .catch((error: unknown) => {
        setFolderError(
          typeof error === "string" ? error : (error as Error)?.message ?? null,
        );
      })
      .finally(() => {
        setIsPickingFolder(false);
      });
  };

  return (
    <div className={embedded ? undefined : "lt-empty-state"}>
      <div className="lt-empty-state-card">
        <span className="lt-empty-state-eyebrow">
          {t("transport.shell.emptyEyebrow")}
        </span>
        <h1>{t("transport.shell.emptyTitle")}</h1>
        <p>{t("transport.shell.mobileEmptyDescription")}</p>

        {isNamingSession ? (
          <form
            className="lt-mobile-landing-create"
            onSubmit={(event) => {
              event.preventDefault();
              submitCreate();
            }}
          >
            <input
              type="text"
              autoFocus
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
              placeholder={t("transport.shell.mobileSessionNamePlaceholder")}
              aria-label={t("transport.shell.mobileSessionNamePlaceholder")}
            />
            {folderError ? (
              <p className="lt-mobile-landing-name-taken" role="alert">
                {folderError}
              </p>
            ) : null}
            <div className="lt-empty-state-actions">
              <button
                type="submit"
                className="is-primary"
                disabled={!trimmedName || isPickingFolder}
              >
                {t("common.create")}
              </button>
              <button
                type="button"
                disabled={isPickingFolder}
                onClick={() => {
                  setIsNamingSession(false);
                  setSessionName("");
                  setFolderError(null);
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </form>
        ) : (
          <div className="lt-empty-state-actions">
            <button
              type="button"
              className="is-primary"
              onClick={() => setIsNamingSession(true)}
            >
              {t("common.create")}
            </button>
            {onOpenSessionFromPicker ? (
              <button type="button" onClick={onOpenSessionFromPicker}>
                {t("common.open")}
              </button>
            ) : null}
            {onImportSession ? (
              <button type="button" onClick={onImportSession}>
                {t("transport.shell.importSession", {
                  defaultValue: "Importar sesión",
                })}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
