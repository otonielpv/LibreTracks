import {
  buildSongTempoRegions,
  getSongBaseBpm,
  getSongBaseTimeSignature,
} from "@libretracks/shared/models";
import type {
  AppSettings,
  AudioBackendKind,
  AudioDeviceDescriptor,
  ClipSummary,
  MidiBinding,
  SectionMarkerSummary,
  SongRegionSummary,
  SongView,
} from "@libretracks/shared/models";
import {
  getCumulativeMusicalPosition,
  clientXToTimelineSeconds,
  screenXToSeconds,
  secondsToScreenX,
} from "./timelineMath";
import type {
  NativeClientPointCandidate,
  NativeDropCandidateDebug,
  NativeDropCoordinateMode,
  NativeDropDebugRect,
  NativeDroppedFile,
  OptimisticClipOperation,
  TrackDropState,
} from "./types";

type TFunc = (key: string, options?: Record<string, unknown>) => string;

const MIDI_NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

export function getNativeCandidatePointerDelta(
  candidate: NativeDropCandidateDebug,
) {
  return candidate.rawDeltaPx ?? Number.POSITIVE_INFINITY;
}

export function selectNativeDropCandidate(
  candidates: NativeDropCandidateDebug[],
): NativeDropCandidateDebug | null {
  return (
    candidates
      .filter(
        (candidate) =>
          candidate.isOverTimeline && candidate.dropSeconds != null,
      )
      .sort((a, b) => {
        const aDelta = getNativeCandidatePointerDelta(a);
        const bDelta = getNativeCandidatePointerDelta(b);

        if (aDelta !== bDelta) {
          return aDelta - bDelta;
        }

        return b.score - a.score;
      })[0] ?? null
  );
}

export function isAudioDeviceVisibleForBackend(
  device: Pick<AudioDeviceDescriptor, "backend">,
  selectedBackend: AudioBackendKind | null,
) {
  return (
    (selectedBackend === null && device.backend !== "asio") ||
    device.backend === selectedBackend
  );
}

export function formatAudioRouteLabel(route: string, t: TFunc) {
  if (route === "master") {
    return t("trackHeader.master", { defaultValue: "Master" });
  }

  if (route.startsWith("ext:")) {
    const channelPart = route.slice(4);
    if (channelPart.includes("-")) {
      const [left, right] = channelPart
        .split("-")
        .map((value) => Number(value) + 1);
      return t("trackHeader.extOutStereo", {
        left,
        right,
        defaultValue: `Ext. Out ${left}/${right}`,
      });
    }

    const channel = Number(channelPart) + 1;
    return t("trackHeader.extOutMono", {
      channel,
      defaultValue: `Ext. Out ${channel}`,
    });
  }

  return route;
}

export function buildAudioRoutingOptions(
  enabledChannels: number[],
  t: TFunc,
) {
  const channels = Array.from(new Set(enabledChannels)).sort(
    (left, right) => left - right,
  );
  const options = [
    { value: "master", label: formatAudioRouteLabel("master", t) },
  ];

  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index];
    const nextChannel = channels[index + 1];
    if (nextChannel === channel + 1) {
      const stereoRoute = `ext:${channel}-${nextChannel}`;
      options.push({
        value: stereoRoute,
        label: formatAudioRouteLabel(stereoRoute, t),
      });
    }
    const monoRoute = `ext:${channel}`;
    options.push({
      value: monoRoute,
      label: formatAudioRouteLabel(monoRoute, t),
    });
  }

  return options;
}

export function formatMidiBinding(binding: MidiBinding) {
  const channel = (binding.status & 0x0f) + 1;
  const statusType = binding.status & 0xf0;

  if (binding.isCc || statusType === 0xb0) {
    return `CC ${binding.data1} (Ch ${channel})`;
  }

  if (statusType === 0x90 || statusType === 0x80) {
    const noteIndex = binding.data1 % 12;
    const octave = Math.floor(binding.data1 / 12) - 1;
    const noteName = MIDI_NOTE_NAMES[noteIndex] ?? `Note ${binding.data1}`;
    const noteLabel = `${noteName}${octave}`;
    const prefix = statusType === 0x80 ? "Note Off" : "Note On";
    return `${prefix} ${binding.data1} (${noteLabel}) (Ch ${channel})`;
  }

  return `Status 0x${binding.status.toString(16).toUpperCase().padStart(2, "0")} / Data1 ${binding.data1} (Ch ${channel})`;
}

export function findMidiMappingKeyForMessage(
  midiMappings: AppSettings["midiMappings"],
  message: { status: number; data1: number },
) {
  return (
    Object.entries(midiMappings).find(
      ([, binding]) =>
        binding.status === message.status && binding.data1 === message.data1,
    )?.[0] ?? null
  );
}

