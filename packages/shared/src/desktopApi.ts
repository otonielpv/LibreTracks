import type {
  AppSettings,
  AudioMeterLevel,
  AudioOutputDevices,
  CreateClipArgs,
  DesktopPerformanceSnapshot,
  LibraryAssetSummary,
  LibraryImportProgressEvent,
  RemoteServerInfo,
  SongView,
  TrackKind,
  TransportLifecycleEvent,
  TransportSnapshot,
  WaveformReadyEvent,
  WaveformSummaryDto,
} from "./models";

export * from "./models";

const tauriWindow = window as Window & {
  __TAURI_INTERNALS__?: unknown;
};

export const isTauriApp = Boolean(tauriWindow.__TAURI_INTERNALS__);

async function invokeCommand<T>(command: string, args?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function listenToTransportLifecycle(
  handler: (event: TransportLifecycleEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<TransportLifecycleEvent>("transport:lifecycle", (event) => {
    handler(event.payload);
  });
}

export async function listenToAudioMeters(
  handler: (levels: AudioMeterLevel[]) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<AudioMeterLevel[]>("audio:meters", (event) => {
    handler(event.payload);
  });
}

export async function listenToLibraryImportProgress(
  handler: (event: LibraryImportProgressEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LibraryImportProgressEvent>("library:import-progress", (event) => {
    handler(event.payload);
  });
}

export async function listenToWaveformReady(
  handler: (event: WaveformReadyEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<WaveformReadyEvent>("waveform:ready", (event) => {
    handler(event.payload);
  });
}

export async function getTransportSnapshot(): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("get_transport_snapshot");
}

export async function getSongView(): Promise<SongView | null> {
  return invokeCommand<SongView | null>("get_song_view");
}

export async function getWaveformSummaries(
  waveformKeys: string[],
): Promise<WaveformSummaryDto[]> {
  return invokeCommand<WaveformSummaryDto[]>("get_waveform_summaries", { waveformKeys });
}

export async function getLibraryWaveformSummaries(
  filePaths: string[],
): Promise<WaveformSummaryDto[]> {
  return invokeCommand<WaveformSummaryDto[]>("get_library_waveform_summaries", { filePaths });
}

export async function getLibraryAssets(): Promise<LibraryAssetSummary[]> {
  return invokeCommand<LibraryAssetSummary[]>("get_library_assets");
}

export async function getLibraryFolders(): Promise<string[]> {
  return invokeCommand<string[]>("get_library_folders");
}

export async function getDesktopPerformanceSnapshot(): Promise<DesktopPerformanceSnapshot> {
  return invokeCommand<DesktopPerformanceSnapshot>("get_desktop_performance_snapshot");
}

export async function getSettings(): Promise<AppSettings> {
  return invokeCommand<AppSettings>("get_settings");
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  return invokeCommand<AppSettings>("save_settings", { settings });
}

export async function updateAudioSettings(settings: AppSettings): Promise<AppSettings> {
  return invokeCommand<AppSettings>("update_audio_settings", { settings });
}

export async function getAudioOutputDevices(): Promise<AudioOutputDevices> {
  return invokeCommand<AudioOutputDevices>("get_audio_output_devices");
}

export async function getRemoteServerInfo(): Promise<RemoteServerInfo> {
  return invokeCommand<RemoteServerInfo>("get_remote_server_info");
}

export async function reportUiRenderMetric(renderMillis: number): Promise<void> {
  await invokeCommand("report_ui_render_metric", { renderMillis });
}

export async function createSong(): Promise<TransportSnapshot | null> {
  return invokeCommand<TransportSnapshot | null>("create_song");
}

export async function saveProject(): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("save_project");
}

export async function saveProjectAs(): Promise<TransportSnapshot | null> {
  return invokeCommand<TransportSnapshot | null>("save_project_as");
}

export async function undoAction(): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("undo_action");
}

export async function redoAction(): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("redo_action");
}

export async function updateSongTempo(bpm: number): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_song_tempo", { bpm });
}

export async function upsertSongTempoMarker(
  startSeconds: number,
  bpm: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("upsert_song_tempo_marker", { startSeconds, bpm });
}

export async function deleteSongTempoMarker(markerId: string): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("delete_song_tempo_marker", { markerId });
}

export async function openProject(): Promise<TransportSnapshot | null> {
  return invokeCommand<TransportSnapshot | null>("open_project_from_dialog");
}

export async function pickAndImportSong(): Promise<TransportSnapshot | null> {
  return invokeCommand<TransportSnapshot | null>("pick_and_import_song_from_dialog");
}

export async function importLibraryAssetsFromDialog(): Promise<LibraryAssetSummary[] | null> {
  return invokeCommand<LibraryAssetSummary[] | null>("import_library_assets_from_dialog");
}

export async function deleteLibraryAsset(filePath: string): Promise<LibraryAssetSummary[]> {
  return invokeCommand<LibraryAssetSummary[]>("delete_library_asset", { filePath });
}

