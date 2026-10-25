import {
  memo,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { SongRegionSummary, SongView, TrackSummary } from "@libretracks/shared/models";

import { resolveMixerRows } from "../compact/CompactMixer";
import { LIBRARY_ASSET_DRAG_MIME } from "../library/dragDrop";
import type { TimelineMenus } from "../menus/timelineMenus";
import type { SongViewBindings } from "../songs/songViewBindings";
import { AUTOMATION_TRACK_ID } from "../library/pendingAudioImports";
import { computeSongTrackContent } from "./songTrackContent";
import type { SetlistLayoutClass } from "./useSetlistLayout";

type SetlistTrackListProps = Pick<
  SongViewBindings,
  | "tracks"
  | "clipsByRegion"
  | "audioRoutingOptions"
  | "selectedTrackIds"
  | "onTrackSelect"
  | "onTrackDragStart"
  | "onTrackContextMenu"
  | "collapsedFolders"
  | "onToggleFolder"
  | "onDropOsFilesIntoSong"
  | "onDropLibraryAssetsIntoSong"
  | "onMoveClipToTrack"
  | "onDeleteClip"
  | "onAddAudioToSong"
> & {
  song: SongView;
  region: SongRegionSummary;
  menus: TimelineMenus;
  layout: SetlistLayoutClass;
};

const DEFAULT_ACCENT = "rgba(186, 202, 197, 0.35)";

/** Drops a clip chip dragged over another audio track's row. */
function trackRowAt(clientX: number, clientY: number): string | null {
  const element = document.elementFromPoint?.(clientX, clientY) as HTMLElement | null;
  const row = element?.closest<HTMLElement>(".lt-setlist-track-row[data-track-id]");
  return row?.dataset.trackKind === "audio" ? (row.dataset.trackId ?? null) : null;
}

/**
 * Edit → Tracks: the song's tracks in the DAW's order and folders, with the
 * clips each one has in THIS song. Everything is the DAW's: selection, the
 * track reorder drag (its "setlist" surface), the track menus, the global
 * «+ track» menu, dropping audio into the song, moving and deleting clips.
 */
function SetlistTrackListComponent({
  tracks,
  clipsByRegion,
  audioRoutingOptions,
  selectedTrackIds,
  onTrackSelect,
  onTrackDragStart,
  onTrackContextMenu,
  collapsedFolders,
  onToggleFolder,
  onDropOsFilesIntoSong,
  onDropLibraryAssetsIntoSong,
  onMoveClipToTrack,
  onDeleteClip,
  onAddAudioToSong,
  song,
  region,
  menus,
  layout,
}: SetlistTrackListProps) {
  const { t } = useTranslation();
  const [expandedTrackId, setExpandedTrackId] = useState<string | null>(null);
  const content = useMemo(
    () => computeSongTrackContent(song, region),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [song.clips, song.midiClips, song.videoClips, song.automationCues, region.startSeconds, region.endSeconds],
  );
  const { tracks: rows, hiddenCountByFolderId } = useMemo(
    () => resolveMixerRows(tracks, content.trackIds, true, collapsedFolders),
    [collapsedFolders, content.trackIds, tracks],
  );
  const clipsByTrack = useMemo(() => {
    const map = new Map<string, NonNullable<SongViewBindings["clipsByRegion"][string]>>();
    for (const clip of clipsByRegion[region.id] ?? []) {
      const list = map.get(clip.trackId) ?? [];
      list.push(clip);
      map.set(clip.trackId, list);
    }
    return map;
  }, [clipsByRegion, region.id]);
  const routeLabel = (value: string) =>
    audioRoutingOptions.find((option) => option.value === value)?.label ?? value;
  const audioTracks = tracks.filter((track) => track.kind === "audio");

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    const types = Array.from(event.dataTransfer.types ?? []);
    if (types.includes(LIBRARY_ASSET_DRAG_MIME)) {
      try {
        const payload = JSON.parse(event.dataTransfer.getData(LIBRARY_ASSET_DRAG_MIME)) as Array<{
          file_path: string;
          durationSeconds?: number;
        }>;
        if (payload.length > 0) {
          onDropLibraryAssetsIntoSong(
            region.id,
            payload.map((item) => ({ filePath: item.file_path, durationSeconds: item.durationSeconds })),
          );
        }
      } catch {
        // Malformed payload: ignore the drop.
      }
      return;
    }
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length > 0) onDropOsFilesIntoSong(region.id, files);
  };

  const beginClipDrag = (event: ReactPointerEvent<HTMLElement>, clipId: string, fromTrackId: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const pointerId = event.pointerId;
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      const target = trackRowAt(upEvent.clientX, upEvent.clientY);
      if (target && target !== fromTrackId) onMoveClipToTrack(clipId, target);
    };
    const cancel = () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  };

  const openClipMenu = (event: ReactMouseEvent<HTMLElement>, clipId: string, clipName: string, trackId: string) => {
    menus.openMenu(event, clipName, [
      ...audioTracks
        .filter((track) => track.id !== trackId)
        .map((track) => ({
          label: t("setlistView.tracks.moveClipTo", { name: track.name }),
          onSelect: () => onMoveClipToTrack(clipId, track.id),
        })),
      { label: t("compactView.deleteClip"), onSelect: () => onDeleteClip(clipId) },
    ]);
  };

  const showRoute = layout === "wide";
  const collapsible = layout === "short";

  return (
    <div
      className={`lt-setlist-tracks is-${layout}`}
      data-region-id={region.id}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="lt-setlist-tracks-toolbar">
        <button type="button" className="lt-setlist-settings-button" onClick={() => onAddAudioToSong(region.id)}>
          <span className="material-symbols-outlined" aria-hidden="true">library_music</span>
          {t("setlistView.tracks.addAudio")}
        </button>
        <button
          type="button"
          className="lt-setlist-settings-button"
          onClick={(event) =>
            menus.openMenu(event, t("setlistView.tracks.addTrack"), menus.globalTrackListContextMenu())
          }
        >
          <span className="material-symbols-outlined" aria-hidden="true">add</span>
          {t("setlistView.tracks.addTrack")}
        </button>
      </div>
      <div className="lt-setlist-tracks-list" role="list" aria-label={t("setlistView.tracks.label", { name: region.name })}>
        {rows.length === 0 ? <p className="lt-setlist-tracks-empty">{t("setlistView.tracks.empty")}</p> : null}
        {rows.map((track: TrackSummary) => {
          const clips = clipsByTrack.get(track.id) ?? [];
          const expanded = !collapsible || expandedTrackId === track.id;
          const isFolder = track.kind === "folder";
          return (
            <div
              key={track.id}
              role="listitem"
              className={`lt-setlist-track-row${selectedTrackIds.includes(track.id) ? " is-selected" : ""}`}
              data-track-id={track.id}
              data-track-kind={track.kind}
              style={
                {
                  "--lt-track-color": track.color ?? DEFAULT_ACCENT,
                  paddingLeft: `${0.4 + track.depth * 1.1}rem`,
                } as CSSProperties
              }
              onContextMenu={(event) => onTrackContextMenu(event, track.id)}
            >
              <div
                className="lt-setlist-track-grip material-symbols-outlined"
                role="button"
                aria-label={t("setlistView.tracks.reorder", { name: track.name })}
                title={t("setlistView.tracks.reorder", { name: track.name })}
                onMouseDown={(event) => onTrackDragStart(event, track.id)}
              >
                drag_indicator
              </div>
              {isFolder ? (
                <button
                  type="button"
                  className="lt-setlist-track-fold"
                  aria-expanded={!collapsedFolders.has(track.id)}
                  aria-label={t("setlistView.tracks.fold", { name: track.name })}
                  title={t("setlistView.tracks.fold", { name: track.name })}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => onToggleFolder(track.id)}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">
                    {collapsedFolders.has(track.id) ? "chevron_right" : "expand_more"}
                  </span>
                </button>
              ) : null}
              <div
                className="lt-setlist-track-name"
                onClick={(event) => {
                  onTrackSelect(track.id, track.name, event);
                  if (collapsible) setExpandedTrackId((current) => (current === track.id ? null : track.id));
                }}
              >
                <span className="lt-setlist-track-swatch" aria-hidden="true" />
                <strong>{track.name}</strong>
                <span className="lt-setlist-track-kind">{t(`setlistView.tracks.kind.${track.kind}`)}</span>
                {isFolder && hiddenCountByFolderId.get(track.id) ? (
                  <span className="lt-setlist-track-hidden">
                    {t("setlistView.tracks.hidden", { count: hiddenCountByFolderId.get(track.id) })}
                  </span>
                ) : null}
              </div>
              {showRoute && !isFolder ? (
                <span className="lt-setlist-track-route">{routeLabel(track.audioTo)}</span>
              ) : null}
              {expanded && clips.length > 0 ? (
                <div className="lt-setlist-track-clips">
                  {clips.map((clip) => (
                    <button
                      key={clip.id}
                      type="button"
                      className="lt-setlist-track-clip"
                      title={clip.clipName}
                      onPointerDown={(event) => beginClipDrag(event, clip.id, track.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openClipMenu(event, clip.id, clip.clipName, track.id);
                      }}
                    >
                      {clip.clipName}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {content.hasAutomation || song.automationTrack ? (
          <div
            role="listitem"
            className="lt-setlist-track-row is-automation"
            data-track-id={AUTOMATION_TRACK_ID}
            data-track-kind="automation"
            onContextMenu={(event) => onTrackContextMenu(event, AUTOMATION_TRACK_ID)}
          >
            <div className="lt-setlist-track-name">
              <span className="lt-setlist-track-swatch" aria-hidden="true" />
              <strong>{t("setlistView.tracks.kind.automation")}</strong>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const SetlistTrackList = memo(SetlistTrackListComponent);
