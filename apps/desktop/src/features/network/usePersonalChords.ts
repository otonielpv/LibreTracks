import { useCallback, useState } from "react";

import {
  chordPrefsFor,
  parsePersonalChordStore,
  withChordPrefs,
  type AccidentalPreference,
  type ChordPrefs,
  type PersonalChordStore,
} from "@libretracks/shared/charts/personalChords";

/** Per device, never sent to the host: this is how THIS musician reads. */
export const PERSONAL_CHORDS_KEY = "lt.network.personalChords";

function read(): PersonalChordStore {
  try {
    return parsePersonalChordStore(window.localStorage.getItem(PERSONAL_CHORDS_KEY));
  } catch {
    return parsePersonalChordStore(null);
  }
}

function write(store: PersonalChordStore) {
  try {
    window.localStorage.setItem(PERSONAL_CHORDS_KEY, JSON.stringify(store));
  } catch {
    // Blocked storage: the preference holds until the screen closes.
  }
}

export function usePersonalChords(songId: string | null) {
  const [store, setStore] = useState(read);
  const prefs = chordPrefsFor(store, songId);

  const setPrefs = useCallback(
    (next: ChordPrefs) => {
      if (!songId) return;
      setStore((current) => {
        const updated = withChordPrefs(current, songId, next);
        write(updated);
        return updated;
      });
    },
    [songId],
  );

  const setAccidentals = useCallback((accidentals: AccidentalPreference) => {
    setStore((current) => {
      const updated = { ...current, accidentals };
      write(updated);
      return updated;
    });
  }, []);

  return { prefs, accidentals: store.accidentals, setPrefs, setAccidentals };
}
