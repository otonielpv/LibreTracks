import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";

/**
 * Header for a MIDI track.
 *
 * A MIDI track is NOT an audio track with a different badge: it has no mix to
 * fold into, so volume, pan, mute, solo and transpose are all meaningless on
 * it. What it does have is a destination (port + channel) and a single on/off
 * switch — which is why this is a separate component rather than a pile of
 * conditionals inside the audio header.
 */
export type MidiTrackHeaderProps = {
  trackId: string;
  trackName: string;
  trackColor?: string | null;
  trackHeight: number;
  trackDepth: number;
  midiPort?: string | null;
  midiChannel?: number;
  midiEnabled?: boolean;
  isSelected: boolean;
  isDragging: boolean;
  densityClass: string;
  onSelectTrack: (
    trackId: string,
    trackName: string,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
  onStartTrackDrag: (
    event: ReactMouseEvent<HTMLElement>,
    trackId: string,
  ) => void;
  onToggleEnabled: (trackId: string) => void;
  onEditRoute: (trackId: string) => void;
};

export function MidiTrackHeader({
  trackId,
  trackName,
  trackColor,
  trackHeight,
  trackDepth,
  midiPort,
  midiChannel,
  midiEnabled = true,
  isSelected,
  isDragging,
  densityClass,
  onSelectTrack,
  onOpenContextMenu,
  onStartTrackDrag,
  onToggleEnabled,
  onEditRoute,
}: MidiTrackHeaderProps) {
  const { t } = useTranslation();

  const headerStyle = {
    height: trackHeight,
    paddingLeft: 8 + trackDepth * 12,
    ...(trackColor ? { "--lt-track-color": trackColor } : {}),
  } as CSSProperties;

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button")) {
      return;
    }
    onStartTrackDrag(event, trackId);
  };

  const routeLabel = `${midiPort ?? t("transport.midi.outputDeviceDefault")} · ${t(
    "transport.midi.channelShort",
    { channel: midiChannel ?? 1 },
  )}`;

  return (
    <div
      className={`lt-track-header lt-midi-track-header ${densityClass} ${
        isSelected ? "is-selected" : ""
      } ${isDragging ? "is-dragging" : ""} ${midiEnabled ? "" : "is-midi-off"}`}
      style={headerStyle}
      role="button"
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onClick={(event) => onSelectTrack(trackId, trackName, event)}
      onContextMenu={(event) => onOpenContextMenu(event, trackId)}
    >
      <div className="lt-track-header-body">
        <div className="lt-midi-header-row">
          <button
            type="button"
            className={`lt-midi-power ${midiEnabled ? "is-active" : ""}`}
            aria-pressed={midiEnabled}
            aria-label={
              midiEnabled
                ? t("transport.midi.disableTrack")
                : t("transport.midi.enableTrack")
            }
            title={
              midiEnabled
                ? t("transport.midi.disableTrack")
                : t("transport.midi.enableTrack")
            }
            onClick={(event) => {
              event.stopPropagation();
              onToggleEnabled(trackId);
            }}
          >
            <span className="material-symbols-outlined">power_settings_new</span>
          </button>

          <div className="lt-midi-header-text">
            <strong>{trackName}</strong>
            <button
              type="button"
              className="lt-midi-route-badge"
              aria-label={t("transport.midi.routeAria", { name: trackName })}
              title={routeLabel}
              onClick={(event) => {
                event.stopPropagation();
                onEditRoute(trackId);
              }}
            >
              {routeLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
