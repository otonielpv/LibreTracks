import type { TFunction } from "i18next";

import type { SongView } from "@libretracks/shared/models";

const DURATION_OVERLAP_PATTERN =
  /region duration change would overlap: (\S+) with (\S+)/;
const REGION_OVERLAP_PATTERN =
  /regions are out of order or overlap: (\S+) before (\S+)/;

function regionName(song: SongView | null, regionId: string): string | null {
  return song?.regions.find((region) => region.id === regionId)?.name ?? null;
}

function namedRegion(
  song: SongView | null,
  regionId: string,
  t: TFunction,
): string {
  return regionName(song, regionId) ?? t("transport.errors.unknownSong");
}

/**
 * Turns stable backend/domain errors into localized, actionable UI messages.
 * Unknown errors deliberately keep their original detail for diagnostics.
 */
export function formatTransportError(
  error: unknown,
  t: TFunction,
  song: SongView | null = null,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLocaleLowerCase();

  const durationOverlap = raw.match(DURATION_OVERLAP_PATTERN);
  if (durationOverlap) {
    return t("transport.errors.regionDurationOverlap", {
      song: namedRegion(song, durationOverlap[1], t),
      blockingSong: namedRegion(song, durationOverlap[2], t),
    });
  }

  // Older backends and validation paths can still return the generic domain
  // error. Resolve its ids against the current SongView so it is useful too.
  const regionOverlap = raw.match(REGION_OVERLAP_PATTERN);
  if (regionOverlap) {
    return t("transport.errors.regionsOverlap", {
      firstSong: namedRegion(song, regionOverlap[1], t),
      secondSong: namedRegion(song, regionOverlap[2], t),
    });
  }

  if (raw.includes("no song is loaded")) {
    return t("transport.errors.noSongLoaded");
  }
  if (raw.includes("transport state is unavailable")) {
    return t("transport.errors.stateUnavailable");
  }
  if (raw.includes("clip range is invalid")) {
    return t("transport.errors.invalidClipRange");
  }
  if (raw.includes("track parent is invalid")) {
    return t("transport.errors.invalidTrackParent");
  }
  if (raw.includes("clip split point is invalid")) {
    return t("transport.errors.invalidSplitPoint");
  }

  const movedOverSong = raw.match(
    /no se puede mover la canci[oó]n ah[ií]: solapar[ií]a con '([^']+)'/i,
  );
  if (movedOverSong) {
    return t("transport.errors.songMoveOverlap", {
      blockingSong: movedOverSong[1],
    });
  }
  if (lower.includes("no se puede mover la canción antes del inicio")) {
    return t("transport.errors.songBeforeProjectStart");
  }
  if (
    lower.includes("no se puede reducir la region") ||
    lower.includes("no se puede reducir la región")
  ) {
    return t("transport.errors.regionResizeLeavesClipsOutside");
  }

  if (
    lower.includes("region bounds must be finite") ||
    lower.includes("region end must be greater than region start")
  ) {
    return t("transport.errors.invalidRegionBounds");
  }
  if (lower.includes("color must be a #rrggbb hex value")) {
    return t("transport.errors.invalidColor");
  }
  if (lower.includes("region name must not be empty")) {
    return t("transport.errors.emptySongName");
  }
  if (lower.includes("section name must not be empty")) {
    return t("transport.errors.emptySectionName");
  }
  if (lower.includes("track name must not be empty")) {
    return t("transport.errors.emptyTrackName");
  }
  if (
    lower.includes("warp source bpm must") ||
    lower.includes("warp source bpm is required") ||
    lower.includes("has warp enabled but no source bpm") ||
    lower.includes("has invalid warp source bpm")
  ) {
    return t("transport.errors.invalidWarpBpm");
  }
  if (
    lower.includes("transpose semitones must be between") ||
    lower.includes("has invalid transpose semitones")
  ) {
    return t("transport.errors.invalidTranspose");
  }
  if (
    lower.includes("song bpm must be between") ||
    lower.includes("song bpm marker must be between")
  ) {
    return t("transport.errors.invalidBpm");
  }
  if (lower.includes("time signature is invalid")) {
    return t("transport.errors.invalidTimeSignature");
  }
  if (
    lower.includes("master gain must be") ||
    lower.includes("has invalid master gain")
  ) {
    return t("transport.errors.invalidGain");
  }

  if (
    lower.includes("clip cannot target a folder track") ||
    lower.includes("no se puede mover un clip a un folder")
  ) {
    return t("transport.errors.clipCannotUseFolderTrack");
  }
  if (lower.includes("clip must have a positive duration")) {
    return t("transport.errors.invalidClipDuration");
  }
  if (lower.includes("no cabe en este hueco")) {
    return t("transport.errors.clipDoesNotFit");
  }

  if (
    lower.includes(
      "cannot delete a library asset that is already used on the timeline",
    )
  ) {
    return t("transport.errors.libraryAssetInUse");
  }
  if (lower.includes("library asset was not found")) {
    return t("transport.errors.libraryAssetNotFound");
  }
  if (lower.includes("library folder was not found")) {
    return t("transport.errors.libraryFolderNotFound");
  }
  if (
    lower.includes("folder path cannot be empty") ||
    lower.includes("new folder path must not target the same folder")
  ) {
    return t("transport.errors.invalidLibraryFolder");
  }
  if (
    lower.includes("imported file name") ||
    lower.includes("imported file extension is invalid") ||
    lower.includes("source path is required for audio import")
  ) {
    return t("transport.errors.invalidAudioImportFile");
  }
  if (
    lower.includes("at least one audio file is required") ||
    lower.includes("wav import requires at least one audio file")
  ) {
    return t("transport.errors.noAudioFilesSelected");
  }
  if (lower.includes("staged import source not found")) {
    return t("transport.errors.stagedImportMissing");
  }

  if (
    lower.includes("midi clip must target a midi track") ||
    lower.includes("midi routing can only be set on a midi track") ||
    lower.includes("not a midi track")
  ) {
    return t("transport.errors.midiTrackRequired");
  }
  if (lower.includes("midi channel must be")) {
    return t("transport.errors.invalidMidiChannel");
  }
  if (lower.includes("mix scene id is required")) {
    return t("transport.errors.mixSceneUnavailable");
  }

  if (lower.includes("no se pudo determinar la carpeta destino")) {
    return t("transport.errors.destinationFolderUnavailable");
  }
  if (lower.includes("el nombre del proyecto no es valido")) {
    return t("transport.errors.invalidProjectName");
  }
  const existingFolder = raw.match(
    /ya existe una carpeta llamada "([^"]+)" en esa ubicacion/i,
  );
  if (existingFolder) {
    return t("transport.errors.projectFolderExists", {
      name: existingFolder[1],
    });
  }

  if (lower.includes("pad name is empty")) {
    return t("transport.errors.emptyPadName");
  }
  if (lower.includes("pad is not a user pad")) {
    return t("transport.errors.officialPadReadOnly");
  }
  if (lower.includes("source file not found")) {
    return t("transport.errors.sourceAudioNotFound");
  }
  if (lower.includes("archive contained no recognised pad keys")) {
    return t("transport.errors.invalidPadArchive");
  }
  if (
    lower.includes("manifest request failed") ||
    lower.includes("download request failed") ||
    lower.includes("download returned http") ||
    lower.includes("download stream error")
  ) {
    return t("transport.errors.padDownloadFailed");
  }
  if (
    lower.includes("create pad dir failed") ||
    lower.includes("write pad meta") ||
    lower.includes("delete pad failed") ||
    lower.includes("assign task panicked")
  ) {
    return t("transport.errors.padFileOperationFailed");
  }

  if (lower.includes("state lock poisoned")) {
    return t("transport.errors.audioStateUnavailable");
  }

  if (
    lower.includes("song must have a title") ||
    lower.includes("song duration must be greater than zero") ||
    /region \S+ has invalid bounds/.test(lower)
  ) {
    return t("transport.errors.invalidSongStructure");
  }
  if (
    lower.includes("duplicate track id") ||
    lower.includes("duplicate clip id") ||
    lower.includes("duplicate midi clip id") ||
    lower.includes("references unknown parent track") ||
    lower.includes("references unknown track") ||
    (lower.includes("audio clip") &&
      lower.includes("cannot target midi track")) ||
    lower.includes("track hierarchy contains a cycle") ||
    lower.includes("cannot parent itself")
  ) {
    return t("transport.errors.invalidTrackStructure");
  }
  if (lower.includes("falls outside every region")) {
    return t("transport.errors.clipOutsideSong");
  }
  if (lower.includes("spans the boundary between region")) {
    return t("transport.errors.clipCrossesSongs");
  }
  if (
    lower.includes("marker has invalid") ||
    lower.includes("marker digit is duplicated") ||
    lower.includes("markers are out of order") ||
    lower.includes("time signature markers are out of order") ||
    (lower.includes("time signature marker") &&
      lower.includes("is invalid")) ||
    /marker \S+ has invalid (position|digit)/.test(lower)
  ) {
    return t("transport.errors.invalidMarker");
  }
  if (
    (lower.includes("midi event") && lower.includes("invalid")) ||
    (lower.includes("midi track") && lower.includes("invalid channel")) ||
    (lower.includes("midi clip") && lower.includes("invalid position"))
  ) {
    return t("transport.errors.invalidMidiData");
  }
  if (lower.includes("unsupported song format version")) {
    return t("transport.errors.unsupportedProjectVersion");
  }
  if (lower.includes("unsupported audio format")) {
    return t("transport.errors.unsupportedAudioFormat");
  }
  if (
    lower.includes("audio decode error") ||
    lower.includes("wav error:") ||
    lower.includes("make decoder") ||
    lower.includes("decode packet")
  ) {
    return t("transport.errors.audioDecodeFailed");
  }
  if (lower.includes("position must be non-negative")) {
    return t("transport.errors.invalidPlaybackPosition");
  }
  if (lower.includes("vamp range is invalid")) {
    return t("transport.errors.invalidVampRange");
  }
  if (
    lower.includes("audio device error") ||
    lower.includes("failed to open audio device")
  ) {
    return t("transport.errors.audioDeviceFailed");
  }
  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network request failed")
  ) {
    return t("transport.errors.networkUnavailable");
  }

  const missingItem = raw.match(
    /(clip|track|region|section) not found: (\S+)/,
  );
  if (missingItem) {
    return t("transport.errors.itemNotFound", {
      item: t(`transport.errors.item.${missingItem[1]}`),
    });
  }

  const markerNotFound = lower.match(
    /(marker|tempo marker|time signature marker) not found/,
  );
  if (markerNotFound) {
    return t("transport.errors.markerNotFound");
  }

  if (lower.includes("io error:") || lower.includes("json error:")) {
    return t("transport.errors.fileOperationFailed", { message: raw });
  }
  if (lower.includes("audio engine error:")) {
    return t("transport.errors.audioEngineFailed", { message: raw });
  }
  if (
    lower.includes("audio command failed:") ||
    lower.includes("project error:")
  ) {
    return t("transport.errors.operationFailed", { message: raw });
  }

  return t("transport.status.error", { message: raw });
}

export const formatUserFacingError = formatTransportError;
