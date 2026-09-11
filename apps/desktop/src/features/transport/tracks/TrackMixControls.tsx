import { useTranslation } from "react-i18next";

import {
  TRACK_FADER_SCALE,
  formatGainDb,
  gainToPosition,
  positionToGain,
} from "@libretracks/shared/faderScale";

import { AudioRouteCombobox } from "./AudioRouteCombobox";
import { useFineDragRange } from "../timeline/useFineDragRange";
import { useTouchRangeDrag } from "./useTouchRangeDrag";

const PAN_DISPLAY_CENTER_EPSILON = 0.005;
export const PAN_SNAP_TO_CENTER_EPSILON = 0.05;

/** The stored volume is a linear gain (1.0 = unity); the fader is an
 * Ableton-style dB scale. Show the dB readout (0 dB = unity, +10 dB = top). */
export function formatVolumeValue(volume: number): string {
  return `${formatGainDb(volume)} dB`;
}

export function formatPanValue(pan: number): string {
  const clampedPan = Math.max(-1, Math.min(1, pan));
  if (Math.abs(clampedPan) <= PAN_DISPLAY_CENTER_EPSILON) {
    return "C";
  }

  if (clampedPan < 0) {
    return `L ${Math.round(Math.abs(clampedPan) * 100)}`;
  }

  return `R ${Math.round(clampedPan * 100)}`;
}

export type TrackMixControlsProps = {
  /**
   * Pista a la que se le habla. Con varias seleccionadas se le habla a UNA —la
   * de referencia— y los handlers reparten al resto: el volumen y el paneo en
   * relativo (el grupo conserva su equilibrio) y la salida en absoluto. Es lo
   * mismo que pasa al arrastrar el fader de una pista seleccionada.
   */
  trackId: string;
  /** Solo para las etiquetas de accesibilidad. */
  trackName: string;
  /** Ganancia lineal ya resuelta (con la mezcla optimista aplicada). */
  volumeValue: number;
  panValue: number;
  audioTo: string;
  routeOptions: Array<{ value: string; label: string }>;
  onVolumeChange: (trackId: string, nextVolume: number) => void;
  onCommitVolume: (trackId: string) => void;
  onPanChange: (trackId: string, nextPan: number) => void;
  onCommitPan: (trackId: string) => void;
  onAudioToChange: (trackId: string, nextAudioTo: string) => void;
};

/** Volumen, paneo y salida de una pista: la fila de faders de la cabecera. */
export function TrackMixControls({
  trackId,
  trackName,
  volumeValue,
  panValue,
  audioTo,
  routeOptions,
  onVolumeChange,
  onCommitVolume,
  onPanChange,
  onCommitPan,
  onAudioToChange,
}: TrackMixControlsProps) {
  const { t } = useTranslation();
  const volumePosition = gainToPosition(volumeValue, TRACK_FADER_SCALE);
  const volumeFill = `${(volumePosition * 100).toFixed(2)}%`;
  const panFill = `${(((panValue + 1) * 0.5) * 100).toFixed(2)}%`;

  // Hold Shift to fine-drag the volume fader for precise dB tweaks.
  const volumeFineDrag = useFineDragRange({
    value: volumePosition,
    onChange: (position) =>
      onVolumeChange(trackId, positionToGain(position, TRACK_FADER_SCALE)),
    onCommit: () => onCommitVolume(trackId),
  });
  // El dedo no usa el arrastre nativo del `<input type=range>`: ver
  // useTouchRangeDrag. Con raton no cambia nada.
  const volumeTouchDrag = useTouchRangeDrag({
    min: 0,
    max: 1,
    step: 0.001,
    onChange: (position) =>
      onVolumeChange(trackId, positionToGain(position, TRACK_FADER_SCALE)),
    onCommit: () => onCommitVolume(trackId),
  });
  const applyPan = (value: number) =>
    onPanChange(
      trackId,
      Math.abs(value) <= PAN_SNAP_TO_CENTER_EPSILON ? 0 : value,
    );
  const panTouchDrag = useTouchRangeDrag({
    min: -1,
    max: 1,
    step: 0.01,
    onChange: applyPan,
    onCommit: () => onCommitPan(trackId),
  });

  return (
    <div className="lt-track-mix-controls">
      <label className="lt-track-volume">
        <span>
          <span className="lt-track-mix-label">{t("trackHeader.volume")}</span>
          <em className="lt-track-mix-value">
            {formatVolumeValue(volumeValue)}
          </em>
        </span>
        <input
          aria-label={t("trackHeader.volumeAria", { name: trackName })}
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={volumePosition}
          style={{
            background: `linear-gradient(to right, #3cddc7 ${volumeFill}, #0e0e0e ${volumeFill})`,
          }}
          onChange={volumeFineDrag.handleChange}
          onPointerDown={(event) => {
            volumeFineDrag.handlePointerDown();
            volumeTouchDrag(event);
          }}
          onDoubleClick={(event) => {
            // Reset to unity (0 dB), the way Reaper resets a fader.
            event.stopPropagation();
            onVolumeChange(trackId, 1.0);
            onCommitVolume(trackId);
          }}
          onMouseUp={() => {
            volumeFineDrag.handleCommit();
          }}
          onTouchEnd={() => {
            volumeFineDrag.handleCommit();
          }}
          onKeyUp={(event) => {
            if (
              event.key.startsWith("Arrow") ||
              event.key === "Home" ||
              event.key === "End"
            ) {
              onCommitVolume(trackId);
            }
          }}
          onBlur={() => {
            onCommitVolume(trackId);
          }}
        />
      </label>
      <label className="lt-track-pan">
        <span>
          <span className="lt-track-mix-label">
            {t("trackHeader.pan", { defaultValue: "Pan" })}
          </span>
          <em className="lt-track-mix-value">{formatPanValue(panValue)}</em>
        </span>
        <input
          aria-label={t("trackHeader.panAria", { name: trackName })}
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={panValue}
          style={{
            background: `linear-gradient(to right, #4d79d8 0%, #74b8ff ${panFill}, #0e0e0e ${panFill}, #0e0e0e 100%)`,
          }}
          onChange={(event) => applyPan(Number(event.target.value))}
          onPointerDown={panTouchDrag}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onPanChange(trackId, 0);
            onCommitPan(trackId);
          }}
          onMouseUp={() => {
            onCommitPan(trackId);
          }}
          onTouchEnd={() => {
            onCommitPan(trackId);
          }}
          onKeyUp={(event) => {
            if (
              event.key.startsWith("Arrow") ||
              event.key === "Home" ||
              event.key === "End"
            ) {
              onCommitPan(trackId);
            }
          }}
          onBlur={() => {
            onCommitPan(trackId);
          }}
        />
      </label>
      <label className="lt-track-audio-to">
        <span>{t("trackHeader.audioTo", { defaultValue: "Audio To" })}</span>
        <AudioRouteCombobox
          value={audioTo}
          options={routeOptions}
          ariaLabel={t("trackHeader.audioToAria", {
            name: trackName,
            defaultValue: `Audio To ${trackName}`,
          })}
          onChange={(next) => onAudioToChange(trackId, next)}
        />
      </label>
    </div>
  );
}
