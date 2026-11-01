/**
 * "Follow the song's tracks" in the DAW: keeps the tracks of the song under the
 * playhead scrolled to the top of the track list. In a session with ten songs
 * of ten tracks each, the next song's tracks come into view on their own
 * instead of the user scrolling down every time.
 *
 * Like the follow-playhead camera, scrolling by hand pauses it: after
 * FOLLOW_CAMERA_MANUAL_PAUSE_MS without touching the scroll it glides back to
 * the current song's tracks.
 *
 * Self-contained so the monolith only calls it. It glides the scroll viewport
 * directly (no setState per frame) and tells its own scrolls from the user's by
 * remembering the scrollTop it last wrote.
 */
import { useEffect, useRef, type RefObject } from "react";

import type { SongView } from "@libretracks/shared/models";

import { FOLLOW_CAMERA_MANUAL_PAUSE_MS } from "../followCamera";
import type { TimelineTrackSummary } from "../library/pendingAudioImports";
import { activeSongTrackIds } from "../midi/midiBankStore";
import type { TrackRowLayout } from "../tracks/trackLayout";
import { useTimelineUIStore } from "../uiStore";

/** How long the glide to a song's tracks takes. */
const GLIDE_MS = 320;
/** A scrollTop this far from the one we wrote was moved by someone else. */
const OWN_SCROLL_TOLERANCE_PX = 2;

/**
 * The scrollTop that puts the song's first visible track right under the
 * sticky ruler header, clamped to what the viewport can scroll. `null` when
 * there is no song under the playhead or none of its tracks is shown.
 *
 * `listOffset` is where the track list starts inside the scrolled content and
 * `stickyHeight` the height of the header that stays pinned over it.
 */
export function songTracksScrollTop({
  song,
  activeRegionId,
  visibleTracks,
  layout,
  listOffset,
  stickyHeight,
  maxScrollTop,
}: {
  song: SongView | null;
  activeRegionId: string | null;
  visibleTracks: readonly TimelineTrackSummary[];
  layout: TrackRowLayout;
  listOffset: number;
  stickyHeight: number;
  maxScrollTop: number;
}): number | null {
  const ids = activeSongTrackIds(song, activeRegionId);
  if (!ids) return null;
  // Visible order, so a collapsed folder stands in for the tracks it hides
  // (activeSongTrackIds includes the folders holding the song's tracks).
  const first = visibleTracks.find((track) => ids.has(track.id));
  const top = first ? layout.topOf(first.id) : null;
  if (top === null) return null;
  const target = listOffset + top - stickyHeight;
  return Math.round(Math.min(Math.max(0, maxScrollTop), Math.max(0, target)));
}

/** Layout distance from the top of `ancestor`'s content to `element`. Uses
 * offsetTop, which ignores scrolling and the CSS scale the phone layout uses. */
function contentOffset(element: HTMLElement, ancestor: HTMLElement): number {
  const layoutTop = (node: HTMLElement) => {
    let top = 0;
    for (let current: HTMLElement | null = node; current; current = current.offsetParent as HTMLElement | null) {
      top += current.offsetTop;
    }
    return top;
  };
  return layoutTop(element) - layoutTop(ancestor) - ancestor.clientTop;
}

export type UseFollowSongTracksOptions = {
  /** False outside the DAW: the other views have no track list to scroll. */
  active: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  layoutRef: RefObject<TrackRowLayout>;
  visibleTracksRef: RefObject<TimelineTrackSummary[]>;
  songRef: RefObject<SongView | null>;
  /** The song under the playhead; "" between songs. */
  activeRegionId: string;
};

export function useFollowSongTracks({
  active,
  viewportRef,
  layoutRef,
  visibleTracksRef,
  songRef,
  activeRegionId,
}: UseFollowSongTracksOptions) {
  const enabled = useTimelineUIStore((state) => state.followSongTracksEnabled);
  const following = active && enabled;
  const activeRegionIdRef = useRef(activeRegionId);
  activeRegionIdRef.current = activeRegionId;
  const pausedUntilRef = useRef(0);
  const ownScrollTopRef = useRef<number | null>(null);
  const glideFrameRef = useRef<number | null>(null);
  const resumeTimerRef = useRef<number | null>(null);

  // One glide routine for every trigger (song change, enabling, resuming).
  const glideRef = useRef<() => void>(() => {});
  glideRef.current = () => {
    const viewport = viewportRef.current;
    const layout = layoutRef.current;
    if (!viewport || !layout) return;
    const list = viewport.querySelector<HTMLElement>(".lt-track-headers-list");
    const header = viewport.querySelector<HTMLElement>(".lt-ruler-header");
    if (!list) return;
    const target = songTracksScrollTop({
      song: songRef.current,
      activeRegionId: activeRegionIdRef.current || null,
      visibleTracks: visibleTracksRef.current ?? [],
      layout,
      listOffset: contentOffset(list, viewport),
      stickyHeight: header?.offsetHeight ?? 0,
      maxScrollTop: viewport.scrollHeight - viewport.clientHeight,
    });
    if (target === null) return;
    if (glideFrameRef.current !== null) cancelAnimationFrame(glideFrameRef.current);
    const from = viewport.scrollTop;
    if (Math.abs(target - from) <= OWN_SCROLL_TOLERANCE_PX) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = reduceMotion ? 1 : Math.min(1, (now - startedAt) / GLIDE_MS);
      const eased = 1 - (1 - progress) ** 3;
      viewport.scrollTop = from + (target - from) * eased;
      // Read back: the browser rounds and clamps what we write.
      ownScrollTopRef.current = viewport.scrollTop;
      glideFrameRef.current = progress < 1 ? requestAnimationFrame(step) : null;
    };
    glideFrameRef.current = requestAnimationFrame(step);
  };

  // Scrolling by hand pauses the follow; it glides back after a quiet spell.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!following || !viewport) return;
    const handleScroll = () => {
      const own = ownScrollTopRef.current;
      if (own !== null && Math.abs(viewport.scrollTop - own) <= OWN_SCROLL_TOLERANCE_PX) return;
      ownScrollTopRef.current = null;
      if (glideFrameRef.current !== null) {
        cancelAnimationFrame(glideFrameRef.current);
        glideFrameRef.current = null;
      }
      pausedUntilRef.current = performance.now() + FOLLOW_CAMERA_MANUAL_PAUSE_MS;
      if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = window.setTimeout(() => {
        resumeTimerRef.current = null;
        glideRef.current();
      }, FOLLOW_CAMERA_MANUAL_PAUSE_MS);
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
      if (glideFrameRef.current !== null) cancelAnimationFrame(glideFrameRef.current);
      glideFrameRef.current = null;
      ownScrollTopRef.current = null;
      pausedUntilRef.current = 0;
    };
  }, [following, viewportRef]);

  // A new song under the playhead (or turning the follow on) brings its
  // tracks up, unless the user is in the middle of scrolling: then the resume
  // timer brings them up when it fires.
  useEffect(() => {
    if (!following || !activeRegionId) return;
    if (performance.now() < pausedUntilRef.current) return;
    glideRef.current();
  }, [following, activeRegionId]);
}
