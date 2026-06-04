import type {
  AppSettings,
  AudioFileImportPayload,
  AudioFilePathImportPayload,
  AudioMeterLevel,
  AudioOutputDevices,
  CreateClipArgs,
  DesktopPerformanceSnapshot,
  LibraryAssetSummary,
  LibraryImportProgressEvent,
  ProjectLoadCompleteEvent,
  MidiRawMessage,
  ProjectLoadProgressEvent,
  RegionMeterLevel,
  RemoteServerInfo,
  SongView,
  SongPackageImportResponse,
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
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    // Central capture point for ALL command failures that surface to the
    // frontend — covers the many commands not explicitly instrumented on the
    // Rust side. Never let logging mask the original error: swallow its own
    // failure and re-throw the real one. Skip append_frontend_error itself to
    // avoid recursion if it ever fails.
    if (command !== "append_frontend_error") {
      const message = error instanceof Error ? error.message : String(error);
      void appendFrontendError(`invoke ${command} failed: ${message}`).catch(
        () => {},
      );
    }
    throw error;
  }
}

function isTransientAudioStateLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("state locked");
}

async function waitForMs(delayMs: number): Promise<void> {
  await new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
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

export async function listenToRegionMeters(
  handler: (levels: RegionMeterLevel[]) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<RegionMeterLevel[]>("audio:region_meters", (event) => {
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

export async function listenToProjectLoadProgress(
  handler: (event: ProjectLoadProgressEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ProjectLoadProgressEvent>("project:load-progress", (event) => {
    handler(event.payload);
  });
}

async function listenToProjectLoadComplete(
  handler: (event: ProjectLoadCompleteEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ProjectLoadCompleteEvent>("project:load-complete", (event) => {
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

export async function listenToSettingsUpdated(
  handler: (settings: AppSettings) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<AppSettings>("settings:updated", (event) => {
    handler(event.payload);
  });
}

export async function listenToMidiRawMessage(
  handler: (message: MidiRawMessage) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<MidiRawMessage>("midi:raw_message", (event) => {
    handler(event.payload);
  });
}

export async function getTransportSnapshot(): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("get_transport_snapshot");
}

export async function getSongView(
  options?: { includeWaveforms?: boolean },
): Promise<SongView | null> {
  const args = {
    includeWaveforms: options?.includeWaveforms ?? true,
  };
  const maxAttempts = 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await invokeCommand<SongView | null>("get_song_view", args);
    } catch (error) {
      if (!isTransientAudioStateLockError(error) || attempt === maxAttempts) {
        throw error;
      }
      await waitForMs(attempt * 25);
    }
  }

  return null;
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

// Enumerating audio devices is expensive (~650ms with ASIO drivers) and gets
// triggered redundantly: React StrictMode double-fires effects in dev, and the
// app re-fetches when the Settings modal opens shortly after mount. Dedup
// in-flight calls and serve a cached result for a short window so the user
// doesn't pay the cost twice. Pass force=true from the explicit Refresh button.
let audioOutputDevicesInflight: Promise<AudioOutputDevices> | null = null;
let audioOutputDevicesCache: { value: AudioOutputDevices; at: number } | null = null;
const AUDIO_OUTPUT_DEVICES_TTL_MS = 2000;

export async function getAudioOutputDevices(
  options: { force?: boolean } = {},
): Promise<AudioOutputDevices> {
  if (!options.force) {
    if (audioOutputDevicesInflight) {
      return audioOutputDevicesInflight;
    }
    if (
      audioOutputDevicesCache &&
      Date.now() - audioOutputDevicesCache.at < AUDIO_OUTPUT_DEVICES_TTL_MS
    ) {
      return audioOutputDevicesCache.value;
    }
  }
  const request = invokeCommand<AudioOutputDevices>("get_audio_output_devices")
    .then((value) => {
      audioOutputDevicesCache = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      audioOutputDevicesInflight = null;
    });
  audioOutputDevicesInflight = request;
  return request;
}

export async function getMidiInputs(): Promise<string[]> {
  return invokeCommand<string[]>("get_midi_inputs");
}

export async function getRemoteServerInfo(): Promise<RemoteServerInfo> {
  return invokeCommand<RemoteServerInfo>("get_remote_server_info");
}

export async function reportUiRenderMetric(renderMillis: number): Promise<void> {
  await invokeCommand("report_ui_render_metric", { renderMillis });
}

export async function appendDebugLog(line: string): Promise<void> {
  await invokeCommand("append_debug_log", { line });
}

// Best-effort append to the dedicated error log. Calls invoke directly (not
// invokeCommand) so a failure here can never recurse through the central
// error-capture wrapper. Always resolves; never throws.
export async function appendFrontendError(message: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("append_frontend_error", { message });
  } catch {
    // Logging must never break the app.
  }
}

export async function readErrorLog(): Promise<string> {
  return invokeCommand<string>("read_error_log");
}

export async function revealErrorLog(): Promise<void> {
  await invokeCommand("reveal_error_log");
}

export async function createSong(): Promise<TransportSnapshot | null> {
  return runProjectLoadCommand("start_create_song");
}

export async function saveProject(): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("save_project");
}

export async function saveProjectAs(): Promise<TransportSnapshot | null> {
  return runProjectLoadCommand("start_save_project_as");
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

export async function updateSongTimeSignature(signature: string): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_song_time_signature", { signature });
}

export async function upsertSongTimeSignatureMarker(
  startSeconds: number,
  signature: string,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("upsert_song_time_signature_marker", {
    startSeconds,
    signature,
  });
}

export async function deleteSongTimeSignatureMarker(markerId: string): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("delete_song_time_signature_marker", { markerId });
}

// Drive a dialog-backed project command that does its heavy work on a Rust
// worker thread (so the macOS main run loop stays responsive) and reports the
// result via the `project:load-complete` event. The `start_*` command returns
// `false` if the user cancels the native dialog — in that case no event fires,
// so resolve to null without waiting. Otherwise we await the completion event.
async function runProjectLoadCommand(
  startCommand: string,
): Promise<TransportSnapshot | null> {
  let dispose: (() => void) | null = null;
  const clearListener = () => {
    const unlisten: (() => void) | null = dispose;
    dispose = null;
    if (unlisten) {
      unlisten();
    }
  };
  const completion = new Promise<TransportSnapshot | null>((resolve, reject) => {
    void listenToProjectLoadComplete((event) => {
      clearListener();
      if (event.error) {
        reject(new Error(event.error));
        return;
      }
      resolve(event.snapshot);
    }).then((unlisten) => {
      dispose = unlisten;
    }, reject);
  });

  try {
    const started = await invokeCommand<boolean>(startCommand);
    if (!started) {
      clearListener();
      return null;
    }
    return await completion;
  } catch (error) {
    clearListener();
    throw error;
  }
}

export async function openProject(): Promise<TransportSnapshot | null> {
  return runProjectLoadCommand("start_open_project_from_dialog");
}

export async function pickAndImportSong(): Promise<TransportSnapshot | null> {
  return runProjectLoadCommand("start_pick_and_import_song_from_dialog");
}

export async function importLibraryAssetsFromDialog(): Promise<LibraryAssetSummary[] | null> {
  return invokeCommand<LibraryAssetSummary[] | null>("import_library_assets_from_dialog");
}

export async function importAudioFilesFromBytes(
  files: AudioFileImportPayload[],
): Promise<LibraryAssetSummary[]> {
  return invokeCommand<LibraryAssetSummary[]>("import_audio_files_from_bytes", { files });
}

export async function importAudioFilesFromPaths(
  files: AudioFilePathImportPayload[],
): Promise<LibraryAssetSummary[]> {
  return invokeCommand<LibraryAssetSummary[]>("import_audio_files_from_paths", { files });
}

export async function exportRegionAsPackage(regionId: string): Promise<void> {
  await invokeCommand("export_region_as_package", { regionId });
}

export async function exportRegionRenderedAudio(regionId: string): Promise<void> {
  await invokeCommand("export_region_rendered_audio", { regionId });
}

export async function importSongPackage(
  packagePath: string,
  insertAtSeconds: number,
): Promise<SongPackageImportResponse> {
  return invokeCommand<SongPackageImportResponse>("import_song_package", {
    packagePath,
    insertAtSeconds,
  });
}

export async function resolveMissingFile(
  oldPath: string,
  newPath: string,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("resolve_missing_file", { oldPath, newPath });
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

export async function prewarmTimelineSeek(positionSeconds: number): Promise<void> {
  await invokeCommand("prewarm_timeline_seek", { positionSeconds });
}

export async function scheduleMarkerJump(
  targetMarkerId: string,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("schedule_marker_jump", {
    targetMarkerId,
  });
}

export async function scheduleRegionJump(
  targetRegionId: string,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("schedule_region_jump", {
    targetRegionId,
  });
}

export async function cancelMarkerJump(): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("cancel_marker_jump");
}

export async function toggleVamp(
  mode: "section" | "bars",
  bars?: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("toggle_vamp", {
    mode,
    bars,
  });
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

export type ClipMoveRequest = {
  clipId: string;
  timelineStartSeconds: number;
};

export async function moveClipsBatch(
  moves: ClipMoveRequest[],
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("move_clips_batch", { moves });
}

export async function moveClipsLiveBatch(
  moves: ClipMoveRequest[],
): Promise<void> {
  await invokeCommand("move_clips_live_batch", { moves });
}

export async function deleteClip(clipId: string): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("delete_clip", { clipId });
}

/**
 * Batched clip deletion. Removes every id in `clipIds` in one engine
 * sync + one history entry + one snapshot round-trip. Use this when
 * the UI has a multi-selection of clips to delete — a loop of
 * `deleteClip` would otherwise re-sync the whole engine and re-render
 * the timeline once per clip, which feels sluggish on big selections.
 */
export async function deleteClips(clipIds: string[]): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("delete_clips", { clipIds });
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

export async function updateClipColor(
  clipId: string,
  color: string | null,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_clip_color", { clipId, color });
}

export async function duplicateClip(
  clipId: string,
  timelineStartSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("duplicate_clip", { clipId, timelineStartSeconds });
}

export async function duplicateClips(
  placements: Array<{ clipId: string; timelineStartSeconds: number }>,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("duplicate_clips", { placements });
}

export async function splitClip(
  clipId: string,
  splitSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("split_clip", { clipId, splitSeconds });
}

/**
 * Batched split for a multi-selection. Splits every clip in `clipIds`
 * whose timeline span contains `splitSeconds`; clips that don't contain
 * the cursor are left untouched. One persisted snapshot, one history
 * entry. Backend is the authority on which clips actually qualify.
 */
export async function splitClips(
  clipIds: string[],
  splitSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("split_clips", {
    clipIds,
    splitSeconds,
  });
}

export async function createSongRegion(
  startSeconds: number,
  endSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("create_song_region", { startSeconds, endSeconds });
}

/**
 * Append an empty song (region) to the project. Backs the compact view's
 * "+ Nueva canción" button. The new song is placed one bar after the last
 * existing song's end (or at the timeline start when the project has no
 * songs yet) and is itself one bar wide so it shows up in the DAW view.
 * It resizes to fit when the user drops the first clip into it.
 */
export async function createEmptySong(name?: string): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("create_empty_song", { name: name ?? null });
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

/**
 * Atomically translate a song region by `deltaSeconds`. Moves the region
 * AND every clip / tempo marker / section marker / time-signature
 * marker that lived inside it by the same offset, in a single backend
 * transaction (one snapshot, one undo entry). Backend rejects the move
 * if the new range would collide with a neighbouring region.
 */
export async function moveSongRegion(
  regionId: string,
  deltaSeconds: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("move_song_region", {
    regionId,
    deltaSeconds,
  });
}

export async function updateSongRegionTranspose(
  regionId: string,
  transposeSemitones: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_song_region_transpose", {
    regionId,
    transposeSemitones,
  });
}

/**
 * Toggle warp on a region and/or set its source BPM. `warpEnabled = true`
 * requires a finite `warpSourceBpm` between 20 and 300; when disabling warp
 * pass `null` to leave the previously-configured source BPM untouched.
 */
export async function updateSongRegionWarp(
  regionId: string,
  warpEnabled: boolean,
  warpSourceBpm: number | null,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_song_region_warp", {
    regionId,
    warpEnabled,
    warpSourceBpm,
  });
}

