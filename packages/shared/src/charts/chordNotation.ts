/**
 * Chord symbols: recognising them in free text and transposing them.
 *
 * Both notations musicians actually write are accepted — American (`C`, `F#m7`,
 * `Bb/D`) and Latin (`Do`, `Fa#m7`, `Sib/Re`) — and a transposed chord keeps
 * the notation it was written in.
 */

const LATIN_ROOTS = ["Do", "Re", "Mi", "Fa", "Sol", "La", "Si"] as const;
const AMERICAN_ROOTS = ["C", "D", "E", "F", "G", "A", "B"] as const;
/** Semitone of each natural, shared by both notations (same index). */
const NATURAL_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

const ROOT = "(?:Sol|Do|Re|Mi|Fa|La|Si|[A-G])";
const ACCIDENTAL = "(?:##|bb|#|b|♯|♭)?";
const QUALITY = "(?:maj|Maj|MAJ|ma|M|Δ|min|m|-|dim|°|aug|\\+|ø)?";
const EXTENSION = "(?:(?:sus|add|maj|Maj|no|alt|b|#|♭|♯|\\+|-)?\\d{1,2}|sus|alt|\\([^()\\s]{1,12}\\))*";
const BASS = `(?:\\/${ROOT}${ACCIDENTAL})?`;
const CHORD_RE = new RegExp(`^${ROOT}${ACCIDENTAL}${QUALITY}${EXTENSION}${BASS}\\*?$`);

/** Tokens that may sit in a chord line without being chords. */
const CHORD_LINE_FILLER_RE =
  /^(?:\|+:?|:?\|+|\/+|-+|–|—|\.+|%|x\s?\d+|\(x\s?\d+\)|\d+x|\[x\s?\d+\]|N\.?C\.?|\(|\)|\|\||\*)$/i;

/** Strips the decoration people put around chords in text: `(C)`, `[C]`. */
function unwrap(token: string): string {
  const trimmed = token.trim();
  const wrapped = /^[[(](.+)[\])]$/.exec(trimmed);
  return wrapped ? wrapped[1] : trimmed;
}

export function isChord(token: string): boolean {
  const value = unwrap(token);
  return value.length > 0 && value.length <= 16 && CHORD_RE.test(value);
}

export function isChordLineFiller(token: string): boolean {
  return CHORD_LINE_FILLER_RE.test(token.trim());
}

type ParsedNote = { semitone: number; latin: boolean; length: number };

function parseNote(text: string): ParsedNote | null {
  for (let index = 0; index < LATIN_ROOTS.length; index += 1) {
    const root = LATIN_ROOTS[index];
    if (text.startsWith(root)) {
      return withAccidental(text, root.length, NATURAL_SEMITONES[index], true);
    }
  }
  const american = AMERICAN_ROOTS.indexOf(text[0] as (typeof AMERICAN_ROOTS)[number]);
  if (american < 0) return null;
  return withAccidental(text, 1, NATURAL_SEMITONES[american], false);
}

function withAccidental(text: string, at: number, semitone: number, latin: boolean): ParsedNote {
  const rest = text.slice(at);
  const accidental = /^(##|bb|#|b|♯|♭)/.exec(rest)?.[1] ?? "";
  // "Bb" is B-flat, but in "Bbm" too; a lone "b" quality does not exist, so a
  // `b` right after the root is always the accidental.
  const shift =
    accidental === "##" ? 2 : accidental === "bb" ? -2 : accidental === "#" || accidental === "♯" ? 1 : accidental ? -1 : 0;
  return { semitone: (semitone + shift + 12) % 12, latin, length: at + accidental.length };
}

const SHARP_NAMES = {
  american: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"],
  latin: ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"],
};
const FLAT_NAMES = {
  american: ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"],
  latin: ["Do", "Reb", "Re", "Mib", "Mi", "Fa", "Solb", "Sol", "Lab", "La", "Sib", "Si"],
};

function noteName(semitone: number, latin: boolean, flats: boolean): string {
  const names = flats ? FLAT_NAMES : SHARP_NAMES;
  return (latin ? names.latin : names.american)[((semitone % 12) + 12) % 12];
}

/** Keys spelled with flats; anything else is spelled with sharps. */
const FLAT_KEYS = new Set([
  "F", "Bb", "Eb", "Ab", "Db", "Gb", "Dm", "Gm", "Cm", "Fm", "Bbm", "Ebm",
]);

/** Whether chords in `key` should be spelled with flats. `key` is American. */
export function keyPrefersFlats(key: string | null | undefined): boolean {
  return key ? FLAT_KEYS.has(key.replace("♭", "b")) : false;
}

/**
 * Transposes one chord by `semitones`, keeping its notation and decoration.
 * Something that is not a chord comes back unchanged.
 */
export function transposeChord(chord: string, semitones: number, flats = false): string {
  const shift = ((Math.round(semitones) % 12) + 12) % 12;
  if (shift === 0) return chord;
  const wrapped = /^([[(]?)(.*?)([\])]?)$/.exec(chord.trim());
  if (!wrapped || !isChord(chord)) return chord;
  const [, open, body, close] = wrapped;
  const slash = body.lastIndexOf("/");
  const hasBass = slash > 0 && parseNote(body.slice(slash + 1)) !== null;
  const main = hasBass ? body.slice(0, slash) : body;
  const root = parseNote(main);
  if (!root) return chord;
  let result =
    noteName(root.semitone + shift, root.latin, flats) + main.slice(root.length);
  if (hasBass) {
    const bassText = body.slice(slash + 1);
    const bass = parseNote(bassText);
    if (bass) {
      result += `/${noteName(bass.semitone + shift, bass.latin, flats)}${bassText.slice(bass.length)}`;
    }
  }
  return `${open}${result}${close}`;
}

const NOTE_RE = /[A-G](?:##|bb|#|b|♯|♭)?/g;

/**
 * A line of melody notes as sheets write them — "DC#-A-DC#-A//B",
 * "B - B - C# - D" — split into its groups ("D C#", "A"…). A `//` (or `|`)
 * ends a phrase and comes back as a `"‖"` group. `null` if the line is
 * anything else: tablature has fret numbers, lyrics have words.
 */
export function parseNoteRun(text: string): string[][] | null {
  if (/\d/.test(text) || !/[-/|]/.test(text)) return null;
  const groups: string[][] = [];
  for (const piece of text.trim().split(/(\/\/+|\|+)|[\s-]+/)) {
    if (!piece) continue;
    if (/^(?:\/\/+|\|+)$/.test(piece)) {
      groups.push(["‖"]);
      continue;
    }
    if (!/^(?:[A-G](?:##|bb|#|b|♯|♭)?)+$/.test(piece)) return null;
    groups.push(piece.match(NOTE_RE) ?? []);
  }
  return groups.filter((group) => group[0] !== "‖").length >= 3 ? groups : null;
}

/** A note line moved by `semitones`, separators untouched. Anything that is
 * not a note line comes back as it was. */
export function transposeNoteRun(text: string, semitones: number, flats = false): string {
  if (!semitones || !parseNoteRun(text)) return text;
  return text.replace(NOTE_RE, (note) => transposeChord(note, semitones, flats));
}
