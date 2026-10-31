import type {
  MixSceneRule,
  MixSceneSummary,
  MixSceneTrackSelector,
  SongView,
} from "@libretracks/shared/models";

import { activeSongTrackIds } from "../../midi/midiBankStore";

/**
 * The scene logic the editor needs to show what a scene does: a mirror of
 * `resolve_scene` in `crates/libretracks-core/src/mix_scene.rs`. The core
 * decides what sounds; this only feeds the preview, so the editor answers
 * as you type without a round trip per keystroke.
 */

/** Lowercase without accents, like the core's `fold_text`. */
export function foldText(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Words typed as "voz, vox" → ["voz", "vox"]. */
export function parseWords(text: string) {
  return text
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

function selectorPicks(
  selector: MixSceneTrackSelector,
  song: SongView,
  activeSong: Set<string> | null,
): Set<string> {
  const audioInSong = song.tracks.filter(
    (track) => track.kind === "audio" && activeSong?.has(track.id),
  );
  switch (selector.type) {
    case "track":
      return new Set(
        song.tracks.filter((track) => track.id === selector.trackId).map((track) => track.id),
      );
    case "activeSong":
      return new Set(audioInSong.map((track) => track.id));
    case "folder": {
      const wanted = foldText(selector.name.trim());
      if (!wanted) return new Set();
      const folders = new Set(
        song.tracks
          .filter((track) => track.kind === "folder" && foldText(track.name) === wanted)
          .map((track) => track.id),
      );
      const byId = new Map(song.tracks.map((track) => [track.id, track]));
      const underFolder = (trackId: string) => {
        const seen = new Set<string>();
        let parentId = byId.get(trackId)?.parentTrackId;
        while (parentId && !seen.has(parentId)) {
          if (folders.has(parentId)) return true;
          seen.add(parentId);
          parentId = byId.get(parentId)?.parentTrackId;
        }
        return false;
      };
      return new Set(audioInSong.filter((track) => underFolder(track.id)).map((track) => track.id));
    }
    case "nameContains": {
      const words = selector.words.map((word) => foldText(word.trim())).filter(Boolean);
      if (words.length === 0) return new Set();
      return new Set(
        audioInSong
          .filter((track) => {
            const name = foldText(track.name);
            return words.some((word) => name.includes(word));
          })
          .map((track) => track.id),
      );
    }
  }
}

function changeIsEmpty(rule: MixSceneRule) {
  const { volume, pan, muted, solo } = rule.change;
  return volume == null && pan == null && muted == null && solo == null;
}

/** The ids of the tracks the scene touches, in track order. */
export function resolveSceneTrackIds(
  scene: MixSceneSummary,
  song: SongView | null,
  activeRegionId: string | null,
): string[] {
  if (!song) return [];
  const activeSong = activeSongTrackIds(song, activeRegionId);
  const touched = new Set<string>();
  for (const rule of scene.rules) {
    if (changeIsEmpty(rule)) continue;
    const picked = selectorPicks(rule.select, song, activeSong);
    for (const except of rule.except ?? []) {
      for (const id of selectorPicks(except, song, activeSong)) picked.delete(id);
    }
    for (const id of picked) touched.add(id);
  }
  return song.tracks.filter((track) => touched.has(track.id)).map((track) => track.id);
}

/** Folder names of the session, once each, for the Folder selector. */
export function folderNames(song: SongView | null): string[] {
  const seen = new Map<string, string>();
  for (const track of song?.tracks ?? []) {
    if (track.kind !== "folder") continue;
    const key = foldText(track.name.trim());
    if (key && !seen.has(key)) seen.set(key, track.name.trim());
  }
  return [...seen.values()].sort((left, right) => left.localeCompare(right));
}

/**
 * Scene rules a session template leaves out: those naming a track id, which
 * a template does not keep (mirror of `scenes_for_template` in the core).
 */
export function templateDroppedRuleCount(scenes: MixSceneSummary[] | undefined) {
  return (scenes ?? []).reduce(
    (count, scene) => count + scene.rules.filter((rule) => rule.select.type === "track").length,
    0,
  );
}

/** Words the quick "band down" scene leaves alone. */
export const BAND_DOWN_EXCEPT_WORDS = ["voz", "voc", "vox", "click", "guía", "guide"];

/** The quick scene: the active song but voices, click and guide, -12 dB. */
export function bandDownScene(id: string, name: string): MixSceneSummary {
  return {
    id,
    name,
    rampSeconds: 2,
    rules: [
      {
        select: { type: "activeSong" },
        except: [{ type: "nameContains", words: [...BAND_DOWN_EXCEPT_WORDS] }],
        change: { volume: { type: "relativeDb", value: -12 } },
      },
    ],
  };
}

/** A new rule: the active song, -6 dB. */
export function defaultRule(): MixSceneRule {
  return {
    select: { type: "activeSong" },
    change: { volume: { type: "relativeDb", value: -6 } },
  };
}

export function createSceneId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `scene-${crypto.randomUUID()}`;
  }
  return `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `ids` with the one at `from` moved to `to`. */
export function moveId(ids: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return ids;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
