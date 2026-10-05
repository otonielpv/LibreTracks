import type { MouseEvent as ReactMouseEvent } from "react";

import { promptDialog } from "../../../shared/dialog/dialogService";
import { deleteTrack, isMobileApp, updateTrack } from "../desktopApi";
import type { TrackSummary, VideoClipSummary, VideoFit } from "@libretracks/shared/models";
import type { ContextMenuAction } from "../types";
import type { VideoClipHandlers } from "../video/videoClipHandlers";
import type { TimelineMenuDeps } from "./timelineMenus";

/**
 * Context menus for the video feature: the clip menu and the video-track
 * menu. Split out of timelineMenus.ts (size budget), like midiMenus.ts. A
 * video track shares nothing with an audio track's menu: no mix, no folder
 * nesting, no clips-per-song warnings.
 */
export function createVideoMenus(
  getDeps: () => TimelineMenuDeps,
  openColorMenu: (
    title: string,
    initialColor: string | null | undefined,
    onApply: (color: string | null) => Promise<void>,
  ) => void,
) {
  const handlers = (): VideoClipHandlers | null => getDeps().videoHandlers ?? null;

  function videoClipContextMenu(clip: VideoClipSummary): ContextMenuAction[] {
    const d = getDeps();
    const { t } = d;
    const video = handlers();
    if (!video) return [];
    const fitOption = (fit: VideoFit | null, labelKey: string): ContextMenuAction => ({
      label: `${t("transport.video.menu.fit")}: ${t(labelKey)}${
        (clip.fit ?? null) === fit ? "  ✓" : ""
      }`,
      onSelect: () => video.setFit(clip.id, fit),
    });
    return [
      {
        label: t("transport.video.menu.split"),
        shortcut: d.shortcutHint("edit.splitClip"),
        onSelect: async () => {
          await video.splitSelectedAt(d.displayPositionSecondsRef.current);
        },
      },
      {
        label: t("transport.video.menu.duplicate"),
        shortcut: d.shortcutHint("edit.duplicate"),
        onSelect: () => video.duplicateClips([clip.id]),
      },
      fitOption(null, "transport.video.menu.fitInherit"),
      fitOption("contain", "transport.video.menu.fitContain"),
      fitOption("cover", "transport.video.menu.fitCover"),
      fitOption("stretch", "transport.video.menu.fitStretch"),
      {
        label: t("transport.video.menu.resetFades"),
        disabled: !clip.fadeInSeconds && !clip.fadeOutSeconds,
        onSelect: () => video.setFades(clip.id, 0, 0),
      },
      {
        label: t("transport.video.menu.color"),
        onSelect: () =>
          openColorMenu(t("transport.video.menu.color"), clip.color, async (color) => {
            video.setColor(clip.id, color);
          }),
      },
      // Decoding a video's sound needs libmpv: not on a phone (paso 09 §2).
      ...(video.clipHasAudio(clip) && !isMobileApp
        ? [
            {
              label: t("transport.video.menu.extractAudio"),
              onSelect: () => video.extractAudio(clip.id),
            },
          ]
        : []),
      ...(d.videoExtraClipActions?.(clip) ?? []),
      {
        label: t("transport.video.menu.delete"),
        shortcut: d.shortcutHint("edit.delete"),
        onSelect: () => video.deleteClips([clip.id]),
      },
    ];
  }

  function openVideoClipMenu(event: ReactMouseEvent<HTMLElement>, clip: VideoClipSummary) {
    const d = getDeps();
    const actions = videoClipContextMenu(clip);
    if (!actions.length) return;
    d.setContextMenu({
      x: event.clientX,
      y: event.clientY,
      title: clip.filePath.split(/[\\/]/).pop() ?? clip.filePath,
      actions,
    });
  }

  function videoTrackContextMenu(track: TrackSummary): ContextMenuAction[] {
    const d = getDeps();
    const { t } = d;
    const video = handlers();
    return [
      // Phone: copy a video from the device onto this track at the playhead
      // (plan video-mobile, paso 08 §3).
      ...(isMobileApp && video
        ? [
            {
              label: t("transport.video.addFromDevice"),
              onSelect: () =>
                video.addVideosFromDevice({
                  seconds: d.displayPositionSecondsRef.current,
                  trackId: track.id,
                }),
            },
          ]
        : []),
      ...(video
        ? [
            {
              label: t("transport.video.addTrack"),
              onSelect: () => video.addVideoTrack(track.id),
            },
          ]
        : []),
      {
        label: t("common.rename"),
        shortcut: d.shortcutHint("edit.rename"),
        onSelect: async () => {
          const nextName = (
            await promptDialog(t("transport.prompt.trackRename"), track.name)
          )?.trim();
          if (!nextName) return;
          await d.runAction(async () => {
            d.applyPlaybackSnapshot(await updateTrack({ trackId: track.id, name: nextName }));
            d.setStatus(t("transport.status.trackRenamed", { name: nextName }));
          });
        },
      },
      {
        label: t("transport.menu.selectColor"),
        swatch: track.color ?? undefined,
        onSelect: () =>
          openColorMenu(t("transport.menu.colorOf", { name: track.name }), track.color, (color) =>
            d.handleSetTrackColor(track, color).then(() => undefined),
          ),
      },
      {
        label: t("common.delete"),
        onSelect: async () => {
          await d.runAction(async () => {
            const nextSnapshot = await deleteTrack(track.id);
            d.optimisticallyAppliedRevisionsRef.current.add(nextSnapshot.projectRevision);
            d.applyPlaybackSnapshot(nextSnapshot);
            await d.refreshSongView({ includeWaveforms: false });
            d.setStatus(t("transport.status.trackDeleted", { name: track.name }));
          });
        },
      },
    ];
  }

  return { videoClipContextMenu, openVideoClipMenu, videoTrackContextMenu };
}
