import { useTranslation } from "react-i18next";

import {
  MAX_CAPO,
  MAX_PERSONAL_TRANSPOSE,
  type AccidentalPreference,
  type ChordPrefs,
} from "@libretracks/shared/charts/personalChords";

/**
 * How THIS musician reads the chords of the host's song, on this device:
 * capo, own key and sharps/flats (network-session guests, plan step 07).
 * Shown inside the lyrics panel; nothing here reaches the host.
 */
export function PersonalChordsBar({
  prefs,
  accidentals,
  onPrefsChange,
  onAccidentalsChange,
}: {
  prefs: ChordPrefs;
  accidentals: AccidentalPreference;
  onPrefsChange: (prefs: ChordPrefs) => void;
  onAccidentalsChange: (accidentals: AccidentalPreference) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="lt-personal-chords" role="group" aria-label={t("networkSession.guest.chords")}>
      <Stepper
        label={t("networkSession.guest.capo")}
        value={prefs.capo}
        display={String(prefs.capo)}
        min={0}
        max={MAX_CAPO}
        onChange={(capo) => onPrefsChange({ ...prefs, capo })}
      />
      <Stepper
        label={t("networkSession.guest.transpose")}
        value={prefs.transpose}
        display={prefs.transpose > 0 ? `+${prefs.transpose}` : String(prefs.transpose)}
        min={-MAX_PERSONAL_TRANSPOSE}
        max={MAX_PERSONAL_TRANSPOSE}
        onChange={(transpose) => onPrefsChange({ ...prefs, transpose })}
      />
      <select
        aria-label={t("networkSession.guest.accidentals")}
        value={accidentals}
        onChange={(event) => onAccidentalsChange(event.target.value as AccidentalPreference)}
      >
        {(["auto", "sharps", "flats"] as AccidentalPreference[]).map((value) => (
          <option key={value} value={value}>
            {t(`networkSession.guest.accidental.${value}`)}
          </option>
        ))}
      </select>
    </div>
  );
}

function Stepper({
  label,
  value,
  display,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <span className="lt-personal-chords-stepper">
      <span className="lt-personal-chords-label">{label}</span>
      <button
        type="button"
        aria-label={`${label} −`}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <output aria-label={label}>{display}</output>
      <button
        type="button"
        aria-label={`${label} +`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </span>
  );
}
