/**
 * How one musician wants to READ the chords, on their own device, without
 * changing the song for anyone else (network-session guests, plan
 * network-sessions step 07).
 *
 * - `capo`: the guitarist's capo fret. Chords drop by that many semitones so
 *   they show the shapes the fingers make, not the sounding chords.
 * - `transpose`: the musician's own shift on top of the song's.
 * - `accidentals`: sharps or flats for the transposed chords; `auto` follows
 *   the key the musician ends up reading in.
 *
 * Unlike StageTraxx, whose capo is a value of the SONG (set by whoever owns
 * it), this is per device and per song, so each player brings their own.
 */

import { keyPrefersFlats, transposeChord } from "./chordNotation";

export type AccidentalPreference = "auto" | "sharps" | "flats";

export type ChordPrefs = {
  capo: number;
  transpose: number;
};

export const NO_CHORD_PREFS: ChordPrefs = { capo: 0, transpose: 0 };

export const MAX_CAPO = 7;
export const MAX_PERSONAL_TRANSPOSE = 11;

export function clampChordPrefs(prefs: ChordPrefs): ChordPrefs {
  const whole = (value: number) => (Number.isFinite(value) ? Math.round(value) : 0);
  return {
    capo: Math.min(MAX_CAPO, Math.max(0, whole(prefs.capo))),
    transpose: Math.min(
      MAX_PERSONAL_TRANSPOSE,
      Math.max(-MAX_PERSONAL_TRANSPOSE, whole(prefs.transpose)),
    ),
  };
}

/** Semitones to add on top of the song's own transposition. */
export function personalChordShift(prefs: ChordPrefs): number {
  const { capo, transpose } = clampChordPrefs(prefs);
  return transpose - capo;
}

/**
 * Whether to spell with flats. `songKey` is the key the song sounds in
 * (already transposed by the song); `shift` is the personal shift.
 */
export function personalPrefersFlats(
  songKey: string | null | undefined,
  shift: number,
  accidentals: AccidentalPreference,
): boolean {
  if (accidentals === "flats") return true;
  if (accidentals === "sharps") return false;
  if (!songKey) return false;
  // Spell the key being read with flats and ask whether that is a flat key:
  // spelled with sharps first, Db would come out as C# and never match.
  const readKey = shift ? transposeChord(songKey, shift, true) : songKey;
  return keyPrefersFlats(readKey);
}

export type PersonalChordStore = {
  accidentals: AccidentalPreference;
  /** Prefs per song (host region id). A song without an entry reads plain. */
  bySong: Record<string, ChordPrefs>;
};

export const EMPTY_PERSONAL_CHORD_STORE: PersonalChordStore = {
  accidentals: "auto",
  bySong: {},
};

export function chordPrefsFor(store: PersonalChordStore, songId: string | null): ChordPrefs {
  if (!songId) return NO_CHORD_PREFS;
  return clampChordPrefs(store.bySong[songId] ?? NO_CHORD_PREFS);
}

export function withChordPrefs(
  store: PersonalChordStore,
  songId: string,
  prefs: ChordPrefs,
): PersonalChordStore {
  const clamped = clampChordPrefs(prefs);
  const bySong = { ...store.bySong };
  if (clamped.capo === 0 && clamped.transpose === 0) delete bySong[songId];
  else bySong[songId] = clamped;
  return { ...store, bySong };
}

/** Tolerant parse of what was stored: anything odd falls back to empty. */
export function parsePersonalChordStore(raw: string | null): PersonalChordStore {
  if (!raw) return EMPTY_PERSONAL_CHORD_STORE;
  try {
    const value = JSON.parse(raw) as Partial<PersonalChordStore>;
    const accidentals: AccidentalPreference =
      value.accidentals === "sharps" || value.accidentals === "flats" ? value.accidentals : "auto";
    const bySong: Record<string, ChordPrefs> = {};
    if (value.bySong && typeof value.bySong === "object") {
      for (const [songId, prefs] of Object.entries(value.bySong)) {
        if (prefs && typeof prefs === "object") {
          bySong[songId] = clampChordPrefs({
            capo: Number((prefs as ChordPrefs).capo),
            transpose: Number((prefs as ChordPrefs).transpose),
          });
        }
      }
    }
    return { accidentals, bySong };
  } catch {
    return EMPTY_PERSONAL_CHORD_STORE;
  }
}
