import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  isAndroidApp,
  listDefaultSessions,
  listSessionTemplates,
  pickSessionFolder,
  type DefaultSessionSummary,
  type SessionTemplateSummary,
} from "../desktopApi";
import {
  LANDING_RECENT_SESSIONS_LIMIT,
  loadRecentSessions,
  removeRecentSession,
  type RecentSessionEntry,
} from "../recentSessions";
import { TOUR_TARGETS } from "../../tutorial/tourTargets";

type MobileLandingProps = {
  /** Create the session under `parentDir` (a folder the user picked) — the
   * caller places it in the default folder when `parentDir` is omitted. */
  onCreateSession: (name: string, parentDir?: string) => void;
  /** Create a named session using a template from the app-local catalog. */
  onCreateSessionFromTemplate: (
    templatePath: string,
    name: string,
    parentDir?: string,
  ) => void;
  /** Browse for a .ltsession anywhere on the device via the system picker
   * (which remembers the app's last folder) — the desktop "Open" flow. */
  onOpenSessionFromPicker?: () => void;
  /** Reopen a session whose real filesystem path was persisted in the MRU. */
  onOpenSessionFromPath?: (path: string) => void;
  /** Import a whole `.ltset` as a new session via the system file picker.
   * Optional so the embedded "Sesiones…" modal can omit it. */
  onImportSession?: () => void;
  /** Render just the card (no full-stage backdrop) — used inside the
   * "Sesiones…" modal reachable from the FILE menu once a session is open. */
  embedded?: boolean;
};

/**
 * Landing screen for mobile, where native file dialogs are limited: sessions
 * are created by name and the user picks where to save them. Opening also uses
 * the system picker, which can reach device or cloud-provider locations. We
 * deliberately do NOT list the app's
 * default songs folder here — sessions live scattered across the device, so a
 * partial list keyed to one folder is misleading. Replaces the desktop
 * empty-state card, whose flows all go through `rfd` dialogs.
 */
