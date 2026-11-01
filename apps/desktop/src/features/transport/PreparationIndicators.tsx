import { memo } from "react";
import { useTranslation } from "react-i18next";

import {
  selectAudioPreparationUiState,
  usePreparationStatusStore,
} from "./preparationStatusStore";

/**
 * «Preparando audio…» y la línea de estado (aviso de audio transpuesto o
 * `status`). Se suscribe sola al store para que el progreso, que cambia cada
 * pocos cientos de ms durante minutos, no re-renderice TransportPanelContent.
 */
export const PreparationIndicators = memo(function PreparationIndicators({
  status,
}: {
  status: string;
}) {
  const { t } = useTranslation();
  const audioPreparationUiState = usePreparationStatusStore(
    selectAudioPreparationUiState,
  );
  const pitchPrepareUiState = usePreparationStatusStore((state) => state.pitch);

  return (
    <>
      {audioPreparationUiState.active ? (
        <div
          className="lt-source-prep-indicator"
          aria-live="polite"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(audioPreparationUiState.percent)}
        >
          <div className="lt-source-prep-line">
            <span className="lt-source-prep-label">
              {t("transport.status.preparingAudio")}
            </span>
            <span className="lt-source-prep-detail">
              {t("transport.status.tracksReady", {
                ready: audioPreparationUiState.readyCount,
                total: audioPreparationUiState.total,
              })}{" "}
              {Math.round(audioPreparationUiState.percent)}%
            </span>
          </div>
          <div className="lt-source-prep-bar">
            <span
              style={{
                width: `${Math.max(0, Math.min(100, audioPreparationUiState.percent))}%`,
              }}
            />
          </div>
          {audioPreparationUiState.failedCount > 0 ? (
            <span className="lt-source-prep-failed">
              {t("transport.status.sourcesFailed", {
                count: audioPreparationUiState.failedCount,
              })}
            </span>
          ) : null}
        </div>
      ) : null}

      {pitchPrepareUiState.active || status !== "" ? (
        <div className="lt-status-overlay" aria-live="polite">
          <span>
            {pitchPrepareUiState.active
              ? `${pitchPrepareUiState.message}${
                  pitchPrepareUiState.error
                    ? `: ${pitchPrepareUiState.error}`
                    : ""
                }`
              : status}
          </span>
        </div>
      ) : null}
    </>
  );
});
