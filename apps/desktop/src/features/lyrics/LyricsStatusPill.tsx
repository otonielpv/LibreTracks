import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LyricsApi } from "./lyricsHandlers";
import { selectPillTone, useLyricsStore } from "./lyricsStore";
import { useLyricsHandlers } from "./useLyricsHandlers";

const ICONS = {
  ok: "lyrics",
  warning: "lyrics",
  error: "error",
  paused: "pause_circle",
  connecting: "sync",
} as const;

/**
 * Top-bar pill, only with lyrics on: green connected, amber songs without a
 * presentation, red no connection or permissions, grey paused. Tapping it
 * opens the last send and the quick actions.
 */
export function LyricsStatusPill({ api }: { api?: LyricsApi } = {}) {
  const { t } = useTranslation();
  const tone = useLyricsStore(selectPillTone);
  const [open, setOpen] = useState(false);
  const handlers = useLyricsHandlers(api);
  if (!tone) return null;
  const label = t(`lyrics.pill.${tone}`);
  return (
    <div className="lt-lyrics-pill-slot">
      <button
        type="button"
        className={`lt-lyrics-pill is-${tone}`}
        aria-label={`${t("lyrics.title")}: ${label}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="material-symbols-outlined" aria-hidden="true" data-icon={ICONS[tone]}>
          {ICONS[tone]}
        </span>
        <span>{label}</span>
      </button>
      {open ? <LyricsPillPopover onClose={() => setOpen(false)} handlers={handlers} /> : null}
    </div>
  );
}

function LyricsPillPopover({
  onClose,
  handlers,
}: {
  onClose: () => void;
  handlers: ReturnType<typeof useLyricsHandlers>;
}) {
  const { t } = useTranslation();
  const status = useLyricsStore((state) => state.status);
  const config = useLyricsStore((state) => state.configView?.config);
  const paused = config?.paused ?? false;
  const last = status?.lastSent;
  const connection = status?.connection;
  return (
    <div className="lt-lyrics-popover" role="dialog" aria-label={t("lyrics.title")}>
      <p className="lt-lyrics-popover-program">
        <strong>{config?.software ? t(`lyrics.programs.${config.software}`) : ""}</strong>{" "}
        <span>{t(`lyrics.connection.${connection?.state ?? "connecting"}`)}</span>
      </p>
      {connection?.state === "unauthorized" && connection.missing.length > 0 ? (
        <p className="lt-lyrics-popover-error">
          {t("lyrics.errors.missingPermissions")} {connection.missing.join(", ")}
        </p>
      ) : null}
      {status?.lastError && connection?.state !== "ok" ? (
        <p className="lt-lyrics-popover-error">{status.lastError}</p>
      ) : null}
      {last ? (
        <p className="lt-lyrics-popover-last">
          {t("lyrics.pill.lastSent", {
            marker: last.markerName ?? "-",
            group: last.label ?? t("lyrics.pill.cleared"),
            ms: Math.round(last.latencyMs),
          })}
        </p>
      ) : null}
      {(status?.unlinkedSongs ?? 0) > 0 ? (
        <p className="lt-lyrics-popover-warning">
          {t("lyrics.pill.unlinked", { count: status?.unlinkedSongs ?? 0 })}
        </p>
      ) : null}
      <div className="lt-lyrics-popover-actions">
        <button className="lt-lyrics-btn" type="button" onClick={() => void handlers.setPaused(!paused)}>
          {paused ? t("lyrics.pill.resume") : t("lyrics.pill.pause")}
        </button>
        <button className="lt-lyrics-btn"
          type="button"
          onClick={() => {
            handlers.openLinker();
            onClose();
          }}
        >
          {t("lyrics.pill.link")}
        </button>
        <button className="lt-lyrics-btn" type="button" onClick={() => void handlers.refresh()}>
          {t("lyrics.pill.refresh")}
        </button>
      </div>
    </div>
  );
}
