import type {
  ClipSummary,
  LibraryAssetSummary,
  TrackSummary,
} from "./desktopApi";

export type PendingAudioImportStatus =
  | "queued"
  | "reading"
  | "importing"
  | "metadata"
  | "analyzing"
  | "ready"
  | "failed";

export type PendingAudioImport = {
  id: string;
  fileName: string;
  temporaryAssetId: string;
  temporaryTrackId: string;
  temporaryClipId: string;
  dropSeconds: number;
  status: PendingAudioImportStatus;
  error?: string;
};

export type TimelineTrackSummary = TrackSummary & {
  isPending?: boolean;
  pendingImportId?: string;
  /** True for the synthetic automation lane (not a real song track). */
  isAutomation?: boolean;
};

/** Sentinel id for the synthetic automation track row. Never a real track id. */
export const AUTOMATION_TRACK_ID = "__automation__";

export type TimelineClipSummary = ClipSummary & {
  isPending?: boolean;
  waveformStatus?: "pending" | "analyzing" | "failed" | "ready";
  pendingStatus?: PendingAudioImportStatus;
  pendingError?: string;
};

export type PendingLibraryAssetSummary = LibraryAssetSummary & {
  isPending?: boolean;
  pendingStatus?: PendingAudioImportStatus;
  pendingError?: string;
};

function createPendingAudioImportId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `pending-audio-import-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function pendingImportFileName(value: string) {
  return value.split(/[\\/]/).at(-1) ?? value;
}

export function createPendingAudioImports(
  files: File[],
  dropSeconds: number,
): PendingAudioImport[] {
  return files.map((file) => {
    const id = createPendingAudioImportId();

    return {
      id,
      fileName: file.name,
      temporaryAssetId: `pending-asset-${id}`,
      temporaryTrackId: `pending-track-${id}`,
      temporaryClipId: `pending-clip-${id}`,
      dropSeconds,
      status: "queued",
    };
  });
}

export function createPendingAudioImportsFromPaths(
  paths: string[],
  dropSeconds: number,
): PendingAudioImport[] {
  return paths.map((path) => {
    const id = createPendingAudioImportId();

    return {
      id,
      fileName: pendingImportFileName(path),
      temporaryAssetId: `pending-asset-${id}`,
      temporaryTrackId: `pending-track-${id}`,
      temporaryClipId: `pending-clip-${id}`,
      dropSeconds,
      status: "queued",
    };
  });
}

export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

export function toPendingTrack(
  importJob: PendingAudioImport,
): TimelineTrackSummary {
  return {
    id: importJob.temporaryTrackId,
    name: importJob.fileName,
    kind: "audio",
    parentTrackId: null,
    depth: 0,
    hasChildren: false,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    audioTo: "master",
    transposeEnabled: false,
    isPending: true,
    pendingImportId: importJob.id,
  };
}

/**
 * Build the synthetic automation track row. It is injected into `visibleTracks`
 * alongside the real tracks (same mechanism as pending imports) but never exists
 * as a `Track` in the song model — its data lives in `automation.ltautomation`.
 */
export function toAutomationTrack(): TimelineTrackSummary {
  return {
    id: AUTOMATION_TRACK_ID,
    name: "Automatismos",
    kind: "audio",
    parentTrackId: null,
    depth: 0,
    hasChildren: false,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    audioTo: "master",
    transposeEnabled: false,
    isAutomation: true,
  };
}

export function toPendingClip(
  importJob: PendingAudioImport,
): TimelineClipSummary {
  return {
    id: importJob.temporaryClipId,
    trackId: importJob.temporaryTrackId,
    trackName: importJob.fileName,
    filePath: importJob.temporaryAssetId,
    waveformKey: importJob.temporaryAssetId,
    isMissing: false,
    timelineStartSeconds: importJob.dropSeconds,
    sourceStartSeconds: 0,
    sourceWindowDurationSeconds: 8,
    sourceDurationSeconds: 8,
    durationSeconds: 8,
    gain: 1,
    isPending: true,
    waveformStatus:
      importJob.status === "failed"
        ? "failed"
        : importJob.status === "analyzing" || importJob.status === "ready"
          ? "analyzing"
          : "pending",
    pendingStatus: importJob.status,
    pendingError: importJob.error,
  };
}

export function mergePendingClipsByTrack(
  clipsByTrack: Record<string, TimelineClipSummary[]>,
  pendingAudioImports: PendingAudioImport[],
): Record<string, TimelineClipSummary[]> {
  if (!pendingAudioImports.length) {
    return clipsByTrack;
  }

  const nextClipsByTrack: Record<string, TimelineClipSummary[]> = {
    ...clipsByTrack,
  };

  for (const pendingImport of pendingAudioImports) {
    const trackId = pendingImport.temporaryTrackId;
    const currentTrackClips = nextClipsByTrack[trackId] ?? [];
    nextClipsByTrack[trackId] = [
      ...currentTrackClips,
      toPendingClip(pendingImport),
    ];
  }

  return nextClipsByTrack;
}

export function toPendingLibraryAsset(
  importJob: PendingAudioImport,
): PendingLibraryAssetSummary {
  return {
    fileName: importJob.fileName,
    filePath: importJob.temporaryAssetId,
    durationSeconds: 0,
    isMissing: false,
    folderPath: null,
    isPending: true,
    pendingStatus: importJob.status,
    pendingError: importJob.error,
  };
}

export function mergeLibraryAssetsByFilePath(
  baseAssets: LibraryAssetSummary[],
  incomingAssets: LibraryAssetSummary[],
): LibraryAssetSummary[] {
  const byFilePath = new Map<string, LibraryAssetSummary>();

  for (const asset of baseAssets) {
    byFilePath.set(asset.filePath, asset);
  }

  for (const asset of incomingAssets) {
    byFilePath.set(asset.filePath, asset);
  }

  return [...byFilePath.values()].sort((left, right) => {
    const leftFolder = (left.folderPath ?? "").toLowerCase();
    const rightFolder = (right.folderPath ?? "").toLowerCase();
    return (
      leftFolder.localeCompare(rightFolder) ||
      left.fileName.localeCompare(right.fileName)
    );
  });
}

export function getPendingClipLabel(status: PendingAudioImportStatus): string {
  switch (status) {
    case "queued":
      return "Queued...";
    case "reading":
      return "Reading file...";
    case "importing":
      return "Importing...";
    case "metadata":
      return "Loading metadata...";
    case "analyzing":
    case "ready":
      return "Analyzing waveform...";
    case "failed":
      return "Import failed";
    default:
      return "Analyzing waveform...";
  }
}
