import { memo } from "react";
import { useTranslation } from "react-i18next";

import {
  selectAudioPreparationUiState,
  usePreparationStatusStore,
} from "./preparationStatusStore";
import { usePendingPitchStore } from "./tempo/pendingPitchStore";

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
  const canRevertPitch = usePendingPitchStore(
    (state) => state.undo !== null && state.revert !== null,
  );
  // Con porcentaje (y sin error) el aviso de tono es una tarjeta con barra,
  // como «Preparando audio…»; sin él sigue siendo la línea de estado.
  const pitchCard =
    pitchPrepareUiState.active &&
    !pitchPrepareUiState.error &&
    pitchPrepareUiState.percent !== undefined;
  const pitchPercent = Math.max(0, Math.min(100, pitchPrepareUiState.percent ?? 0));

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

      {pitchCard ? (
        <div
          className={`lt-source-prep-indicator lt-pitch-prep-indicator${
            audioPreparationUiState.active ? " is-stacked" : ""
          }`}
          aria-live="polite"
        >
          <div className="lt-source-prep-line">
            <span className="lt-source-prep-label">
              {t("transport.status.preparingTransposedAudio")}
            </span>
            <span className="lt-source-prep-detail">{Math.round(pitchPercent)}%</span>
          </div>
          <div
            className="lt-source-prep-bar"
            role="progressbar"
            aria-label={t("transport.status.preparingTransposedAudio")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pitchPercent)}
          >
            <span style={{ width: `${pitchPercent}%` }} />
          </div>
          {pitchPrepareUiState.prerender && canRevertPitch ? (
            <button
              type="button"
              className="lt-pitch-prep-cancel"
              title={t("transport.status.cancelTransposedAudioHint")}
              onClick={() => usePendingPitchStore.getState().revert?.()}
            >
              {t("transport.status.cancelTransposedAudio")}
            </button>
          ) : null}
        </div>
      ) : null}

      {(pitchPrepareUiState.active && !pitchCard) || status !== "" ? (
        <div className="lt-status-overlay" aria-live="polite">
          <span>
            {pitchPrepareUiState.active && !pitchCard
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
