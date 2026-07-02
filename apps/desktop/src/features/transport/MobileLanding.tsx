import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  listDefaultSessions,
  type DefaultSessionSummary,
} from "./desktopApi";

type MobileLandingProps = {
  onCreateSession: (name: string) => void;
  onOpenSession: (songFile: string) => void;
  /** Render just the card (no full-stage backdrop) — used inside the
   * "Sesiones…" modal reachable from the FILE menu once a session is open. */
  embedded?: boolean;
};

/**
 * Landing screen for Android, where native file dialogs don't exist: sessions
 * are created by name in the app's default songs folder and opened from a
 * list of the sessions found there. Replaces the desktop empty-state card
 * (Create/Open/Import buttons), whose flows all go through `rfd` dialogs.
 */
export function MobileLanding({
  onCreateSession,
  onOpenSession,
  embedded = false,
}: MobileLandingProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<DefaultSessionSummary[]>([]);
  const [sessionName, setSessionName] = useState("");
  const [isNamingSession, setIsNamingSession] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listDefaultSessions()
      .then((list) => {
        if (!cancelled) {
          setSessions(list);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmedName = sessionName.trim();
  const nameTaken = sessions.some(
    (session) => session.name.toLowerCase() === trimmedName.toLowerCase(),
  );

  const submitCreate = () => {
    if (!trimmedName || nameTaken) {
      return;
    }
    setIsNamingSession(false);
    setSessionName("");
    onCreateSession(trimmedName);
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
            {nameTaken ? (
              <p className="lt-mobile-landing-name-taken" role="alert">
                {t("transport.shell.mobileSessionNameTaken")}
              </p>
            ) : null}
            <div className="lt-empty-state-actions">
              <button
                type="submit"
                className="is-primary"
                disabled={!trimmedName || nameTaken}
              >
                {t("common.create")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsNamingSession(false);
                  setSessionName("");
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
          </div>
        )}

        <div className="lt-empty-state-templates">
          <div className="lt-empty-state-templates-header">
            <span>{t("transport.shell.mobileSessionsHeading")}</span>
          </div>
          {sessions.length > 0 ? (
            <ul className="lt-empty-state-template-list">
              {sessions.map((session) => (
                <li key={session.songFile}>
                  <button
                    type="button"
                    onClick={() => onOpenSession(session.songFile)}
                  >
                    {session.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="lt-empty-state-templates-empty">
              {t("transport.shell.mobileNoSessions")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
