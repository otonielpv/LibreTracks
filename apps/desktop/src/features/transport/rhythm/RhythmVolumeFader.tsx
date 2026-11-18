// Fader de volumen del panel Ritmo con el estilo de consola de toda la app
// (faders.css) y la misma escala en dB que las pistas: 0 dB a 3/4 del
// recorrido, +10 dB arriba, −∞ abajo, imán en 0 dB y doble clic para volver.
//
// Trabaja en dB: el loop guarda ganancia lineal y los pads y sonidos del kit
// guardan dB, así que cada llamador convierte en su lado.
import {
  DB_FLOOR,
  TRACK_FADER_SCALE,
  dbToPosition,
  formatDb,
  positionToDb,
  snapPositionToUnity,
} from "@libretracks/shared/faderScale";

export const RHYTHM_FADER_SCALE = TRACK_FADER_SCALE;

/** dB de una posición del fader; el fondo se guarda como DB_FLOOR (el JSON no
 *  admite −∞) y se sigue leyendo «-inf». */
export function rhythmFaderDb(position: number): number {
  const db = positionToDb(snapPositionToUnity(position, RHYTHM_FADER_SCALE), RHYTHM_FADER_SCALE);
  return Number.isFinite(db) ? Math.max(DB_FLOOR, db) : DB_FLOOR;
}

type RhythmVolumeFaderProps = {
  db: number;
  ariaLabel: string;
  onChange: (db: number) => void;
  /** Muestra el valor en dB al lado del fader. */
  showReadout?: boolean;
};

export function RhythmVolumeFader({ db, ariaLabel, onChange, showReadout = true }: RhythmVolumeFaderProps) {
  return (
    <span className="lt-rhythm-fader">
      <input
        type="range"
        className="lt-fader is-volume"
        min={0}
        max={1}
        step={0.001}
        value={dbToPosition(db, RHYTHM_FADER_SCALE)}
        aria-label={ariaLabel}
        aria-valuetext={`${formatDb(db)} dB`}
        onChange={(event) => onChange(rhythmFaderDb(Number(event.target.value)))}
        onDoubleClick={() => onChange(0)}
      />
      {showReadout ? <span className="lt-rhythm-fader__value">{formatDb(db)}</span> : null}
    </span>
  );
}
