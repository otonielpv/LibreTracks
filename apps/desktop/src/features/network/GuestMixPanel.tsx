import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AUX_FADER_SCALE,
  TRACK_FADER_SCALE,
  formatGainDb,
  gainToPosition,
  positionToGain,
  type FaderScale,
} from "@libretracks/shared/faderScale";
import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

import type { GuestCommandHandlers } from "./guestCommandHandlers";

/** Live values go out at most this often while a fader moves. */
const LIVE_INTERVAL_MS = 33;
/** The value is committed (undo entry, saved) once the fader rests this long. */
const COMMIT_AFTER_MS = 250;

/**
 * A fader that streams to the host while it moves and commits when it rests,
 * like the host's own faders: live values go straight to the engine, the
 * final one becomes an undoable edit. It shows its own value while moving so
 * the host's snapshots (a few ms behind) do not make the thumb jump.
 */
function RemoteFader({
  label,
  gain,
  scale,
  onLive,
  onCommit,
}: {
  label: string;
  gain: number;
  scale: FaderScale;
  onLive: (gain: number) => void;
  onCommit: (gain: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const lastLiveAt = useRef(0);
  const commitTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    },
    [],
  );

  const shown = draft ?? gainToPosition(gain, scale);
  const change = (position: number) => {
    setDraft(position);
    const next = positionToGain(position, scale);
    const now = performance.now();
    if (now - lastLiveAt.current >= LIVE_INTERVAL_MS) {
      lastLiveAt.current = now;
      onLive(next);
    }
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = null;
      onCommit(next);
      setDraft(null);
    }, COMMIT_AFTER_MS);
  };

  return (
    <label className="lt-guest-fader">
      <span className="lt-guest-fader-name">{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={shown}
        aria-label={label}
        onChange={(event) => change(Number(event.target.value))}
      />
      <output>{formatGainDb(positionToGain(shown, scale))}</output>
    </label>
  );
}

export function GuestMixPanel({
  song,
  region,
  metronomeEnabled,
  metronomeVolume,
  handlers,
  onClose,
}: {
  song: SongView;
  region: SongRegionSummary | null;
  metronomeEnabled: boolean;
  metronomeVolume: number;
  handlers: GuestCommandHandlers;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const tracks = song.tracks.filter((track) => track.kind !== "folder");

  return (
    <aside className="lt-guest-mix" aria-label={t("networkSession.mix.title")}>
      <header>
        <strong>{t("networkSession.mix.title")}</strong>
        <button type="button" onClick={onClose} aria-label={t("common.close")}>
          <span className="material-symbols-outlined" aria-hidden="true">
            close
          </span>
        </button>
      </header>

      {region ? (
        <section className="lt-guest-mix-song">
          <span className="lt-guest-mix-heading">{region.name}</span>
          <span className="lt-guest-stepper">
            <span className="lt-guest-stepper-label">{t("networkSession.mix.songKey")}</span>
            <button
              type="button"
              aria-label={t("networkSession.mix.keyDown")}
              onClick={() =>
                handlers.setSongTranspose(region.id, Math.max(-12, region.transposeSemitones - 1))
              }
            >
              −
            </button>
            <output>
              {region.transposeSemitones > 0
                ? `+${region.transposeSemitones}`
                : region.transposeSemitones}
            </output>
            <button
              type="button"
              aria-label={t("networkSession.mix.keyUp")}
              onClick={() =>
                handlers.setSongTranspose(region.id, Math.min(12, region.transposeSemitones + 1))
              }
            >
              +
            </button>
          </span>
          <RemoteFader
            label={t("networkSession.mix.songMaster")}
            gain={region.master?.gain ?? 1}
            scale={TRACK_FADER_SCALE}
            onLive={(gain) => handlers.setSongMasterGain(region.id, gain, true)}
            onCommit={(gain) => handlers.setSongMasterGain(region.id, gain, false)}
          />
        </section>
      ) : null}

      <section className="lt-guest-mix-row">
        <button
          type="button"
          className={metronomeEnabled ? "is-active" : ""}
          aria-pressed={metronomeEnabled}
          onClick={() => handlers.setMetronome({ enabled: !metronomeEnabled })}
        >
          {t("networkSession.mix.metronome")}
        </button>
        <RemoteFader
          label={t("networkSession.mix.metronomeVolume")}
          gain={metronomeVolume}
          scale={AUX_FADER_SCALE}
          // The host stores the metronome in its settings file: only the
          // value the fader rests on is sent, not a stream of disk writes.
          onLive={() => {}}
          onCommit={(volume) => handlers.setMetronome({ volume })}
        />
      </section>

      <ul className="lt-guest-mix-tracks">
        {tracks.map((track) => (
          <li key={track.id} className="lt-guest-mix-row">
            <button
              type="button"
              className={track.muted ? "is-active is-mute" : ""}
              aria-pressed={track.muted}
              aria-label={t("networkSession.mix.mute", { name: track.name })}
              onClick={() => handlers.setTrackMix(track.id, { muted: !track.muted }, false)}
            >
              M
            </button>
            <button
              type="button"
              className={track.solo ? "is-active is-solo" : ""}
              aria-pressed={track.solo}
              aria-label={t("networkSession.mix.solo", { name: track.name })}
              onClick={() => handlers.setTrackMix(track.id, { solo: !track.solo }, false)}
            >
              S
            </button>
            <RemoteFader
              label={track.name}
              gain={track.volume}
              scale={TRACK_FADER_SCALE}
              onLive={(volume) => handlers.setTrackMix(track.id, { volume }, true)}
              onCommit={(volume) => handlers.setTrackMix(track.id, { volume }, false)}
            />
          </li>
        ))}
      </ul>
    </aside>
  );
}
