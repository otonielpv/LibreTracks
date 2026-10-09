import type { LibraryAssetSummary, SongView } from "@libretracks/shared/models";

export type OrganizePlan = {
  /** One entry per song folder, in timeline order. */
  moves: Array<{ folder: string; filePaths: string[] }>;
  /** Unfiled audio that no clip uses: stays in "Unfiled". */
  unused: number;
  /** Unfiled audio used by several songs (a shared click): stays too. */
  shared: number;
};

const normalizePath = (path: string) => path.replace(/\\/g, "/");

/** A song's name as a library folder name: no separators, never empty. */
export function songFolderName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\\/]+/g, "-").trim();
  return cleaned || fallback;
}

/**
 * "Organise by song" for the classic library: each unfiled asset goes to a
 * folder named after the song its clips are in. The relationship is
 * positional, like everything about songs: a clip belongs to the song whose
 * range it overlaps. Audio used by more than one song, or by none, is left
 * where it is — guessing would scatter a shared click into a random song.
 */
export function planOrganizeBySong(
  unfiledAssets: LibraryAssetSummary[],
  song: SongView | null,
  fallbackName = "Song",
): OrganizePlan {
  const regions = [...(song?.regions ?? [])].sort(
    (left, right) => left.startSeconds - right.startSeconds,
  );
  const clips = song?.clips ?? [];
  const byFolder = new Map<string, { order: number; filePaths: string[] }>();
  let unused = 0;
  let shared = 0;

  for (const asset of unfiledAssets) {
    const path = normalizePath(asset.filePath);
    const songIds = new Set<string>();
    for (const clip of clips) {
      if (normalizePath(clip.filePath) !== path) continue;
      const end = clip.timelineStartSeconds + clip.durationSeconds;
      for (const region of regions) {
        if (clip.timelineStartSeconds < region.endSeconds && end > region.startSeconds) {
          songIds.add(region.id);
        }
      }
    }
    if (songIds.size === 0) {
      unused += 1;
      continue;
    }
    if (songIds.size > 1) {
      shared += 1;
      continue;
    }
    const order = regions.findIndex((candidate) => songIds.has(candidate.id));
    if (order < 0) continue;
    const folder = songFolderName(regions[order].name, fallbackName);
    const bucket = byFolder.get(folder);
    if (bucket) bucket.filePaths.push(asset.filePath);
    else byFolder.set(folder, { order, filePaths: [asset.filePath] });
  }

  return {
    moves: [...byFolder]
      .sort((left, right) => left[1].order - right[1].order)
      .map(([folder, { filePaths }]) => ({ folder, filePaths })),
    unused,
    shared,
  };
}
