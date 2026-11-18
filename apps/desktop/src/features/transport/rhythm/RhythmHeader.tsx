// Cabecera del panel: ▶/■, patrón, BPM (y Tap en Libre), reloj,
// cuantización, volumen y ✎. En `short` lo secundario va a un menú «⋯» para
// que la cabecera no haga nunca dos líneas.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { DB_FLOOR, dbToGain, gainToDb } from "@libretracks/shared/faderScale";
import type { AppSettings, LoopClockMode, LoopPattern, LoopQuantize } from "@libretracks/shared/models";

import { MidiMappable } from "../midi/MidiMappable";
import type { RhythmHandlers } from "./rhythmHandlers";
import { RhythmVolumeFader } from "./RhythmVolumeFader";
import type { RhythmLayoutClass } from "./useRhythmLayout";

type RhythmHeaderProps = {
  settings: AppSettings;
  patterns: LoopPattern[];
  playing: boolean;
  layout: RhythmLayoutClass;
  /** El loop que suena es el de la canción (no el elegido en la biblioteca). */
  songPatternName?: string | null;
  freeBpm: number | null;
  handlers: Pick<
    RhythmHandlers,
    "setLoopPlaying" | "selectPattern" | "setClockMode" | "setQuantize" | "setLoopVolume" | "tap" | "setFollowTransport"
  >;
  onEdit?: () => void;
  onClose?: () => void;
};

export function RhythmHeader({
  settings,
  patterns,
  playing,
  layout,
  songPatternName,
  freeBpm,
  handlers,
  onEdit,
  onClose,
}: RhythmHeaderProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const free = settings.loopClockMode === "free";
  // Mientras se arrastra el fader manda lo local; los ajustes que vuelven del
  // backend solo lo sustituyen cuando ya coinciden (sin saltos).
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  useEffect(() => {
    if (volumeDraft !== null && Math.abs(settings.loopVolume - volumeDraft) < 1e-6) setVolumeDraft(null);
  }, [settings.loopVolume, volumeDraft]);

  const secondary = (
    <>
      <div className="lt-rhythm-segmented" role="group" aria-label={t("rhythm.clock")}>
        {(["follow", "free"] as LoopClockMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={settings.loopClockMode === mode}
            className={settings.loopClockMode === mode ? "is-active" : ""}
            onClick={() => void handlers.setClockMode(mode)}
          >
            {mode === "follow" ? t("rhythm.follow") : t("rhythm.free")}
          </button>
        ))}
      </div>
      <label className="lt-rhythm-field lt-rhythm-switch-field">
        <input
          type="checkbox"
          checked={settings.loopFollowTransport}
          onChange={(event) => void handlers.setFollowTransport(event.target.checked)}
        />
        <span className="lt-rhythm-field__label">{t("rhythm.followTransport")}</span>
      </label>
      <label className="lt-rhythm-field">
        <span className="lt-rhythm-field__label">{t("rhythm.quantize")}</span>
        <select
          value={settings.loopQuantize}
          onChange={(event) => void handlers.setQuantize(event.target.value as LoopQuantize)}
        >
          <option value="bar">{t("rhythm.quantizeBar")}</option>
          <option value="beat">{t("rhythm.quantizeBeat")}</option>
          <option value="immediate">{t("rhythm.quantizeImmediate")}</option>
        </select>
      </label>
      <label className="lt-rhythm-field">
        <span className="lt-rhythm-field__label">{t("rhythm.volume")}</span>
        <RhythmVolumeFader
          ariaLabel={t("rhythm.volume")}
          db={gainToDb(volumeDraft ?? settings.loopVolume)}
          onChange={(db) => {
            const volume = db <= DB_FLOOR ? 0 : dbToGain(db);
            setVolumeDraft(volume);
            void handlers.setLoopVolume(volume);
          }}
        />
      </label>
    </>
  );

  return (
    <div className="lt-rhythm-header" data-testid="rhythm-header">
      <MidiMappable target="action:loop_toggle">
      <button
        type="button"
        className={playing ? "lt-rhythm-play is-playing" : "lt-rhythm-play"}
        aria-pressed={playing}
        aria-label={playing ? t("rhythm.stop") : t("rhythm.play")}
        onClick={() => void handlers.setLoopPlaying(!playing)}
      >
        {/* Icono y no «▶»: iOS pinta ese carácter como emoji azul. */}
        <span className="material-symbols-outlined" aria-hidden="true">
          {playing ? "stop" : "play_arrow"}
        </span>
      </button>
      </MidiMappable>
      {songPatternName ? (
        <span className="lt-rhythm-song-pattern" title={t("rhythm.songPattern")}>
          {songPatternName}
        </span>
      ) : (
        <select
          className="lt-rhythm-pattern-select"
          aria-label={t("rhythm.pattern")}
          value={settings.activeLoopPatternId}
          onChange={(event) => void handlers.selectPattern(event.target.value)}
        >
          <option value="">{patterns.length ? t("rhythm.noPattern") : t("rhythm.noPatterns")}</option>
          {patterns.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {free ? (
        <span className="lt-rhythm-free" title={t("rhythm.freeHint")}>
          {freeBpm !== null ? (
            <span className="lt-rhythm-bpm">{t("rhythm.bpm", { bpm: Math.round(freeBpm * 10) / 10 })}</span>
          ) : null}
          <button type="button" className="lt-rhythm-tap" onClick={() => handlers.tap()}>
            {t("rhythm.tap")}
          </button>
        </span>
      ) : (
        <span className="lt-rhythm-follow-hint">{t("rhythm.followHint")}</span>
      )}
      {layout === "short" ? (
        <div className="lt-rhythm-more">
          <button
            type="button"
            aria-label={t("rhythm.more")}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="lt-rhythm-more__menu" role="menu" data-testid="rhythm-more-menu">
              {secondary}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="lt-rhythm-header__secondary">{secondary}</div>
      )}
      <span className="lt-rhythm-header__spacer" />
      {onEdit ? (
        <button type="button" className="lt-rhythm-icon" aria-label={t("rhythm.edit")} onClick={onEdit}>
          ✎
        </button>
      ) : null}
      {onClose ? (
        <button type="button" className="lt-rhythm-icon" aria-label={t("rhythm.close")} onClick={onClose}>
          ×
        </button>
      ) : null}
    </div>
  );
}