export function MobileLanding({
  onCreateSession,
  onCreateSessionFromTemplate,
  onOpenSessionFromPicker,
  onOpenSessionFromPath,
  onImportSession,
  embedded = false,
}: MobileLandingProps) {
  const { t } = useTranslation();
  const [sessionName, setSessionName] = useState("");
  const [creationTemplate, setCreationTemplate] = useState<
    SessionTemplateSummary | null | undefined
  >(undefined);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [templates, setTemplates] = useState<SessionTemplateSummary[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [recentSessions, setRecentSessions] = useState<RecentSessionEntry[]>(
    () => loadRecentSessions(),
  );
  // Android only: the sessions actually on disk in the app's songs folder.
  // The MRU cannot be the index there: localStorage can be lost or reset
  // independently during WebView upgrades and recovery, and a session the
  // list forgets would otherwise be unreachable (there is no "open from
  // device" on Android any more). Everywhere else the MRU is the right answer:
  // sessions are scattered across the device and only it knows where.
  const [deviceSessions, setDeviceSessions] = useState<DefaultSessionSummary[]>(
    [],
  );

  useEffect(() => {
    if (!isAndroidApp) {
      return;
    }
    let cancelled = false;
    void listDefaultSessions()
      .then((sessions) => {
        if (!cancelled) {
          setDeviceSessions(sessions);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDeviceSessions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listSessionTemplates()
      .then((nextTemplates) => {
        if (!cancelled) {
          setTemplates(nextTemplates);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTemplates([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTemplatesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmedName = sessionName.trim();

  const submitCreate = () => {
    if (!trimmedName || isPickingFolder) {
      return;
    }
    const name = trimmedName;
    // Android has no "where to save" step: Google Play only grants the
    // all-files permission to file managers and the like, so sessions always
    // live in the app's own folder (see AndroidManifest.xml). iOS keeps the
    // picker — its security-scoped bookmarks hand back a real path the engine
    // can stream from, so a session there can live wherever the user wants.
    if (isAndroidApp) {
      setFolderError(null);
      setCreationTemplate(undefined);
      setSessionName("");
      if (creationTemplate) {
        onCreateSessionFromTemplate(creationTemplate.path, name);
      } else {
        onCreateSession(name);
      }
      return;
    }
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
        setCreationTemplate(undefined);
        setSessionName("");
        if (creationTemplate) {
          onCreateSessionFromTemplate(creationTemplate.path, name, parentDir);
        } else {
          onCreateSession(name, parentDir);
        }
      })
      .catch((error: unknown) => {
        setFolderError(
          typeof error === "string"
            ? error
            : ((error as Error)?.message ?? null),
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

        {creationTemplate !== undefined ? (
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
                  setCreationTemplate(undefined);
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
              data-lt-tour={TOUR_TARGETS.landingCreate}
              onClick={() => setCreationTemplate(null)}
            >
              {t("common.create")}
            </button>
            {onOpenSessionFromPicker && !isAndroidApp ? (
              <button type="button" data-lt-tour={TOUR_TARGETS.landingOpen} onClick={onOpenSessionFromPicker}>
                {t("common.open")}
              </button>
            ) : null}
            {onImportSession ? (
              <button type="button" data-lt-tour={TOUR_TARGETS.landingImport} onClick={onImportSession}>
                {t("transport.shell.importSession", {
                  defaultValue: "Importar sesión",
                })}
              </button>
            ) : null}
          </div>
        )}

        <div className="lt-empty-state-columns" data-lt-tour={TOUR_TARGETS.landingCatalog}>
          <div className="lt-empty-state-templates">
            <div className="lt-empty-state-templates-header">
              <span>{t("transport.shell.templatesHeading")}</span>
            </div>
            {templates.length > 0 ? (
              <ul className="lt-empty-state-template-list">
                {templates.map((template) => (
                  <li key={template.path}>
                    <button
                      type="button"
                      title={template.path}
                      onClick={() => {
                        setSessionName(template.name);
                        setFolderError(null);
                        setCreationTemplate(template);
                      }}
                    >
                      {template.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : templatesLoading ? (
              <p className="lt-empty-state-templates-empty">
                {t("transport.shell.templatesLoading")}
              </p>
            ) : (
              <p className="lt-empty-state-templates-empty">
                {t("transport.shell.noTemplates")}
              </p>
            )}
          </div>

          <div className="lt-empty-state-templates lt-empty-state-recents">
            <div className="lt-empty-state-templates-header">
              <span>
                {isAndroidApp
                  ? t("transport.shell.mobileSessionsHeading")
                  : t("transport.shell.recentsHeading")}
              </span>
            </div>
            {isAndroidApp ? (
              deviceSessions.length > 0 ? (
                <ul className="lt-empty-state-template-list">
                  {deviceSessions.map((entry) => (
                    <li key={entry.songFile}>
                      <button
                        type="button"
                        title={entry.songFile}
                        onClick={() => onOpenSessionFromPath?.(entry.songFile)}
                      >
                        {entry.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="lt-empty-state-templates-empty">
                  {t("transport.shell.mobileNoSessions")}
                </p>
              )
            ) : recentSessions.length > 0 ? (
              <ul className="lt-empty-state-template-list">
                {recentSessions
                  .slice(0, LANDING_RECENT_SESSIONS_LIMIT)
                  .map((entry) => (
                    <li key={entry.path} className="lt-empty-state-recent-row">
                      <button
                        type="button"
                        className="lt-empty-state-recent-open"
                        title={entry.path}
                        onClick={() => onOpenSessionFromPath?.(entry.path)}
                      >
                        {entry.name}
                      </button>
                      <button
                        type="button"
                        className="lt-empty-state-recent-remove"
                        title={t("transport.shell.removeRecent")}
                        aria-label={t("transport.shell.removeRecent")}
                        onClick={() =>
                          setRecentSessions(removeRecentSession(entry.path))
                        }
                      >
                        <span className="material-symbols-outlined">
                          delete
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="lt-empty-state-templates-empty">
                {t("transport.shell.noRecents")}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
