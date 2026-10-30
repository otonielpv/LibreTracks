import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  getMidiControlDiagnostics,
  isTauriApp,
  type MidiControlDiagnostics,
} from "../desktopApi";

/**
 * The counters behind the plan's acceptance criterion (midi-controllers,
 * paso 08): sweep 8 faders during playback, press "Measure" before and
 * after, and the disk writes and lock takes must grow by one per gesture,
 * not one per message.
 */
export function MidiControlDiagnosticsLine() {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<MidiControlDiagnostics | null>(null);
  if (!isTauriApp) {
    return null;
  }
  return (
    <p className="lt-midi-diagnostics">
      <button
        type="button"
        onClick={() => {
          void getMidiControlDiagnostics()
            .then(setCounts)
            .catch(() => undefined);
        }}
      >
        {t("midiMap.diagnosticsMeasure")}
      </button>
      {counts ? (
        <span>
          {t("midiMap.diagnostics", {
            messages: counts.messages,
            writes: counts.settingsDiskWrites,
            locks: counts.sessionLockTakes,
            commits: counts.trackCommits,
          })}
        </span>
      ) : null}
    </p>
  );
}