/**
 * Realtime stream of region master gain during a slider drag. Bridge-only:
 * the engine receives the new value but the model is not written and no
 * snapshot is returned. Call `updateSongRegionMasterGain` on pointer-up to
 * commit the value (writes model, records undo, returns snapshot).
 */
export async function updateLiveRegionMasterGain(
  regionId: string,
  masterGain: number,
): Promise<void> {
  return invokeCommand<void>("update_live_region_master_gain", {
    regionId,
    masterGain,
  });
}

/**
 * Commit the master fader gain for a song region. `masterGain` is a linear
 * multiplier: 1.0 means unity, 0.0 means silent. Must be finite and >= 0.
 */
export async function updateSongRegionMasterGain(
  regionId: string,
  masterGain: number,
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_song_region_master_gain", {
    regionId,
    masterGain,
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

export type CreateClipWithAutoTrackArgs = {
  filePath: string;
  timelineStartSeconds: number;
};

/**
 * Drop one or more audio files into a compact-view song column. The backend
 * creates one auto-track per file (name = file stem) and one clip per
 * auto-track, all landing at the same `timelineStartSeconds`. Auto-tracks
 * are deleted automatically the moment their clip is moved elsewhere or
 * removed (so the mixer doesn't accumulate one-shot tracks).
 */
export async function createClipsWithAutoTracks(
  args: CreateClipWithAutoTrackArgs[],
): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("create_clips_with_auto_tracks", {
    requests: args,
  });
}

