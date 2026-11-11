import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useSongTemplateList } from "../hooks/useSongTemplateList";

/**
 * The cloud flows load on first click: Settings renders this block in many
 * tests that mock i18n, and the flows bring the app's i18n instance with them.
 */
const loadTransfer = () => import("./templateTransfer");

/**
 * Settings › Project › «Mis plantillas»: the templates in the templates folder,
 * with a way to bring more in (from this device or the cloud) and to send each
 * one up to the cloud.
 *
 * Saving the current session as a template stays in the File menu, where it
 * always was; this is for the templates that already exist.
 */
export function TemplateLibraryField({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const { templates, loading } = useSongTemplateList(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  const run = async (work: () => Promise<string | null>) => {
    setWorking(true);
    setMessage(null);
    try {
      const text = await work();
      if (text) setMessage({ text, isError: false });
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="lt-settings-field lt-template-library">
      <div className="lt-template-library-header">
        <span className="lt-settings-field-label">{t("songTemplates.library")}</span>
        <button
          type="button"
          className="lt-secondary-button"
          disabled={disabled || working}
          onClick={() =>
            void run(async () => {
              const { importTemplateWithChoice } = await loadTransfer();
              const imported = await importTemplateWithChoice();
              return imported ? t("songTemplates.imported", { name: imported.name }) : null;
            })
          }
        >
          {t("songTemplates.importTemplate")}
        </button>
      </div>
      {!loading && templates.length === 0 ? (
        <small>{t("songTemplates.libraryEmpty")}</small>
      ) : (
        <ul className="lt-template-library-list">
          {templates.map((template) => (
            <li key={template.path}>
              <span className="lt-template-library-name">{template.name}</span>
              <button
                type="button"
                className="lt-link-button"
                disabled={disabled || working}
                onClick={() =>
                  void run(async () => {
                    const { uploadTemplateToCloud } = await loadTransfer();
                    return (await uploadTemplateToCloud(template))
                      ? t("songTemplates.uploaded", { name: template.name })
                      : null;
                  })
                }
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  cloud_upload
                </span>
                {t("songTemplates.uploadTemplate")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {message ? (
        <small role={message.isError ? "alert" : "status"}>{message.text}</small>
      ) : (
        <small>{t("songTemplates.libraryHint")}</small>
      )}
    </div>
  );
}
