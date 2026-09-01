import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { TOUR_TARGETS } from "../../tutorial/tourTargets";

import { densityFromHeight } from "../constants";
import type { TrackRowLayout } from "./trackLayout";
import type { TimelineTrackSummary } from "../library/pendingAudioImports";
import { useSongStore } from "../songStore";
import { TrackHeaderItem } from "./TrackHeaderItem";
import { MidiTrackHeader } from "../midi/MidiTrackHeader";
import { useTouchContextMenu } from "../timeline/useTouchContextMenu";
import { useTimelineUIStore } from "../uiStore";

const TRACK_HEADER_CONTROL_SELECTOR =
  "button, input, label, textarea, select, .lt-track-toggle-group, .lt-track-volume, .lt-track-pan";

/** Grouped so the MIDI/automation lane controls travel as a single prop. */
export type MidiLaneControls = {
  onEditRoute: (trackId: string) => void;
  onToggleMidiEnabled: (trackId: string) => void;
  onToggleAutomationEnabled: (enabled: boolean) => void;
  automationEnabled?: boolean;
};

type LibraryPreviewRow = {
  rowOffset: number;
  title: string;
  meta: string;
};

type TrackHeadersPaneProps = {
  visibleTracks: TimelineTrackSummary[];
  selectedTrackIds: string[];
  trackHeight: number;
  /** Per-row heights, so a track with its own height offset lines up with the
   * lane the canvas painted for it. */
  trackLayout: TrackRowLayout;
  collapsedFolders: Set<string>;
  previewTrackDensityClass: string;
  libraryPreviewRows: LibraryPreviewRow[];
  onHeadersWheel: (event: WheelEvent) => void;
  getTrackChildCount: (trackId: string) => number;
  onSelectTrack: (trackId: string, trackName: string, event: ReactMouseEvent<HTMLDivElement>) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLDivElement>, trackId: string) => void;
  onEmptyAreaContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  /** Clic con el botón izquierdo en el hueco bajo la última cabecera:
   * deselecciona. Es el equivalente del fondo del timeline en esta columna,
   * y en móvil la única salida — allí no hay Escape. */
  onEmptyAreaClick: () => void;
  onStartTrackDrag: (
    event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>,
    trackId: string,
  ) => void;
  onToggleFolder: (trackId: string) => void;
  /** Drag on the row's bottom edge: resizes this track (Alt = every track). */
  onStartRowResize: (trackId: string, event: ReactPointerEvent<HTMLElement>) => void;
  /** Double-click on that edge: back to the global height. */
  onResetRowHeight: (trackId: string) => void;
  onToggleMute: (trackId: string) => void;
  onToggleSolo: (trackId: string) => void;
  onToggleTranspose: (trackId: string) => void;
  onVolumeChange: (trackId: string, nextVolume: number) => void;
  onCommitVolume: (trackId: string) => void;
  onPanChange: (trackId: string, nextPan: number) => void;
  onCommitPan: (trackId: string) => void;
  audioRoutingOptions: Array<{ value: string; label: string }>;
  onAudioToChange: (trackId: string, nextAudioTo: string) => void;
  /** Controls for the non-audio lanes (MIDI tracks + the automation lane). */
  midiLanes?: MidiLaneControls;
  /** Android: the ruler-header cell is mostly empty there, so it hosts the
   * touch controls (track density, seek lock) instead of wasting the space. */
  headerActions?: ReactNode;
};

