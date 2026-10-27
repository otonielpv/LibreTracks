import {
  memo,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { TrackSummary } from "@libretracks/shared/models";

import { useTouchContextMenu } from "../timeline/useTouchContextMenu";

/** What a MIDI strip can do: switch the track on/off and edit its routing. */
export type CompactMidiStripHandlers = {
  onToggleEnabled: (trackId: string) => void;
  onEditRoute: (trackId: string) => void;
};

type CompactMidiStripProps = {
  track: TrackSummary;
  handlers: CompactMidiStripHandlers;
  isSelected: boolean;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>, trackId: string) => void;
  onSelect: (trackId: string, trackName: string, event: ReactMouseEvent<HTMLDivElement>) => void;
  onDragStart: (
    event: ReactMouseEvent<HTMLDivElement> | ReactPointerEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
};

/**
 * A MIDI track in the mixer: no volume, pan or audio routing (it sends
 * messages, not sound). Its on/off switch is its mute — the same command as
 * the DAW's MIDI header (`setMidiTrackEnabled`) — and the routing button
 * opens the DAW's routing dialog (port and channel).
 */
function CompactMidiStripComponent({
  track,
  handlers,
  isSelected,
  onContextMenu,
  onSelect,
  onDragStart,
}: CompactMidiStripProps) {
  const { t } = useTranslation();
  const lastTouchPointerDownAtRef = useRef(0);
  const touchMenu = useTouchContextMenu({
    ignoreTarget: (target) =>
      target instanceof Element &&
      target.closest("button, input, select, textarea, [role='slider']") !== null,
  });
  const enabled = track.midiEnabled !== false;
  const port = track.midiPort ?? t("setlistView.midi.defaultPort");
  const channel = t("setlistView.midi.channel", { channel: track.midiChannel ?? 1 });
  const isNameTarget = (target: EventTarget | null) =>
    target instanceof Element && target.closest("[data-strip-noninteractive]") !== null;
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !isNameTarget(event.target)) return;
    if (event.pointerType === "touch") {
      lastTouchPointerDownAtRef.current = Date.now();
    }
    onDragStart(event, track.id);
  };
  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (Date.now() - lastTouchPointerDownAtRef.current < 1000) return;
    if (event.button !== 0 || !isNameTarget(event.target)) return;
    onDragStart(event, track.id);
  };
  return (
    <div
      className={`lt-compact-mixer-strip is-midi${isSelected ? " is-selected" : ""}${enabled ? "" : " is-disabled"}`}
      data-track-id={track.id}
      style={{ "--track-accent": track.color ?? "rgba(186, 202, 197, 0.35)" } as CSSProperties}
      onPointerDown={handlePointerDown}
      onMouseDown={handleMouseDown}
      onPointerDownCapture={touchMenu.begin}
      onPointerMoveCapture={touchMenu.move}
      onPointerUpCapture={touchMenu.cancel}
      onPointerCancelCapture={touchMenu.cancel}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event, track.id);
      }}
    >
      <div
        className="lt-compact-mixer-strip-name"
        title={track.name}
        data-strip-noninteractive=""
        onClick={(event) => {
          if (touchMenu.consumeTriggered()) {
            event.preventDefault();
            return;
          }
          onSelect(track.id, track.name, event);
        }}
      >
        <span className="lt-compact-mixer-strip-name-text">{track.name}</span>
      </div>
      <div className="lt-compact-midi-body">
        <span className="material-symbols-outlined lt-compact-midi-icon" aria-hidden="true">piano</span>
        <button
          type="button"
          className={`lt-compact-midi-power${enabled ? " is-active" : ""}`}
          aria-pressed={enabled}
          aria-label={t(enabled ? "transport.midi.disableTrack" : "transport.midi.enableTrack")}
          title={t(enabled ? "transport.midi.disableTrack" : "transport.midi.enableTrack")}
          onClick={() => handlers.onToggleEnabled(track.id)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">power_settings_new</span>
        </button>
        <button
          type="button"
          className="lt-compact-midi-route"
          aria-label={t("setlistView.midi.routeAria", { name: track.name, route: `${port} · ${channel}` })}
          title={t("transport.midi.routeModalTitle")}
          onClick={() => handlers.onEditRoute(track.id)}
        >
          <span className="lt-compact-midi-port">{port}</span>
          <span className="lt-compact-midi-channel">{channel}</span>
        </button>
      </div>
    </div>
  );
}

export const CompactMidiStrip = memo(CompactMidiStripComponent);
