/**
 * Which rows of the MIDI clip / automation cue editors are folded, per item,
 * for the session: fold a long list, save, reopen it and it is still folded.
 * A view preference, so it lives in memory and never in the song.
 *
 * A new item has no id until it is saved; its editor uses the `…:new` key and
 * whoever mints the id moves the folds over with `moveFolds`.
 */
const folds = new Map<string, Set<string>>();

export const NEW_MIDI_CLIP_FOLD_KEY = "midi:new";
export const NEW_CUE_FOLD_KEY = "cue:new";

export function midiClipFoldKey(clipId: string | null): string {
  return clipId ? `midi:${clipId}` : NEW_MIDI_CLIP_FOLD_KEY;
}

export function cueFoldKey(cueId: string | null): string {
  return cueId ? `cue:${cueId}` : NEW_CUE_FOLD_KEY;
}

/** The folded rows remembered for `key` (a copy). A new item starts open. */
export function foldsFor(key: string): Set<string> {
  if (key.endsWith(":new")) return new Set();
  return new Set(folds.get(key) ?? []);
}

export function rememberFolds(key: string, rows: Iterable<string | number>): void {
  const set = new Set(Array.from(rows, String));
  if (set.size === 0) folds.delete(key);
  else folds.set(key, set);
}

export function moveFolds(from: string, to: string): void {
  const set = folds.get(from);
  folds.delete(from);
  if (set) folds.set(to, set);
}

export function resetFoldsForTests(): void {
  folds.clear();
}
