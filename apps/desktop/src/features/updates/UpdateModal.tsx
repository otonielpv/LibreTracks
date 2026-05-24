import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { AppLanguage } from "../../shared/i18n";
import {
  DOWNLOADS_PAGE_URL,
  extractReleaseNotesForLanguage,
  setSkippedVersion,
  snoozeUntil,
  type ReleaseInfo,
} from "../../shared/updateCheck";

type UpdateModalProps = {
  release: ReleaseInfo;
  currentVersion: string;
  onClose: () => void;
};

function renderInlineMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

type Block =
  | { kind: "heading"; level: number; html: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; html: string };

function notesToBlocks(notes: string): Block[] {
  const blocks: Block[] = [];
  const lines = notes.split(/\r?\n/);
  let listBuffer: string[] = [];
  let paragraphBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length > 0) {
      blocks.push({ kind: "list", items: listBuffer });
      listBuffer = [];
    }
  };
  const flushParagraph = () => {
    if (paragraphBuffer.length > 0) {
      blocks.push({
        kind: "paragraph",
        html: renderInlineMarkdown(paragraphBuffer.join(" ").trim()),
      });
      paragraphBuffer = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        html: renderInlineMarkdown(heading[2]),
      });
      continue;
    }
    const item = /^\s*[-*]\s+(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      listBuffer.push(renderInlineMarkdown(item[1]));
      continue;
    }
    flushList();
    paragraphBuffer.push(line.trim());
  }
  flushList();
  flushParagraph();
  return blocks;
}

export function UpdateModal({
  release,
  currentVersion,
  onClose,
}: UpdateModalProps) {
  const { t, i18n } = useTranslation();
  const language: AppLanguage = i18n.language.toLowerCase().startsWith("es")
    ? "es"
    : "en";

  const notes = useMemo(
    () => extractReleaseNotesForLanguage(release.body, language),
    [release.body, language],
  );
  const blocks = useMemo(() => notesToBlocks(notes), [notes]);
  const formattedDate = useMemo(() => {
    if (!release.publishedAt) return null;
    try {
      return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(
        new Date(release.publishedAt),
      );
    } catch {
      return null;
    }
  }, [release.publishedAt, language]);

  const handleDownload = () => {
    void openUrl(DOWNLOADS_PAGE_URL).catch(() => undefined);
    snoozeUntil();
    onClose();
  };

  const handleRemindLater = () => {
    snoozeUntil();
    onClose();
  };

  const handleSkip = () => {
    setSkippedVersion(release.version);
    onClose();
  };

  return (
    <div
      className="lt-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lt-update-modal-title"
    >
      <div className="lt-settings-modal lt-settings-modal--compact lt-update-modal">
        <header className="lt-settings-modal-header">
          <div>
            <p className="lt-settings-modal-eyebrow">
              {t("update.eyebrow", "Update available")}
            </p>
            <h2 id="lt-update-modal-title">
              {t("update.title", "LibreTracks {{version}} is available", {
                version: release.version,
              })}
            </h2>
            <p>
              {t("update.subtitle", "You are on version {{current}}.", {
                current: currentVersion,
              })}
              {formattedDate
                ? ` · ${t("update.published", "Published {{date}}", {
                    date: formattedDate,
                  })}`
                : null}
            </p>
          </div>
          <button
            type="button"
            className="lt-settings-modal-close"
            onClick={handleRemindLater}
            aria-label={t("update.remindLater", "Remind me later")}
          >
            ×
          </button>
        </header>

        <section className="lt-update-modal-notes" aria-live="polite">
          <h3 className="lt-update-modal-notes-title">
            {t("update.notesTitle", "What's new")}
          </h3>
          {blocks.length > 0 ? (
            <div className="lt-update-modal-notes-body">
              {blocks.map((block, index) => {
                if (block.kind === "list") {
                  return (
                    <ul key={index}>
                      {block.items.map((item, itemIndex) => (
                        <li
                          key={itemIndex}
                          dangerouslySetInnerHTML={{ __html: item }}
                        />
                      ))}
                    </ul>
                  );
                }
                if (block.kind === "heading") {
                  const Tag = `h${Math.min(
                    Math.max(block.level + 2, 3),
                    6,
                  )}` as "h3" | "h4" | "h5" | "h6";
                  return (
                    <Tag
                      key={index}
                      dangerouslySetInnerHTML={{ __html: block.html }}
                    />
                  );
                }
                return (
                  <p
                    key={index}
                    dangerouslySetInnerHTML={{ __html: block.html }}
                  />
                );
              })}
            </div>
          ) : (
            <p className="lt-update-modal-notes-empty">
              {t(
                "update.notesEmpty",
                "Open the release page to see the full changelog.",
              )}
            </p>
          )}
        </section>

        <footer className="lt-update-modal-actions">
          <button
            type="button"
            className="lt-settings-modal-close lt-update-modal-skip"
            onClick={handleSkip}
          >
            {t("update.skipVersion", "Skip this version")}
          </button>
          <button
            type="button"
            className="lt-settings-modal-close"
            onClick={handleRemindLater}
          >
            {t("update.remindLater", "Remind me later")}
          </button>
          <button
            type="button"
            className="lt-settings-modal-close lt-update-modal-primary"
            onClick={handleDownload}
          >
            {t("update.download", "Download")}
          </button>
        </footer>
      </div>
    </div>
  );
}