export async function moveLibraryAsset(
  filePath: string,
  newFolderPath: string | null,
): Promise<LibraryAssetSummary[]> {
  return invokeCommand<LibraryAssetSummary[]>("move_library_asset", {
    filePath,
    newFolderPath,
  });
}

export async function createLibraryFolder(folderPath: string): Promise<string[]> {
  return invokeCommand<string[]>("create_library_folder", { folderPath });
}

export async function renameLibraryFolder(
  oldFolderPath: string,
  newFolderPath: string,
): Promise<LibraryAssetSummary[]> {
  return invokeCommand<LibraryAssetSummary[]>("rename_library_folder", {
    oldFolderPath,
    newFolderPath,
  });
}

export async function deleteLibraryFolder(folderPath: string): Promise<LibraryAssetSummary[]> {
  return invokeCommand<LibraryAssetSummary[]>("delete_library_folder", { folderPath });
}

export async function playTransport(): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("play_transport");
}

export async function pauseTransport(): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("pause_transport");
}

export async function stopTransport(): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("stop_transport");
}

export async function seekTransport(positionSeconds: number): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("seek_transport", { positionSeconds });
}

export async function scheduleMarkerJump(
  targetMarkerId: string,
  trigger: "immediate" | "next_marker" | "after_bars",
  bars?: number,
  transition: "instant" | "fade_out" = "instant",
  durationSeconds?: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("schedule_marker_jump", {
    targetMarkerId,
    trigger,
    bars,
    transition,
    durationSeconds,
  });
}

export async function scheduleRegionJump(
  targetRegionId: string,
  trigger: "immediate" | "region_end" | "after_bars",
  bars?: number,
  transition: "instant" | "fade_out" = "instant",
  durationSeconds?: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("schedule_region_jump", {
    targetRegionId,
    trigger,
    bars,
    transition,
    durationSeconds,
  });
}

export async function cancelMarkerJump(): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("cancel_marker_jump");
}

export async function moveClip(
  clipId: string,
  timelineStartSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("move_clip", { clipId, timelineStartSeconds });
}

export async function moveClipLive(
  clipId: string,
  timelineStartSeconds: number,
): Promise<void> {
  await invokeCommand("move_clip_live", { clipId, timelineStartSeconds });
}

export async function deleteClip(clipId: string): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("delete_clip", { clipId });
}

export async function updateClipWindow(
  clipId: string,
  timelineStartSeconds: number,
  sourceStartSeconds: number,
  durationSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_clip_window", {
    clipId,
    timelineStartSeconds,
    sourceStartSeconds,
    durationSeconds,
  });
}

export async function duplicateClip(
  clipId: string,
  timelineStartSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("duplicate_clip", { clipId, timelineStartSeconds });
}

export async function splitClip(
  clipId: string,
  splitSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("split_clip", { clipId, splitSeconds });
}

export async function createSongRegion(
  startSeconds: number,
  endSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("create_song_region", { startSeconds, endSeconds });
}

export async function updateSongRegion(
  regionId: string,
  name: string,
  startSeconds: number,
  endSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_song_region", {
    regionId,
    name,
    startSeconds,
    endSeconds,
  });
}

export async function deleteSongRegion(regionId: string): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("delete_song_region", { regionId });
}

export async function createSectionMarker(startSeconds: number): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("create_section_marker", { startSeconds });
}

export async function updateSectionMarker(
  sectionId: string,
  name: string,
  startSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_section_marker", {
    sectionId,
    name,
    startSeconds,
  });
}

export async function deleteSectionMarker(sectionId: string): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("delete_section_marker", { sectionId });
}

export async function assignSectionMarkerDigit(
  sectionId: string,
  digit: number | null,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("assign_section_marker_digit", { sectionId, digit });
}

export async function createTrack(args: {
  name: string;
  kind: TrackKind;
  insertAfterTrackId?: string | null;
  parentTrackId?: string | null;
}): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("create_track", args);
}

export async function createClip(args: {
  trackId: string;
  filePath: string;
  timelineStartSeconds: number;
}): Promise<TransportSnapshot> {
  return createClipsBatch([args]);
}

export async function createClipsBatch(args: CreateClipArgs[]): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("create_clips_batch", { requests: args });
}

export async function moveTrack(args: {
  trackId: string;
  insertAfterTrackId?: string | null;
  insertBeforeTrackId?: string | null;
  parentTrackId?: string | null;
}): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("move_track", args);
}

export async function updateTrack(args: {
  trackId: string;
  name?: string;
  volume?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
}): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_track", args);
}

export async function updateTrackMixLive(args: {
  trackId: string;
  volume?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
}): Promise<void> {
  await invokeCommand("update_track_mix_live", args);
}

export async function deleteTrack(trackId: string): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("delete_track", { trackId });
}