/**
 * Reassign a clip to a different track without moving its timeline position.
 * Backs the compact-view right-click "Mover a track…" submenu. When the
 * clip's previous track was auto-created and loses its only clip, the track
 * is removed in the same operation (undo restores both).
 */
export async function moveClipToTrack(args: {
  clipId: string;
  targetTrackId: string;
}): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("move_clip_to_track", args);
}

export async function moveTrack(args: {
  trackId: string;
  insertAfterTrackId?: string | null;
  insertBeforeTrackId?: string | null;
  parentTrackId?: string | null;
}): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("move_track", args);
}

/** RuntimeUpdateKind: ModelOnly — name/metadata only. Use commitTrackMixChange for audio fields. */
export async function updateTrack(args: {
  trackId: string;
  name?: string;
}): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_track", args);
}

export async function updateTrackColor(args: {
  trackId: string;
  color: string | null;
}): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_track_color", args);
}

export async function commitTrackMixChange(args: {
  trackId: string;
  volume?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
  audioTo?: string;
}): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("commit_track_mix_change", args);
}

export async function updateTrackTransposeEnabled(args: {
  trackId: string;
  transposeEnabled: boolean;
}): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("update_track_transpose_enabled", args);
}

export async function updateTrackMixRealtime(args: {
  trackId: string;
  volume?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
}): Promise<void> {
  await invokeCommand("update_track_mix_realtime", args);
}

export async function setMetronomeEnabledRealtime(enabled: boolean): Promise<void> {
  await invokeCommand("set_metronome_enabled_realtime", { enabled });
}

export async function setMetronomeVolumeRealtime(volume: number): Promise<void> {
  await invokeCommand("set_metronome_volume_realtime", { volume });
}

export async function setMetronomeSoundRealtime(
  settings: AppSettings,
): Promise<AppSettings> {
  return invokeCommand<AppSettings>("set_metronome_sound_realtime", {
    settings,
  });
}

export async function deleteTrack(trackId: string): Promise<TransportSnapshot> {
  return invokeCommand<TransportSnapshot>("delete_track", { trackId });
}
