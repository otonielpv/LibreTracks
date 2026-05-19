import type { MutableRefObject } from "react";
import type { AppSettings, SongView, TransportSnapshot } from "@libretracks/shared/models";
import {
  cancelMarkerJump,
  scheduleMarkerJump,
  scheduleRegionJump,
  toggleVamp,
} from "../desktopApi";

type UseTimelineActionsProps = {
  appSettings: AppSettings;
  song: SongView | null;
  snapshotRef: MutableRefObject<TransportSnapshot | null>;
  displayPositionSecondsRef: MutableRefObject<number>;
  selectedRegionId: string | null;
  setSelectedRegionId: (id: string | null) => void;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  forcePlaybackVisualAnchor?: (snapshot: TransportSnapshot) => void;
  setStatus: (status: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  handleSelectedRegionTransposeChange: (semitones: number) => void;
};

export function useTimelineActions({
  appSettings,
  song,
  snapshotRef,
  displayPositionSecondsRef,
  selectedRegionId,
  setSelectedRegionId,
  applyPlaybackSnapshot,
  forcePlaybackVisualAnchor,
  setStatus,
  t,
  handleSelectedRegionTransposeChange,
}: UseTimelineActionsProps) {
  async function scheduleMarkerJumpWithGlobalMode(
    markerId: string,
    markerName: string,
  ) {
    const trigger = appSettings.globalJumpMode;
    const bars = Math.max(1, Math.floor(appSettings.globalJumpBars));
    const nextSnapshot = await scheduleMarkerJump(markerId);
    applyPlaybackSnapshot(nextSnapshot);
    if (trigger === "immediate") {
      displayPositionSecondsRef.current = nextSnapshot.positionSeconds;
      forcePlaybackVisualAnchor?.(nextSnapshot);
    }

    if (trigger === "next_marker" && !nextSnapshot.pendingMarkerJump) {
      setStatus(t("transport.status.noMarkersAhead"));
      return nextSnapshot;
    }

    setStatus(
      trigger === "immediate"
        ? t("transport.status.jumpImmediate", { name: markerName })
        : trigger === "next_marker"
          ? t("transport.status.jumpNextMarker", { name: markerName })
          : t("transport.status.jumpAfterBars", {
              count: bars,
              name: markerName,
            }),
    );

    return nextSnapshot;
  }

  async function scheduleRegionJumpWithOptions(
    regionId: string,
    regionName: string,
  ) {
    const trigger = appSettings.songJumpTrigger;
    const bars = Math.max(1, Math.floor(appSettings.songJumpBars));
    const transition = appSettings.songTransitionMode;
    const nextSnapshot = await scheduleRegionJump(regionId);
    applyPlaybackSnapshot(nextSnapshot);

    if (trigger === "region_end" && !nextSnapshot.pendingMarkerJump) {
      setStatus(t("transport.status.noSongRegionAtCursor"));
      return nextSnapshot;
    }

    const whenLabel =
      trigger === "immediate"
        ? t("transport.jumpMode.immediate")
        : trigger === "region_end"
          ? t("transport.jumpMode.regionEnd")
          : t("transport.jumpMode.afterBars", { count: bars });
    const howLabel =
      transition === "fade_out"
        ? t("timelineToolbar.songTransitionFadeOut")
        : t("timelineToolbar.songTransitionInstant");

    setStatus(
      t("transport.status.songJumpScheduled", {
        name: regionName,
        when: whenLabel,
        how: howLabel,
      }),
    );

    return nextSnapshot;
  }

  async function handleNextSongClick() {
    if (!song || song.regions.length === 0) {
      return;
    }

    const currentPosition =
      snapshotRef.current?.positionSeconds ??
      displayPositionSecondsRef.current;
    const nextRegion =
      song.regions.find(
        (region) => region.startSeconds > currentPosition + Number.EPSILON,
      ) ?? song.regions[0];

    if (!nextRegion) {
      return;
    }

    await scheduleRegionJumpWithOptions(nextRegion.id, nextRegion.name);
  }

  async function toggleTimelineVamp() {
    const mode = appSettings.vampMode;
    const nextSnapshot = await toggleVamp(
      mode,
      mode === "bars" ? appSettings.vampBars : undefined,
    );
    applyPlaybackSnapshot(nextSnapshot);

    setStatus(
      nextSnapshot.activeVamp
        ? mode === "bars"
          ? t("transport.status.vampBarsEnabled", {
              count: appSettings.vampBars,
            })
          : t("transport.status.vampSectionEnabled")
        : t("transport.status.vampDisabled"),
    );

    return nextSnapshot;
  }

  function handleSelectRegionFromMidi(direction: -1 | 1) {
    const effectSong = song;
    if (!effectSong || effectSong.regions.length === 0) {
      return;
    }

    const orderedRegions = [...effectSong.regions].sort(
      (left, right) => left.startSeconds - right.startSeconds,
    );
    const currentIndex = orderedRegions.findIndex(
      (region) => region.id === selectedRegionId,
    );
    const nextIndex =
      currentIndex === -1
        ? 0
        : Math.max(
            0,
            Math.min(orderedRegions.length - 1, currentIndex + direction),
          );
    const nextRegion = orderedRegions[nextIndex] ?? null;

    if (!nextRegion) {
      return;
    }

    setSelectedRegionId(nextRegion.id);
    setStatus(t("transport.status.regionSelected", { name: nextRegion.name }));
  }

  function handleRegionTransposeFromMidi(
    commandKey:
      | "action:region_transpose_up"
      | "action:region_transpose_down"
      | "action:region_transpose_reset",
  ) {
    if (!song || !selectedRegionId) {
      return;
    }

    const currentRegion =
      song.regions.find((region) => region.id === selectedRegionId) ?? null;
    if (!currentRegion) {
      return;
    }

    const nextTransposeSemitones =
      commandKey === "action:region_transpose_reset"
        ? 0
        : currentRegion.transposeSemitones +
          (commandKey === "action:region_transpose_up" ? 1 : -1);

    handleSelectedRegionTransposeChange(nextTransposeSemitones);
  }

  async function handleMarkerPrimaryAction(
    markerId: string,
    markerName: string,
    isPendingJumpTarget: boolean,
    onSelectSection: (id: string) => void,
    onClearRegion: () => void,
    onClearContextMenu: () => void,
  ) {
    onSelectSection(markerId);
    onClearRegion();
    onClearContextMenu();

    if (isPendingJumpTarget) {
      const nextSnapshot = await cancelMarkerJump();
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(
        t("transport.status.jumpCancelledSection", { name: markerName }),
      );
      return;
    }

    await scheduleMarkerJumpWithGlobalMode(markerId, markerName);
  }

  return {
    scheduleMarkerJumpWithGlobalMode,
    scheduleRegionJumpWithOptions,
    handleNextSongClick,
    toggleTimelineVamp,
    handleSelectRegionFromMidi,
    handleRegionTransposeFromMidi,
    handleMarkerPrimaryAction,
  };
}
