import type {
  SectionMarkerSummary,
  SongRegionSummary,
} from "@libretracks/shared/models";

/**
 * Marcas agrupadas por la canción que las contiene, para el selector de
 * destino de un salto.
 *
 * Por qué existe: las marcas no guardan a qué canción pertenecen, la relación
 * es puramente posicional. Un desplegable plano con todas las marcas de la
 * sesión es inutilizable en cuanto dos canciones comparten nombres de sección
 * ("Coro", "Verso 1"), que es justo lo normal.
 */
export type JumpMarkerGroup = {
  /** `null` = marcas que caen fuera de toda región de canción. */
  region: SongRegionSummary | null;
  /** Marcas del grupo, en orden de tiempo. Nunca vacío. */
  markers: SectionMarkerSummary[];
};

/**
 * Reparte `markers` entre las canciones que los contienen. Una marca pertenece
 * a la región cuyo rango `[startSeconds, endSeconds)` la cubre; las que no
 * caen en ninguna van al grupo final con `region: null`.
 *
 * Los grupos salen en orden de timeline y sin grupos vacíos: una canción sin
 * marcas no aparece.
 */
export function groupMarkersBySong(
  regions: SongRegionSummary[],
  markers: SectionMarkerSummary[],
): JumpMarkerGroup[] {
  const sortedRegions = [...regions].sort(
    (left, right) => left.startSeconds - right.startSeconds,
  );
  const sortedMarkers = [...markers].sort(
    (left, right) => left.startSeconds - right.startSeconds,
  );

  const byRegion = new Map<string, SectionMarkerSummary[]>();
  const orphans: SectionMarkerSummary[] = [];

  for (const marker of sortedMarkers) {
    const region = sortedRegions.find(
      (candidate) =>
        marker.startSeconds >= candidate.startSeconds &&
        marker.startSeconds < candidate.endSeconds,
    );
    if (!region) {
      orphans.push(marker);
      continue;
    }
    const bucket = byRegion.get(region.id);
    if (bucket) bucket.push(marker);
    else byRegion.set(region.id, [marker]);
  }

  const groups: JumpMarkerGroup[] = [];
  for (const region of sortedRegions) {
    const bucket = byRegion.get(region.id);
    if (bucket && bucket.length > 0) groups.push({ region, markers: bucket });
  }
  if (orphans.length > 0) groups.push({ region: null, markers: orphans });

  return groups;
}

/**
 * Nombres que se repiten dentro de un mismo grupo. El selector les añade la
 * posición para poder distinguirlas: agrupar por canción no ayuda cuando la
 * misma canción tiene dos "Coro".
 */
export function duplicateMarkerNames(
  markers: SectionMarkerSummary[],
): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const marker of markers) {
    if (seen.has(marker.name)) duplicated.add(marker.name);
    else seen.add(marker.name);
  }
  return duplicated;
}