export function TrackHeadersPane({
  visibleTracks,
  selectedTrackIds,
  trackHeight,
  trackLayout,
  collapsedFolders,
  previewTrackDensityClass,
  libraryPreviewRows,
  onHeadersWheel,
  getTrackChildCount,
  onSelectTrack,
  onOpenContextMenu,
  onEmptyAreaContextMenu,
  onEmptyAreaClick,
  onStartTrackDrag,
  onToggleFolder,
  onStartRowResize,
  onResetRowHeight,
  onToggleMute,
  onToggleSolo,
  onToggleTranspose,
  onVolumeChange,
  onCommitVolume,
  onPanChange,
  onCommitPan,
  audioRoutingOptions,
  onAudioToChange,
  midiLanes,
  headerActions,
}: TrackHeadersPaneProps) {
  const { t } = useTranslation();
  // Narrow selector: this pane only needs to know whether a project is loaded,
  // so it no longer re-renders on every unrelated mutation of `song`.
  const hasSong = useSongStore((state) => state.song !== null);
  const headersListRef = useRef<HTMLDivElement | null>(null);
  const trackReorderMode = useTimelineUIStore(
    (state) => state.trackReorderMode,
  );
  const touchContextMenu = useTouchContextMenu({
    ignoreTarget: (target) =>
      target instanceof Element &&
      target.closest(TRACK_HEADER_CONTROL_SELECTOR) !== null,
  });

  useEffect(() => {
    const headersList = headersListRef.current;
    if (!headersList) {
      return;
    }

    headersList.addEventListener("wheel", onHeadersWheel, { passive: false });
    return () => {
      headersList.removeEventListener("wheel", onHeadersWheel);
    };
  }, [onHeadersWheel]);

  return (
    <div
      className={`lt-track-headers-pane ${trackReorderMode ? "is-track-reorder-mode" : ""}`}
      data-lt-tour={TOUR_TARGETS.trackHeaders}
      onPointerDownCapture={touchContextMenu.begin}
      onPointerMoveCapture={touchContextMenu.move}
      onPointerUpCapture={touchContextMenu.cancel}
      onPointerCancelCapture={touchContextMenu.cancel}
      onClickCapture={(event) => {
        if (touchContextMenu.consumeTriggered()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClick={(event) => {
        // Sólo el hueco vacío: las filas y la celda del ruler (que lleva
        // botones) se quedan con su propio manejo.
        const target = event.target as HTMLElement | null;
        if (
          target?.closest(".lt-track-header-row") ||
          target?.closest(".lt-ruler-header")
        ) {
          return;
        }
        onEmptyAreaClick();
      }}
      onContextMenu={(event) => {
        // Show the global track-list menu when the right-click hits empty
        // space inside the pane (below the last header). Header rows and the
        // ruler header keep their own handling.
        const target = event.target as HTMLElement | null;
        if (
          target?.closest(".lt-track-header-row") ||
          target?.closest(".lt-ruler-header")
        ) {
          return;
        }
        onEmptyAreaContextMenu(event);
      }}
    >
      <div className="lt-ruler-header">
        {headerActions ? (
          <div className="lt-ruler-header-actions">{headerActions}</div>
        ) : null}
        <span>Tracks</span>
      </div>
      <div
        className="lt-track-headers-list"
        aria-hidden={!hasSong}
        ref={headersListRef}
      >
        {hasSong && visibleTracks.map((track) => {
          const automationEnabled = midiLanes?.automationEnabled !== false;
          const isTrackSelected = selectedTrackIds.includes(track.id);
          const childCount = getTrackChildCount(track.id);
          // A track with its own height offset gets its own row height — and
          // its own density, so a single tall track shows the full controls
          // while the collapsed ones around it stay in lane mode.
          const rowHeight = trackLayout.heightOf(track.id);
          const trackDensityClass = densityFromHeight(rowHeight);

          if (track.isAutomation) {
            return (
              <div
                key={track.id}
                className="lt-track-header-row"
                data-track-id={track.id}
                style={{ height: rowHeight }}
              >
                <div
                  className={`lt-track-header lt-midi-track-header ${trackDensityClass} is-automation ${
                    isTrackSelected ? "is-selected" : ""
                  } ${automationEnabled ? "" : "is-midi-off"}`}
                  style={{ height: rowHeight, paddingLeft: 8 }}
                  role="button"
                  tabIndex={0}
                  aria-label={t("transport.automation.trackHeaderAria")}
                  onPointerDown={(event) => onStartTrackDrag(event, track.id)}
                  onMouseDown={(event) => onStartTrackDrag(event, track.id)}
                  onClick={(event) =>
                    onSelectTrack(
                      track.id,
                      t("transport.automation.trackName"),
                      event,
                    )
                  }
                  onContextMenu={(event) => onOpenContextMenu(event, track.id)}
                >
                  <div className="lt-track-header-body">
                    <div className="lt-midi-header-row">
                      {/* Same on/off affordance as a MIDI track: the lane has
                          no mix either, so enable/disable is all it needs. */}
                      <button
                        type="button"
                        className={`lt-midi-power ${automationEnabled ? "is-active" : ""}`}
                        aria-pressed={automationEnabled}
                        aria-label={t(
                          automationEnabled
                            ? "transport.automation.disableTrack"
                            : "transport.automation.enableTrack",
                        )}
                        title={t(
                          automationEnabled
                            ? "transport.automation.disableTrack"
                            : "transport.automation.enableTrack",
                        )}
                        onClick={(event) => {
                          event.stopPropagation();
                          midiLanes?.onToggleAutomationEnabled(!automationEnabled);
                        }}
                      >
                        <span className="material-symbols-outlined">
                          power_settings_new
                        </span>
                      </button>
                      <div className="lt-midi-header-text">
                        <strong>⚙ {t("transport.automation.trackName")}</strong>
                        <span className="lt-track-meta">
                          {t("transport.automation.trackMeta")}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          if (track.isPending) {
            return (
              <div
                key={track.id}
                className="lt-track-header-row"
                data-track-id={track.id}
                style={{ height: rowHeight }}
              >
                <div
                  className={`lt-track-header ${trackDensityClass} is-library-preview`}
                  style={{ height: rowHeight, paddingLeft: 8 + track.depth * 12 }}
                  aria-hidden="true"
                >
                  <div className="lt-track-header-body">
                    <div className="lt-track-header-content">
                      <div className="lt-track-header-summary">
                        <div className="lt-track-header-main">
                          <div className="lt-track-title-row">
                            <strong>{track.name}</strong>
                          </div>
                          <span className="lt-track-meta">Importing audio...</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div
              key={track.id}
              className="lt-track-header-row"
              data-track-id={track.id}
              style={{ height: rowHeight }}
            >
              {track.kind === "midi" ? (
                <MidiTrackHeader
                  trackId={track.id}
                  trackName={track.name}
                  trackColor={track.color}
                  trackHeight={rowHeight}
                  trackDepth={track.depth}
                  midiPort={track.midiPort}
                  midiChannel={track.midiChannel}
                  midiEnabled={track.midiEnabled}
                  isSelected={isTrackSelected}
                  isDragging={false}
                  densityClass={trackDensityClass}
                  onSelectTrack={onSelectTrack}
                  onOpenContextMenu={onOpenContextMenu}
                  onStartTrackDrag={onStartTrackDrag}
                  onToggleEnabled={midiLanes?.onToggleMidiEnabled ?? (() => {})}
                  onEditRoute={midiLanes?.onEditRoute ?? (() => {})}
                />
              ) : (
              <TrackHeaderItem
                trackId={track.id}
                trackName={track.name}
                trackKind={track.kind}
                hasParent={Boolean(track.parentTrackId)}
                trackDepth={track.depth}
                trackColor={track.color}
                childCount={childCount}
                trackHeight={rowHeight}
                panValue={track.pan}
                trackMuted={track.muted}
                trackSolo={track.solo}
                trackTransposeEnabled={track.transposeEnabled}
                volumeValue={track.volume}
                audioTo={track.audioTo}
                audioRoutingOptions={audioRoutingOptions}
                isCollapsed={collapsedFolders.has(track.id)}
                isSelected={isTrackSelected}
                isDropTarget={false}
                dropMode={null}
                isDragging={false}
                densityClass={trackDensityClass}
                onSelectTrack={onSelectTrack}
                onOpenContextMenu={onOpenContextMenu}
                onStartTrackDrag={onStartTrackDrag}
                onToggleFolder={onToggleFolder}
                onToggleMute={onToggleMute}
                onToggleSolo={onToggleSolo}
                onToggleTranspose={onToggleTranspose}
                onVolumeChange={onVolumeChange}
                onCommitVolume={onCommitVolume}
                onPanChange={onPanChange}
                onCommitPan={onCommitPan}
                onAudioToChange={onAudioToChange}
              />
              )}
              {/* Ableton's gesture: drag the row's bottom edge to resize this
                  track (Alt for every track), double-click to go back to the
                  global height. Only real tracks have somewhere to store it. */}
              <div
                className="lt-track-header-resize"
                role="separator"
                aria-orientation="horizontal"
                aria-label={t("trackHeader.resizeRow", {
                  defaultValue: "Ajustar alto de la pista",
                })}
                title={t("trackHeader.resizeRowHint", {
                  defaultValue:
                    "Arrastra para ajustar el alto de la pista (Alt: todas). Doble clic para restablecer.",
                })}
                onPointerDown={(event) => onStartRowResize(track.id, event)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onResetRowHeight(track.id);
                }}
              />
            </div>
          );
        })}

        {libraryPreviewRows.map((previewRow) => (
          <div
            key={`library-preview-row-${previewRow.rowOffset}`}
            className="lt-track-header-row"
            style={{ height: trackHeight }}
          >
            <div
              className={`lt-track-header ${previewTrackDensityClass} is-library-preview`}
              style={{ height: trackHeight, paddingLeft: 8 }}
              aria-hidden="true"
            >
              <div className="lt-track-header-body">
                <div className="lt-track-header-content">
                  <div className="lt-track-header-summary">
                    <div className="lt-track-header-main">
                      <div className="lt-track-title-row">
                        <strong>{previewRow.title}</strong>
                      </div>
                      <span className="lt-track-meta">{previewRow.meta}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
