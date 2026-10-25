import {
  memo,
  useMemo,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import type { SongRegionSummary } from "@libretracks/shared/models";

import { isMobileApp } from "../desktopApi";
import { openSongAnalysis } from "../songAnalysis/songAnalysisStore";
import type {
  PerformanceBindings,
  SongViewBindings,
} from "../songs/songViewBindings";
import { useTransportStore } from "../store";
import { formatBars } from "../structure/structureEditor";
import { useTouchContextMenu } from "../timeline/useTouchContextMenu";
import { useTimelineUIStore } from "../uiStore";
import {
  barSecondsAtFor,
  blockIdForMarker,
  buildSongMapBlocks,
  type SongMapBlock,
} from "./songMapModel";
import { createSongTimeScale } from "./songTimeScale";
import { useSongMapPlayback } from "./useSongMapPlayback";
import type { SetlistLayoutClass } from "./useSetlistLayout";

type SongMapProps = Pick<
  PerformanceBindings,
  | "song"
  | "positionSecondsRef"
  | "pendingMarkerId"
  | "activeVamp"
  | "onMarkerAction"
  | "onCancelPendingJump"
  | "onToggleVamp"
> &
  Pick<SongViewBindings, "onCueSong" | "onPlaySong" | "onSectionContextMenu"> & {
    region: SongRegionSummary;
    layout: SetlistLayoutClass;
    /** Edit mode: a tap selects the section instead of jumping. */
    editing?: boolean;
    /** The arrangement picker, next to the loop button. */
    arrangementPicker?: ReactNode;
  };

const VAMP_MATCH_SECONDS = 0.05;

/**
 * The song map, Playback-style: one coloured block per section of the shown
 * song, width proportional to its length, the active one with its own
 * progress. Tapping a block schedules the jump (the same primary action as
 * Live); tapping the pending one cancels it; the loop button vamps the
 * current section. The menu is the DAW's section menu.
 */
function SongMapComponent({
  song,
  region,
  layout,
  positionSecondsRef,
  pendingMarkerId,
  activeVamp,
  onMarkerAction,
  onCancelPendingJump,
  onToggleVamp,
  onCueSong,
  onPlaySong,
  onSectionContextMenu,
  editing = false,
  arrangementPicker,
}: SongMapProps) {
  const { t } = useTranslation();
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const touchMenu = useTouchContextMenu();
  // The project's marker selection, the same one the DAW ruler uses.
  const selectSection = useTimelineUIStore((state) => state.selectSection);
  const selectedSectionId = useTimelineUIStore((state) => state.selectedSectionId);
  const { blocks, notches } = useMemo(
    () =>
      buildSongMapBlocks(region, song.sectionMarkers, barSecondsAtFor(song), {
        start: t("transport.structure.implicitStart"),
      }),
    [region, song, t],
  );
  const { activeId, nextId } = useSongMapPlayback(blocks, positionSecondsRef, fillRef);
  const pendingBlockId = blockIdForMarker(blocks, pendingMarkerId);
  const loopingBlockId = activeVamp
    ? (blocks.find(
        (block) => Math.abs(block.startSeconds - activeVamp.startSeconds) < VAMP_MATCH_SECONDS,
      )?.id ?? null)
    : null;
  const nextBlock = blocks.find((block) => block.id === nextId) ?? null;
  const isEmpty = blocks.length === 1 && blocks[0].kind === "song";
  // The blocks sit over the song's waveform and must line up with it
  // exactly: percent positions through the view's one time scale.
  const percent = createSongTimeScale({
    startSeconds: region.startSeconds,
    endSeconds: region.endSeconds,
    widthPx: 100,
  });

  const activate = (block: SongMapBlock) => {
    if (editing) {
      // Editing: tapping only selects, so nothing jumps by accident.
      selectSection(block.marker?.id ?? null);
      return;
    }
    if (block.id === pendingBlockId) {
      onCancelPendingJump();
      return;
    }
    if (block.marker) {
      onMarkerAction(block.marker);
      return;
    }
    // The implicit start / whole-song block has no marker: it goes to the
    // song's start (a song jump while sounding, a cue while stopped).
    const playing = useTransportStore.getState().playback?.playbackState === "playing";
    if (playing) onPlaySong(region.id, region.name);
    else onCueSong(region.id);
  };

  const openMenu = (event: ReactMouseEvent<HTMLElement>, block: SongMapBlock) => {
    if (!block.marker) return;
    event.preventDefault();
    event.stopPropagation();
    onSectionContextMenu(event, block.marker.id);
  };

  return (
    <div className={`lt-setlist-map is-${layout}${editing ? " is-editing" : ""}`}>
      <div
        className="lt-setlist-map-blocks"
        role="list"
        aria-label={t("setlistView.map.label", { name: region.name })}
        onPointerDownCapture={isMobileApp ? touchMenu.begin : undefined}
        onPointerMoveCapture={isMobileApp ? touchMenu.move : undefined}
        onPointerUpCapture={isMobileApp ? touchMenu.cancel : undefined}
        onPointerCancelCapture={isMobileApp ? touchMenu.cancel : undefined}
        onClickCapture={
          isMobileApp
            ? (event) => {
                if (touchMenu.consumeTriggered()) {
                  event.stopPropagation();
                  event.preventDefault();
                }
              }
            : undefined
        }
      >
        {blocks.map((block) => {
          const isActive = block.id === activeId;
          const className = [
            "lt-setlist-map-block",
            `is-${block.kind}`,
            isActive ? "is-active" : "",
            block.id === nextId ? "is-next" : "",
            block.id === pendingBlockId ? "is-pending" : "",
            block.id === loopingBlockId ? "is-looping" : "",
            editing && block.marker && block.marker.id === selectedSectionId ? "is-selected" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={block.id}
              type="button"
              role="listitem"
              className={className}
              data-block-id={block.id}
              style={
                {
                  "--lt-setlist-block-color": block.color ?? undefined,
                  left: `${percent.secondsToPx(block.startSeconds)}%`,
                  width: `${percent.secondsToPx(block.endSeconds) - percent.secondsToPx(block.startSeconds)}%`,
                } as CSSProperties
              }
              aria-current={isActive ? "true" : undefined}
              title={block.label}
              onClick={() => activate(block)}
              onContextMenu={(event) => openMenu(event, block)}
            >
              {/* The label strip is the only part that takes clicks: the rest
                  of the block lets them through to the waveform (seek). */}
              <span className="lt-setlist-map-label">
                {block.digit !== null ? (
                  <span className="lt-setlist-map-digit">{block.digit}</span>
                ) : null}
                <span className="lt-setlist-map-name">{block.label}</span>
                {layout !== "short" ? (
                  <span className="lt-setlist-map-bars">{formatBars(block.bars, t)}</span>
                ) : null}
                {block.id === pendingBlockId ? (
                  <span className="lt-setlist-map-flag">{t("setlistView.map.pending")}</span>
                ) : null}
              </span>
              {isActive ? (
                <span className="lt-setlist-map-progress" aria-hidden="true">
                  <span ref={fillRef} className="lt-setlist-map-progress-fill" />
                </span>
              ) : null}
            </button>
          );
        })}
        {/* Lone cues; while editing, the edit layer draws them as handles. */}
        {editing ? null : notches.map((notch) => (
          <span
            key={notch.marker.id}
            className="lt-setlist-map-notch"
            style={{ left: `${percent.secondsToPx(notch.marker.startSeconds)}%` }}
            title={notch.marker.name}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="lt-setlist-map-actions">
        {arrangementPicker}
        <button
          type="button"
          className={`lt-setlist-map-action${activeVamp ? " is-active" : ""}`}
          aria-pressed={Boolean(activeVamp)}
          onClick={onToggleVamp}
        >
          <span className="material-symbols-outlined" aria-hidden="true">repeat</span>
          <span>{t("setlistView.map.loop")}</span>
        </button>
        {layout === "short" && nextBlock?.marker ? (
          <button
            type="button"
            className="lt-setlist-map-action"
            onClick={() => activate(nextBlock)}
          >
            <span>{t("setlistView.map.next", { name: nextBlock.label })}</span>
            <span className="material-symbols-outlined" aria-hidden="true">
              chevron_right
            </span>
          </button>
        ) : null}
        {isEmpty ? (
          <span className="lt-setlist-map-hint">
            {t("setlistView.map.noSections")}
            {FEATURE_FLAGS.songAnalysis ? (
              <button
                type="button"
                className="lt-setlist-map-action"
                onClick={() =>
                  openSongAnalysis({ regionId: region.id, regionName: region.name })
                }
              >
                {t("transport.menu.analyzeSong")}
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export const SongMap = memo(SongMapComponent);