export function libraryAssetFileName(filePath: string) {
  return filePath.split(/[\\/]/).at(-1) ?? filePath;
}

export function resolveNativeAudioImportPayloads(files: File[]) {
  const payloads = files
    .map((file) => {
      const sourcePath = (file as NativeDroppedFile).path?.trim();
      if (!sourcePath) {
        return null;
      }

      return {
        fileName: file.name,
        sourcePath,
      };
    })
    .filter(
      (payload): payload is { fileName: string; sourcePath: string } =>
        payload !== null,
    );

  return payloads.length === files.length ? payloads : null;
}

export function humanizeLibraryTrackName(filePath: string) {
  return (
    libraryAssetFileName(filePath)
      .replace(/\.[^.]+$/, "")
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map(
        (part) =>
          `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`,
      )
      .join(" ") || "Audio"
  );
}

export async function waitForUiPaint() {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export function toClientPointFromNativePosition(position: {
  x: number;
  y: number;
}) {
  const scaleFactor = window.devicePixelRatio || 1;
  return {
    clientX: position.x / scaleFactor,
    clientY: position.y / scaleFactor,
  };
}

export function nativeClientPointCandidates(
  position: { x: number; y: number },
  webviewPosition: { x: number; y: number } | null,
) {
  const scaleFactor = window.devicePixelRatio || 1;
  const candidates: NativeClientPointCandidate[] = [];

  const addCandidate = (
    label: NativeDropCoordinateMode,
    clientX: number,
    clientY: number,
  ) => {
    candidates.push({ label, clientX, clientY });
  };

  if (webviewPosition) {
    addCandidate(
      "minus-webview",
      position.x - webviewPosition.x,
      position.y - webviewPosition.y,
    );
    addCandidate(
      "minus-webview/dpr",
      (position.x - webviewPosition.x) / scaleFactor,
      (position.y - webviewPosition.y) / scaleFactor,
    );
  }

  addCandidate("raw", position.x, position.y);
  addCandidate("raw/dpr", position.x / scaleFactor, position.y / scaleFactor);

  return candidates;
}

export function describeNativeDropElement(element: HTMLElement | null) {
  if (!element) {
    return null;
  }

  const className =
    typeof element.className === "string" ? element.className.trim() : "";
  return `${element.tagName.toLowerCase()}${className ? `.${className.replace(/\s+/g, ".")}` : ""}`;
}

export function toNativeDropDebugRect(
  rect: DOMRect | null,
): NativeDropDebugRect | null {
  if (!rect) {
    return null;
  }

  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function formatMusicalPosition(
  seconds: number,
  song: SongView | null | undefined,
) {
  return getCumulativeMusicalPosition(
    seconds,
    buildSongTempoRegions(song),
    getSongBaseBpm(song),
    getSongBaseTimeSignature(song),
  ).display;
}

export function formatClock(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const secondsRemainder = safeSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${secondsRemainder.toFixed(3).padStart(6, "0")}`;
}

export function formatCompactTime(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function keyboardDigit(
  eventCodeOrEvent: string | KeyboardEvent,
) {
  // event.code path: "Digit1" / "Numpad1" — works for plain number keys but
  // breaks for Shift+Numpad because Windows toggles NumLock under Shift and
  // browsers then report "End"/"Home"/"ArrowDown" etc. as the code.
  //
  // event.key fallback: when given the whole KeyboardEvent we also accept
  // the resolved key character, which is "1".."9" regardless of which
  // physical key (main row or numpad) produced it and regardless of NumLock
  // state. This covers Shift+Numpad on every layout we care about.
  const code =
    typeof eventCodeOrEvent === "string"
      ? eventCodeOrEvent
      : eventCodeOrEvent.code;
  const codeMatch = code.match(/^(?:Digit|Numpad)(\d)$/);
  if (codeMatch) {
    return Number(codeMatch[1]);
  }

  if (typeof eventCodeOrEvent !== "string") {
    const key = eventCodeOrEvent.key;
    if (key.length === 1 && key >= "0" && key <= "9") {
      return Number(key);
    }
  }

  return null;
}

export function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable || target.tagName === "TEXTAREA") {
    return true;
  }

  if (target.tagName !== "INPUT") {
    return false;
  }

  const textEntryTypes = new Set([
    "",
    "email",
    "password",
    "search",
    "number",
    "tel",
    "text",
    "url",
  ]);

  return textEntryTypes.has((target as HTMLInputElement).type.toLowerCase());
}

export function resolveMarkerShortcut(
  markers: SectionMarkerSummary[],
  digit: number,
) {
  return (
    [...markers]
      .sort((left, right) => left.startSeconds - right.startSeconds)
      .at(digit) ?? null
  );
}

export function resolveRegionShortcut(
  regions: SongRegionSummary[],
  digit: number,
) {
  return (
    [...regions]
      .sort((left, right) => left.startSeconds - right.startSeconds)
      .at(digit) ?? null
  );
}

export function buildVisibleTracks(
  song: SongView,
  collapsedFolders: Set<string>,
) {
  const visibility = new Map<string, boolean>();

  for (const track of song.tracks) {
    const parentId = track.parentTrackId ?? null;
    if (!parentId) {
      visibility.set(track.id, true);
      continue;
    }

    const parentVisible = visibility.get(parentId) ?? true;
    const isParentCollapsed = collapsedFolders.has(parentId);
    visibility.set(track.id, parentVisible && !isParentCollapsed);
  }

  return song.tracks.filter((track) => visibility.get(track.id));
}

export function findPreviousFolderTrack(song: SongView, trackId: string) {
  const index = song.tracks.findIndex((track) => track.id === trackId);
  if (index <= 0) {
    return null;
  }

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const track = song.tracks[cursor];
    if (track.kind === "folder") {
      return track;
    }
  }

  return null;
}

export function findTrack(song: SongView | null, trackId: string | null) {
  if (!song || !trackId) {
    return null;
  }

  return song.tracks.find((track) => track.id === trackId) ?? null;
}

export function findClip(song: SongView | null, clipId: string | null) {
  if (!song || !clipId) {
    return null;
  }

  return song.clips.find((clip) => clip.id === clipId) ?? null;
}

export function findSection(song: SongView | null, sectionId: string | null) {
  if (!song || !sectionId) {
    return null;
  }

  return (
    song.sectionMarkers.find((marker) => marker.id === sectionId) ?? null
  );
}

export function trackChildrenCount(song: SongView, trackId: string) {
  return song.tracks.filter((track) => track.parentTrackId === trackId).length;
}

function isClipStructurallyEqual(left: ClipSummary, right: ClipSummary) {
  return (
    left.id === right.id &&
    left.trackId === right.trackId &&
    left.waveformKey === right.waveformKey &&
    left.isMissing === right.isMissing &&
    left.timelineStartSeconds === right.timelineStartSeconds &&
    left.sourceStartSeconds === right.sourceStartSeconds &&
    left.sourceDurationSeconds === right.sourceDurationSeconds &&
    left.durationSeconds === right.durationSeconds
  );
}

export function buildMemoizedClipsByTrack(
  song: SongView,
  current: Record<string, ClipSummary[]>,
): Record<string, ClipSummary[]> {
  const nextBuckets = Object.fromEntries(
    song.tracks.map((track) => [track.id, [] as ClipSummary[]]),
  );

  for (const clip of song.clips) {
    nextBuckets[clip.trackId] ??= [];
    nextBuckets[clip.trackId].push(clip);
  }

  let hasChanged =
    Object.keys(current).length !== Object.keys(nextBuckets).length;
  const nextClipsByTrack: Record<string, ClipSummary[]> = {};

  for (const track of song.tracks) {
    const nextTrackClips = nextBuckets[track.id] ?? [];
    const currentTrackClips = current[track.id] ?? [];
    const canReuseTrackClips =
      nextTrackClips.length === currentTrackClips.length &&
      nextTrackClips.every((clip, index) =>
        isClipStructurallyEqual(clip, currentTrackClips[index]),
      );

    nextClipsByTrack[track.id] = canReuseTrackClips
      ? currentTrackClips
      : nextTrackClips;
    if (!canReuseTrackClips) {
      hasChanged = true;
    }
  }

  return hasChanged ? nextClipsByTrack : current;
}

function isSameClipPlacement(left: ClipSummary, right: ClipSummary) {
  return (
    left.trackId === right.trackId &&
    left.filePath === right.filePath &&
    Math.abs(left.timelineStartSeconds - right.timelineStartSeconds) <
      0.0001 &&
    Math.abs(left.sourceStartSeconds - right.sourceStartSeconds) < 0.0001 &&
    Math.abs(left.durationSeconds - right.durationSeconds) < 0.0001
  );
}

export function mergeOptimisticClipsByTrack(
  clipsByTrack: Record<string, ClipSummary[]>,
  operations: OptimisticClipOperation[],
) {
  if (!operations.length) {
    return clipsByTrack;
  }

  const nextClipsByTrack: Record<string, ClipSummary[]> = Object.fromEntries(
    Object.entries(clipsByTrack).map(([trackId, clips]) => [
      trackId,
      [...clips],
    ]),
  );

  for (const operation of operations) {
    for (const clip of operation.clips) {
      const currentTrackClips = nextClipsByTrack[clip.trackId] ?? [];
      if (
        currentTrackClips.some((currentClip) =>
          isSameClipPlacement(currentClip, clip),
        )
      ) {
        continue;
      }

      nextClipsByTrack[clip.trackId] = [...currentTrackClips, clip].sort(
        (left, right) =>
          left.timelineStartSeconds - right.timelineStartSeconds,
      );
    }
  }

  return nextClipsByTrack;
}

export function isTrackDescendant(
  song: SongView,
  candidateTrackId: string | null,
  trackId: string,
) {
  let cursor = candidateTrackId;

  while (cursor) {
    if (cursor === trackId) {
      return true;
    }

    cursor = findTrack(song, cursor)?.parentTrackId ?? null;
  }

  return false;
}

export function isInteractiveTimelineTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(
        target.closest(
          ".lt-marker-hotspot, .lt-track-header, .lt-inline-menu, .lt-context-menu, button, input, select, textarea, label",
        ),
      )
    : false;
}

export function isTimelineZoomTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(
        target.closest(
          ".lt-ruler-track, .lt-ruler-content, .lt-ruler-canvas, .lt-ruler-canvas-overlay, .lt-track-list, .lt-track-list-dropzone, .lt-track-lane-row, .lt-track-header-row, .lt-track-lane, .lt-track-canvas-layer, .lt-track-canvas-background, .lt-track-canvas, .lt-track-canvas-overlay",
        ),
      )
    : false;
}

export function isTrackInfoScrollTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(target.closest(".lt-track-header"))
    : false;
}

export function resolveTrackDropState(
  song: SongView,
  draggingTrackId: string,
  clientX: number,
  clientY: number,
): TrackDropState {
  const hoveredRow = document
    .elementFromPoint(clientX, clientY)
    ?.closest(
      ".lt-track-lane-row, .lt-track-header-row",
    ) as HTMLElement | null;
  const targetTrackId = hoveredRow?.dataset.trackId ?? null;
  if (!hoveredRow || !targetTrackId || targetTrackId === draggingTrackId) {
    return null;
  }

  const targetTrack = findTrack(song, targetTrackId);
  if (
    !targetTrack ||
    isTrackDescendant(song, targetTrackId, draggingTrackId)
  ) {
    return null;
  }

  const bounds = hoveredRow.getBoundingClientRect();
  const verticalRatio =
    bounds.height > 0 ? (clientY - bounds.top) / bounds.height : 0.5;
  const mode =
    targetTrack.kind === "folder" &&
    verticalRatio >= 0.3 &&
    verticalRatio <= 0.7
      ? "inside-folder"
      : verticalRatio < 0.5
        ? "before"
        : "after";

  return {
    targetTrackId,
    mode,
  };
}

export function rulerPointerToSeconds(
  event: MouseEvent | { clientX: number },
  element: HTMLElement,
  scrollContainerElement: HTMLElement | null,
  durationSeconds: number,
  pixelsPerSecond: number,
) {
  return clamp(
    clientXToTimelineSeconds(
      event.clientX,
      element,
      scrollContainerElement,
      pixelsPerSecond,
    ),
    0,
    Math.max(0, durationSeconds),
  );
}

export function rulerClientXToSeconds(
  clientX: number,
  element: HTMLElement,
  cameraX: number,
  durationSeconds: number,
  pixelsPerSecond: number,
) {
  const bounds = element.getBoundingClientRect();
  const viewportX = clamp(clientX - bounds.left, 0, bounds.width);
  return clamp(
    screenXToSeconds(viewportX, cameraX, pixelsPerSecond),
    0,
    Math.max(0, durationSeconds),
  );
}

export function lanePointerToClip(
  clips: ClipSummary[],
  element: HTMLElement,
  clientX: number,
  cameraX: number,
  pixelsPerSecond: number,
) {
  const bounds = element.getBoundingClientRect();
  const pointerX = clamp(clientX - bounds.left, 0, bounds.width);

  for (let index = clips.length - 1; index >= 0; index -= 1) {
    const clip = clips[index];
    const clipLeft = secondsToScreenX(
      clip.timelineStartSeconds,
      cameraX,
      pixelsPerSecond,
    );
    const clipWidth = Math.max(clip.durationSeconds * pixelsPerSecond, 28);

    if (pointerX >= clipLeft && pointerX <= clipLeft + clipWidth) {
      return clip;
    }
  }

  return null;
}
