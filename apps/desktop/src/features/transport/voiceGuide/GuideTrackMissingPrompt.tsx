import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppSettings } from "@libretracks/shared/models";
import { getSongView, updateTrackGuide } from "../desktopApi";
import { guideTrackOptions } from "../songAnalysis/songAnalysisPlan";
import { useSongStore } from "../songStore";
import {
  guideJumpsOnlyActive,
  regionsMissingGuide,
  useGuideTrackPromptStore,
} from "./guideTrackPrompt";

type Props = {
  settings: Pick<AppSettings, "voiceGuideEnabled" | "voiceGuideJumpsOnly">;
};

/**
 * Salta cuando la voz guía está en «solo en saltos» y alguna canción no tiene
 * pista de guía (ni por nombre ni elegida): lista esas canciones y deja
 * elegir, en cada una, cuál de sus pistas es la guía.
 */
export function GuideTrackMissingPrompt({ settings }: Props) {
  const { t } = useTranslation();
  const song = useSongStore((state) => state.song);
  const dismissed = useGuideTrackPromptStore((state) => state.dismissed);
  const forced = useGuideTrackPromptStore((state) => state.forced);
  const dismiss = useGuideTrackPromptStore((state) => state.dismiss);
  const reset = useGuideTrackPromptStore((state) => state.reset);
  const [busyRegion, setBusyRegion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = guideJumpsOnlyActive(settings);
  const missing = useMemo(() => regionsMissingGuide(song), [song]);
  const pending = missing.filter((region) => !dismissed.includes(region.id));

  // Apagar la opción olvida los «Ahora no»: al volver a encenderla avisa otra vez.
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) reset();
    wasActive.current = active;
  }, [active, reset]);

  // Las canciones que quedan en la lista mientras está abierto: si se resuelve
  // la última, se ve «Listo» en vez de cerrarse de golpe.
  const [shown, setShown] = useState<string[]>([]);
  const open = active && (pending.length > 0 || shown.length > 0 || forced);
  useEffect(() => {
    if (!open) {
      if (shown.length > 0) setShown([]);
      return;
    }
    const add = pending.map((region) => region.id).filter((id) => !shown.includes(id));
    if (add.length > 0) setShown((current) => [...current, ...add]);
  }, [open, pending, shown]);

  if (!open || !song) return null;

  const close = () => {
    dismiss(shown);
    setShown([]);
    setError(null);
  };

  const choose = async (regionId: string, trackId: string) => {
    setBusyRegion(regionId);
    setError(null);
    try {
      await updateTrackGuide({ trackId, guide: true });
      const fresh = await getSongView();
      useSongStore.getState().setSong(fresh);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyRegion(null);
    }
  };

  const rows = shown
    .map((id) => song.regions.find((region) => region.id === id))
    .filter((region) => region !== undefined);
  const allSet = rows.every((region) => region.hasGuideTrack !== false);

  return (
    <div
      className="lt-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lt-guide-prompt-title"
    >
      <div className="lt-settings-modal lt-settings-modal--compact">
        <header className="lt-settings-modal-header">
          <div>
            <h2 id="lt-guide-prompt-title">{t("transport.guidePrompt.title")}</h2>
            <p>{allSet ? t("transport.guidePrompt.allSet") : t("transport.guidePrompt.body")}</p>
          </div>
        </header>
        <ul className="lt-guide-prompt-list">
          {rows.map((region) => {
            const { options } = guideTrackOptions(song, region.id);
            const chosen = song.tracks.find(
              (track) =>
                track.isGuide && options.some((option) => option.id === track.id),
            );
            return (
              <li key={region.id} className="lt-guide-prompt-row">
                <span className="lt-guide-prompt-song">{region.name}</span>
                <select
                  className="lt-pads-select"
                  aria-label={region.name}
                  value={chosen?.id ?? ""}
                  disabled={options.length === 0 || busyRegion !== null}
                  onChange={(event) => {
                    if (event.target.value) void choose(region.id, event.target.value);
                  }}
                >
                  <option value="" disabled>
                    {options.length === 0
                      ? t("transport.guidePrompt.noTracks")
                      : t("transport.guidePrompt.choose")}
                  </option>
                  {options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
        {error ? <p className="lt-guide-prompt-error">{error}</p> : null}
        <footer className="lt-update-modal-actions">
          <button
            type="button"
            className={`lt-settings-modal-close${allSet ? " lt-update-modal-primary" : ""}`}
            onClick={close}
            autoFocus
          >
            {allSet ? t("transport.guidePrompt.done") : t("transport.guidePrompt.later")}
          </button>
        </footer>
      </div>
    </div>
  );
}
