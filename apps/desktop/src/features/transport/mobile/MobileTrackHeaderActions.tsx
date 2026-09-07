import { useTranslation } from "react-i18next";
import { MobileTrackReorderToggle } from "../tracks/MobileTrackReorderToggle";
import { TRACK_HEIGHT_STEP } from "../constants";
import { TOUR_TARGETS } from "../../tutorial/tourTargets";

type MobileTrackHeaderActionsProps = {
  trackHeight: number;
  applyTrackHeight: (height: number) => void;
  rulerSeekLocked: boolean;
  toggleRulerSeekLock: () => void;
};

/**
 * Controles táctiles de la columna de cabeceras: reordenar, alto de pista y
 * bloqueo del salto al tocar el ruler. Vivían dentro del monolito como JSX
 * inline; aquí no ganan estado, sólo dejan de engordar `TransportPanelContent`.
 */
export function MobileTrackHeaderActions({
  trackHeight,
  applyTrackHeight,
  rulerSeekLocked,
  toggleRulerSeekLock,
}: MobileTrackHeaderActionsProps) {
  const { t } = useTranslation();
  return (
    <>
      <MobileTrackReorderToggle />
      <span
        className="lt-mobile-track-view-controls"
        data-lt-tour={TOUR_TARGETS.mobileTouchControls}
      >
        <button
          type="button"
          className="lt-icon-button"
          aria-label={t("timelineToolbar.trackHeightDecrease", {
            defaultValue: "Pistas más bajas",
          })}
          onClick={() => applyTrackHeight(trackHeight - TRACK_HEIGHT_STEP)}
        >
          <span className="material-symbols-outlined">unfold_less</span>
        </button>
        <button
          type="button"
          className="lt-icon-button"
          aria-label={t("timelineToolbar.trackHeightIncrease", {
            defaultValue: "Pistas más altas",
          })}
          onClick={() => applyTrackHeight(trackHeight + TRACK_HEIGHT_STEP)}
        >
          <span className="material-symbols-outlined">unfold_more</span>
        </button>
        <button
          type="button"
          className={`lt-icon-button ${rulerSeekLocked ? "is-active" : ""}`}
          aria-label={t("timelineToolbar.rulerSeekLock", {
            defaultValue: "Bloquear salto al tocar el ruler",
          })}
          aria-pressed={rulerSeekLocked}
          onClick={toggleRulerSeekLock}
        >
          <span className="material-symbols-outlined">
            {rulerSeekLocked ? "lock" : "lock_open"}
          </span>
        </button>
      </span>
    </>
  );
}
