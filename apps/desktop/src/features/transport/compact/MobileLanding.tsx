import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  listSessionTemplates,
  pickSessionFolder,
  type SessionTemplateSummary,
} from "../desktopApi";
import {
  LANDING_RECENT_SESSIONS_LIMIT,
  loadRecentSessions,
  type RecentSessionEntry,
} from "../recentSessions";

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
  const [recentSessions] = useState<RecentSessionEntry[]>(() =>
    loadRecentSessions(),
  );

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
              onClick={() => setCreationTemplate(null)}
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

        <div className="lt-empty-state-columns">
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
              <span>{t("transport.shell.recentsHeading")}</span>
            </div>
            {recentSessions.length > 0 ? (
              <ul className="lt-empty-state-template-list">
                {recentSessions
                  .slice(0, LANDING_RECENT_SESSIONS_LIMIT)
                  .map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        title={entry.path}
                        onClick={() => onOpenSessionFromPath?.(entry.path)}
                      >
                        {entry.name}
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
