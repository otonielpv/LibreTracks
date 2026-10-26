import { memo, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  SongRegionSummary,
  SongView,
  TrackSummary,
  VideoClipSummary,
  WaveformSummaryDto,
} from "@libretracks/shared/models";

import { isMobileApp } from "../desktopApi";
import { formatMusicalPosition } from "../helpers";
import type { ShortcutActionId } from "../keyboard/actions";
import type { TimelineMenus } from "../menus/timelineMenus";
import type { VideoLaneBindings } from "../video/VideoClipHotspots";
import { addVideoAt } from "./addVideo";
import { sectionAt } from "./lanes/automationLaneModel";
import { SongScrubView } from "./SongScrubView";
import type { SetlistLayoutClass } from "./useSetlistLayout";

type SetlistVideoPanelProps = {
  song: SongView;
  region: SongRegionSummary;
  tracks: TrackSummary[];
  layout: SetlistLayoutClass;
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  positionSecondsRef: { readonly current: number };
  onSeek: (seconds: number) => void;
  runShortcutAction: (action: ShortcutActionId) => void;
  menus: Pick<TimelineMenus, "openMenu" | "trackContextMenu">;
  /** The video feature (absent: no video in this build). */
  video?: VideoLaneBindings;
};

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The song's video clips in time order. */
export function songVideoClips(song: SongView, region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">) {
  return (song.videoClips ?? [])
    .filter((clip) => clip.timelineStartSeconds < region.endSeconds && clip.timelineStartSeconds + clip.durationSeconds > region.startSeconds)
    .sort((left, right) => left.timelineStartSeconds - right.timelineStartSeconds);
}

/**
 * Edit → Video: the song's waveform (SongScrubView) with each video clip as
 * a bar where it plays, the video tracks on top (their DAW menu: rename,
 * colour, delete…) and «+ Video» at the line. Every action is the DAW's
 * video feature: a phone copies from its gallery or its files, the desktop
 * opens the file picker (with the «extract the audio?» question). Tapping a
 * clip opens its menu. Before this the phone had no way to add video.
 */
function SetlistVideoPanelComponent({
  song,
  region,
  tracks,
  layout,
  waveformSummaries,
  positionSecondsRef,
  onSeek,
  runShortcutAction,
  menus,
  video,
}: SetlistVideoPanelProps) {
  const { t } = useTranslation();
  const videoTracks = tracks.filter((track) => track.kind === "video");
  const clips = songVideoClips(song, region);
  const readOnly = !video || video.readOnly;
  const rowOf = (id: string) => Math.max(0, videoTracks.findIndex((track) => track.id === id));
  const trackName = (id: string) => tracks.find((track) => track.id === id)?.name ?? "";

  const add = (event: ReactMouseEvent<HTMLElement>, seconds: number) => {
    if (!video) return;
    if (!isMobileApp) {
      addVideoAt(video, tracks, seconds);
      return;
    }
    menus.openMenu(event, t("setlistView.video.add"), [
      { label: t("transport.video.addFromGallery"), onSelect: () => addVideoAt(video, tracks, seconds, { source: "gallery" }) },
      { label: t("transport.video.addFromFiles"), onSelect: () => addVideoAt(video, tracks, seconds, { source: "files" }) },
    ]);
  };

  const bar = (clip: VideoClipSummary, x: number, width: number) => (
    <button
      key={clip.id}
      type="button"
      className={`lt-setlist-scrub-video${clip.isMissing ? " is-missing" : ""}`}
      style={{ left: `${x}px`, width: `${Math.max(24, width)}px`, "--lt-video-row": rowOf(clip.trackId) } as CSSProperties}
      title={`${trackName(clip.trackId)}: ${fileName(clip.filePath)}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => video?.onContextMenu(event, clip)}
      onContextMenu={(event) => {
        event.preventDefault();
        video?.onContextMenu(event, clip);
      }}
    >
      <span className="material-symbols-outlined" aria-hidden="true">movie</span>
      {fileName(clip.filePath)}
    </button>
  );

  return (
    <div className={`lt-setlist-automation lt-setlist-video is-${layout}`}>
      <div className="lt-setlist-track-bar" role="toolbar" aria-label={t("setlistView.video.tracks")}>
        {videoTracks.map((track) => (
          <span key={track.id} className="lt-setlist-track-chip">
            <span className="lt-setlist-track-chip-name" title={track.name}>{track.name}</span>
            <button
              type="button"
              className="lt-setlist-track-chip-icon material-symbols-outlined"
              aria-label={t("setlistView.sections.menu", { name: track.name })}
              title={t("setlistView.sections.menu", { name: track.name })}
              onClick={(event) => menus.openMenu(event, track.name, menus.trackContextMenu(track))}
            >
              more_vert
            </button>
          </span>
        ))}
        {video && !readOnly ? (
          <button
            type="button"
            className="lt-setlist-settings-button"
            aria-label={t("transport.video.addTrack")}
            title={t("transport.video.addTrack")}
            onClick={() => video.handlers.addVideoTrack(videoTracks.at(-1)?.id ?? null)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
            {videoTracks.length === 0 ? t("transport.video.addTrack") : null}
          </button>
        ) : null}
      </div>
      <SongScrubView
        song={song}
        region={region}
        waveformSummaries={waveformSummaries}
        positionSecondsRef={positionSecondsRef}
        onSeek={onSeek}
        runShortcutAction={runShortcutAction}
        overlay={({ xOf, pxPerSecond }) => clips.map((clip) => bar(clip, xOf(clip.timelineStartSeconds), clip.durationSeconds * pxPerSecond))}
        actions={({ cursorSeconds }) =>
          readOnly ? null : (
            <button
              type="button"
              className="lt-setlist-settings-button is-primary"
              aria-haspopup={isMobileApp ? "menu" : undefined}
              aria-label={t("setlistView.video.addHere")}
              title={t("setlistView.video.addHere")}
              onClick={(event) => add(event, cursorSeconds())}
            >
              <span className="material-symbols-outlined" aria-hidden="true">movie</span>
              {t("setlistView.video.addShort")}
            </button>
          )
        }
      />
      {!video ? <p className="lt-setlist-sections-hint">{t("setlistView.video.unavailable")}</p> : null}
      {video && clips.length === 0 ? <p className="lt-setlist-sections-hint">{t("setlistView.video.empty")}</p> : null}
      <ul className="lt-setlist-automation-list" aria-label={t("setlistView.video.list")}>
        {clips.map((clip) => {
          const section = sectionAt(song, region, Math.max(region.startSeconds, clip.timelineStartSeconds));
          return (
            <li key={clip.id} className="lt-setlist-automation-item">
              <span className="material-symbols-outlined lt-setlist-video-icon" aria-hidden="true">movie</span>
              <button type="button" className="lt-setlist-automation-main" onClick={(event) => video?.onContextMenu(event, clip)}>
                <span className="lt-setlist-automation-when">
                  <span className="lt-setlist-sections-position">{formatMusicalPosition(clip.timelineStartSeconds, song)}</span>
                  {section ? <span className="lt-setlist-automation-section">{section.name}</span> : null}
                  <span className="lt-setlist-automation-section">{trackName(clip.trackId)}</span>
                </span>
                <strong className="lt-setlist-automation-name">{fileName(clip.filePath)}</strong>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const SetlistVideoPanel = memo(SetlistVideoPanelComponent);
