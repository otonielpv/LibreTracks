import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * Header for a video track.
 *
 * A video track has no mix: volume, pan, routing and transpose do not apply.
 * It keeps `muted` (the eye: hidden from the output) and `solo` (only this
 * track's pictures are shown) from the track model, which is why it reuses the
 * audio header's mute/solo callbacks — the backend keeps them away from the
 * audio engine.
 */
export type VideoTrackHeaderProps = {
  trackId: string;
  trackName: string;
  trackColor?: string | null;
  trackHeight: number;
  trackDepth: number;
  muted: boolean;
  solo: boolean;
  isSelected: boolean;
  densityClass: string;
  /** Mobile: shown read-only, with the reason. */
  readOnly: boolean;
  onSelectTrack: (
    trackId: string,
    trackName: string,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLDivElement>, trackId: string) => void;
  onStartTrackDrag: (
    event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>,
    trackId: string,
  ) => void;
  onToggleMute: (trackId: string) => void;
  onToggleSolo: (trackId: string) => void;
};

export function VideoTrackHeader({
  trackId,
  trackName,
  trackColor,
  trackHeight,
  trackDepth,
  muted,
  solo,
  isSelected,
  densityClass,
  readOnly,
  onSelectTrack,
  onOpenContextMenu,
  onStartTrackDrag,
  onToggleMute,
  onToggleSolo,
}: VideoTrackHeaderProps) {
  const { t } = useTranslation();
  const lastTouchPointerDownAtRef = useRef(0);

  const headerStyle = {
    height: trackHeight,
    // Sangria de carpeta solo en el nombre (ver `.lt-track-title-row` en
    // styles.css): los controles quedan en columna con el resto de pistas.
    "--lt-track-indent": `${trackDepth * 12}px`,
    ...(trackColor ? { "--lt-track-color": trackColor } : {}),
  } as CSSProperties;

  const startDrag = (event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button")) return;
    onStartTrackDrag(event, trackId);
  };

  return (
    <div
      className={`lt-track-header lt-video-track-header ${densityClass} ${
        isSelected ? "is-selected" : ""
      } ${muted ? "is-video-hidden" : ""} ${readOnly ? "is-read-only" : ""}`}
      style={headerStyle}
      role="button"
      tabIndex={0}
      title={readOnly ? t("transport.video.readOnly") : undefined}
      onPointerDown={(event) => {
        if (event.pointerType === "touch") lastTouchPointerDownAtRef.current = Date.now();
        startDrag(event);
      }}
      onMouseDown={(event) => {
        if (Date.now() - lastTouchPointerDownAtRef.current < 1000) return;
        startDrag(event);
      }}
      onClick={(event) => onSelectTrack(trackId, trackName, event)}
      onContextMenu={(event) => onOpenContextMenu(event, trackId)}
    >
      <div className="lt-track-header-body">
        <div className="lt-video-header-row">
          <span className="material-symbols-outlined lt-video-header-icon" aria-hidden="true">
            movie
          </span>
          <strong className="lt-video-header-name">{trackName}</strong>
          {readOnly ? null : (
            <>
              <button
                type="button"
                className={`lt-video-eye ${muted ? "" : "is-active"}`}
                aria-pressed={!muted}
                aria-label={muted ? t("transport.video.showTrack") : t("transport.video.hideTrack")}
                title={muted ? t("transport.video.showTrack") : t("transport.video.hideTrack")}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleMute(trackId);
                }}
              >
                <span className="material-symbols-outlined">
                  {muted ? "visibility_off" : "visibility"}
                </span>
              </button>
              <button
                type="button"
                className={`lt-track-solo-button lt-video-solo ${solo ? "is-active" : ""}`}
                aria-pressed={solo}
                aria-label={t("transport.video.soloTrack")}
                title={t("transport.video.soloTrack")}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleSolo(trackId);
                }}
              >
                S
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
