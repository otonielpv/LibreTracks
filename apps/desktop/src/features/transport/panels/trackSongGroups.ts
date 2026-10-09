import type {
  SongRegionSummary,
  SongView,
  TrackSummary,
} from "@libretracks/shared/models";

/**
 * Pistas agrupadas por la canción en la que suenan, para el selector de pista
 * de los automatismos.
 *
 * Por qué existe: una sesión con cinco canciones tiene cinco «Drums», y un
 * desplegable plano con `track.name` no deja saber cuál es cuál. Es el mismo
 * problema que `groupMarkersBySong` resolvió para los destinos de salto, con
 * una diferencia: una pista no guarda su canción y no tiene posición propia.
 * Pertenece a las canciones donde caen sus clips, y puede caer en varias (un
 * «Click» compartido por toda la sesión).
 */
export type TrackSongGroup = {
  /** `null` = pistas sin clips en ninguna canción. */
  region: SongRegionSummary | null;
  /** Pistas del grupo, en el orden de la sesión. Nunca vacío. */
  tracks: TrackSummary[];
};

type ClipSpan = { trackId: string; start: number; end: number };

function clipSpans(song: SongView): ClipSpan[] {
  const spans: ClipSpan[] = song.clips.map((clip) => ({
    trackId: clip.trackId,
    start: clip.timelineStartSeconds,
    end: clip.timelineStartSeconds + clip.durationSeconds,
  }));
  // Los clips MIDI no tienen duración en la vista: cuenta su inicio.
  for (const clip of song.midiClips ?? []) {
    spans.push({
      trackId: clip.trackId,
      start: clip.timelineStartSeconds,
      end: clip.timelineStartSeconds,
    });
  }
  return spans;
}

function spanTouchesRegion(span: ClipSpan, region: SongRegionSummary) {
  if (span.start === span.end) {
    return span.start >= region.startSeconds && span.start < region.endSeconds;
  }
  return span.start < region.endSeconds && span.end > region.startSeconds;
}

/** Ids de las canciones (en orden de timeline) en las que suena cada pista. */
export function songIdsByTrack(song: SongView): Map<string, string[]> {
  const regions = [...song.regions].sort(
    (left, right) => left.startSeconds - right.startSeconds,
  );
  const spans = clipSpans(song);
  const byTrack = new Map<string, string[]>();
  for (const region of regions) {
    const seen = new Set<string>();
    for (const span of spans) {
      if (seen.has(span.trackId) || !spanTouchesRegion(span, region)) continue;
      seen.add(span.trackId);
      const ids = byTrack.get(span.trackId);
      if (ids) ids.push(region.id);
      else byTrack.set(span.trackId, [region.id]);
    }
  }
  return byTrack;
}

/**
 * Reparte las pistas (sin carpetas) entre las canciones donde suenan. Una pista
 * que suena en varias aparece en cada una; las que no suenan en ninguna van al
 * grupo final con `region: null`. Grupos en orden de timeline y sin vacíos.
 */
export function groupTracksBySong(song: SongView | null): TrackSongGroup[] {
  if (!song) return [];
  const tracks = song.tracks.filter((track) => track.kind !== "folder");
  const byTrack = songIdsByTrack(song);
  const regions = [...song.regions].sort(
    (left, right) => left.startSeconds - right.startSeconds,
  );

  const groups: TrackSongGroup[] = [];
  for (const region of regions) {
    const inRegion = tracks.filter((track) =>
      byTrack.get(track.id)?.includes(region.id),
    );
    if (inRegion.length > 0) groups.push({ region, tracks: inRegion });
  }
  const orphans = tracks.filter((track) => !byTrack.has(track.id));
  if (orphans.length > 0) groups.push({ region: null, tracks: orphans });
  return groups;
}

/** La primera pista de la canción que contiene `seconds`, o la primera de la
 * sesión si ese punto no cae en ninguna canción con pistas. */
export function defaultTrackIdAt(song: SongView | null, seconds: number): string {
  const groups = groupTracksBySong(song);
  const here = groups.find(
    (group) =>
      group.region !== null &&
      seconds >= group.region.startSeconds &&
      seconds < group.region.endSeconds,
  );
  return (
    here?.tracks[0]?.id ??
    song?.tracks.find((track) => track.kind !== "folder")?.id ??
    ""
  );
}

/**
 * Nombre de una pista para leerlo fuera del selector (tooltip del cue): el
 * nombre a secas si es único en la sesión, y con su canción entre paréntesis
 * si se repite — «Drums (Way Maker)».
 */
export function trackDisplayName(song: SongView | null, trackId: string): string {
  const track = song?.tracks.find((candidate) => candidate.id === trackId);
  if (!song || !track) return trackId;
  const repeated = song.tracks.some(
    (other) =>
      other.id !== track.id &&
      other.kind !== "folder" &&
      other.name === track.name,
  );
  if (!repeated) return track.name;
  const songNames = (songIdsByTrack(song).get(track.id) ?? [])
    .map((id) => song.regions.find((region) => region.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  return songNames.length > 0
    ? `${track.name} (${songNames.join(", ")})`
    : track.name;
}
