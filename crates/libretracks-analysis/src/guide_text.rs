//! What a transcribed guide announcement asks for, as marker kinds.
//!
//! The text comes from speech recognition of a guide track: "Verso 3, entra
//! batería", "Coro, dos, tres, cuatro", "Bridge 1", "Entro" (sic). This turns
//! it into the markers it names — here verse 3 plus drums in, chorus, bridge 1
//! and intro — whatever the voice, in Spanish or English.
//!
//! - Words are compared loosely (one or two letters off, by length), because
//!   recognition of a lone word slips: "Intro" comes back "Entro", "Coro"
//!   "Cordo", "Refrain" "Re-frame". A phrase of several words is also
//!   compared whole, its slips spread over it: "Bajel insensidad" is
//!   "bajar intensidad". Of the phrases that match, the closest wins.
//! - Small filler words between a phrase's words are skipped ("solo de
//!   guitarra", "entra la batería", "toda la banda").
//! - A number right after a section is its variant ("Coro dos", "Bridge 1"),
//!   unless the numbers go on counting: in "Verso, dos, tres, cuatro" the
//!   section word stands for beat 1 of the count-in, and the section has no
//!   number.
//! - Counts alone ("uno, dos, tres, cuatro") and unknown words name nothing;
//!   a count's numbers are read apart (`count_numbers`).

/// A marker the announcement names: `kind` is the `MarkerKind` serde name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnouncedMarker {
    pub kind: &'static str,
    pub variant: Option<u8>,
}

/// Phrases (words without fillers) and the kind they name. Spanish and
/// English together: a guide may mix them ("Refrain" in a Spanish guide).
const PHRASES: &[(&[&str], &str)] = &[
    // Sections.
    (&["intro"], "intro"),
    (&["introduccion"], "intro"),
    (&["verso"], "verse"),
    (&["estrofa"], "verse"),
    (&["verse"], "verse"),
    (&["pre", "coro"], "pre_chorus"),
    (&["precoro"], "pre_chorus"),
    (&["pre", "chorus"], "pre_chorus"),
    (&["prechorus"], "pre_chorus"),
    (&["coro"], "chorus"),
    (&["chorus"], "chorus"),
    (&["post", "coro"], "post_chorus"),
    (&["postcoro"], "post_chorus"),
    (&["post", "chorus"], "post_chorus"),
    (&["postchorus"], "post_chorus"),
    (&["puente"], "bridge"),
    (&["bridge"], "bridge"),
    (&["breakdown"], "breakdown"),
    (&["drop"], "drop"),
    (&["solo", "guitarra"], "guitar_solo"),
    (&["guitar", "solo"], "guitar_solo"),
    (&["solo", "bateria"], "drum_solo"),
    (&["drum", "solo"], "drum_solo"),
    (&["solo", "bajo"], "bass_solo"),
    (&["bass", "solo"], "bass_solo"),
    (&["solo"], "solo"),
    (&["outro"], "outro"),
    (&["salida"], "outro"),
    (&["cierre"], "outro"),
    (&["capella"], "acapella"),
    (&["acapella"], "acapella"),
    (&["cappella"], "acapella"),
    (&["instrumental"], "instrumental"),
    (&["interludio"], "interlude"),
    (&["interlude"], "interlude"),
    (&["estribillo"], "refrain"),
    (&["refrain"], "refrain"),
    (&["tag"], "tag"),
    (&["repeticion"], "tag"),
    (&["vamp"], "vamp"),
    (&["final", "grande"], "big_ending"),
    (&["big", "ending"], "big_ending"),
    (&["final"], "ending"),
    (&["ending"], "ending"),
    (&["fin"], "ending"),
    (&["end"], "ending"),
    (&["exhortacion"], "exhortation"),
    (&["exhortation"], "exhortation"),
    (&["rap"], "rap"),
    (&["otra", "vuelta"], "turnaround"),
    (&["turnaround"], "turnaround"),
    // Cues.
    (&["subir", "lento"], "slowly_build"),
    (&["sube", "lento"], "slowly_build"),
    (&["slowly", "build"], "slowly_build"),
    (&["subir", "intensidad"], "build"),
    (&["sube", "intensidad"], "build"),
    (&["build"], "build"),
    (&["bajar", "intensidad"], "ease_down"),
    (&["baja", "intensidad"], "ease_down"),
    (&["ease", "down"], "ease_down"),
    (&["toda", "banda"], "all_in"),
    (&["todos"], "all_in"),
    (&["all", "in"], "all_in"),
    (&["entra", "bateria"], "drums_in"),
    (&["drums", "in"], "drums_in"),
    (&["pausa"], "break"),
    (&["corte"], "break"),
    (&["break"], "break"),
    (&["sostener"], "hold"),
    (&["hold"], "hold"),
    (&["suave"], "softly"),
    (&["suavemente"], "softly"),
    (&["softly"], "softly"),
    (&["golpes"], "hits"),
    (&["pulsos"], "hits"),
    (&["hits"], "hits"),
    (&["ultima", "vez"], "last_time"),
    (&["last", "time"], "last_time"),
    (&["sube", "tono"], "key_change_up"),
    (&["subir", "tono"], "key_change_up"),
    (&["key", "change", "up"], "key_change_up"),
    (&["key", "up"], "key_change_up"),
    (&["baja", "tono"], "key_change_down"),
    (&["bajar", "tono"], "key_change_down"),
    (&["key", "change", "down"], "key_change_down"),
    (&["key", "down"], "key_change_down"),
    (&["sube", "tempo"], "tempo_up"),
    (&["speed", "up"], "tempo_up"),
    (&["baja", "tempo"], "tempo_down"),
    (&["slow", "down"], "tempo_down"),
    (&["bateria"], "drums"),
    (&["drums"], "drums"),
    (&["bajo"], "bass"),
    (&["bass"], "bass"),
    (&["guitarra"], "guitar"),
    (&["guitar"], "guitar"),
    (&["teclado"], "keys"),
    (&["teclados"], "keys"),
    (&["piano"], "keys"),
    (&["keys"], "keys"),
    (&["ad", "lib"], "ad_lib"),
    (&["espontaneo"], "worship_freely"),
    (&["worship", "freely"], "worship_freely"),
    (&["preparados"], "get_ready"),
    (&["get", "ready"], "get_ready"),
    (&["siguiente", "cancion"], "next_song"),
    (&["next", "song"], "next_song"),
    (&["swell"], "swell"),
];

/// Kinds that are sections (and so take a variant number).
const SECTION_KINDS: &[&str] = &[
    "intro",
    "verse",
    "pre_chorus",
    "chorus",
    "post_chorus",
    "bridge",
    "breakdown",
    "drop",
    "solo",
    "outro",
    "acapella",
    "instrumental",
    "interlude",
    "refrain",
    "tag",
    "vamp",
    "ending",
    "exhortation",
    "rap",
    "turnaround",
];

/// Variants beyond this are a misheard count, not "Verse 12".
const MAX_VARIANT: u32 = 9;
/// The voice guide's counts go up to seven (counts/1..7.wav).
const MAX_COUNT: u32 = 7;

fn number_word(token: &str) -> Option<u32> {
    if let Ok(value) = token.parse::<u32>() {
        return Some(value);
    }
    Some(match token {
        "uno" | "una" | "one" => 1,
        "dos" | "two" => 2,
        "tres" | "three" => 3,
        "cuatro" | "four" => 4,
        "cinco" | "five" => 5,
        "seis" | "six" => 6,
        "siete" | "seven" => 7,
        "ocho" | "eight" => 8,
        _ => return None,
    })
}

/// Lowercase, accents off, hyphens joined ("re-frame" → "reframe",
/// "pre-coro" → "precoro"), other punctuation as spaces.
fn tokens(text: &str) -> Vec<String> {
    let mut cleaned = String::with_capacity(text.len());
    for c in text.chars() {
        let c = match c {
            'á' | 'à' | 'ä' | 'â' | 'Á' | 'À' | 'Ä' | 'Â' => 'a',
            'é' | 'è' | 'ë' | 'ê' | 'É' | 'È' | 'Ë' | 'Ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' | 'Í' | 'Ì' | 'Ï' | 'Î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'Ó' | 'Ò' | 'Ö' | 'Ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' | 'Ú' | 'Ù' | 'Ü' | 'Û' => 'u',
            'ñ' | 'Ñ' => 'n',
            '-' => continue,
            c if c.is_alphanumeric() => c.to_ascii_lowercase(),
            _ => ' ',
        };
        cleaned.push(c);
    }
    cleaned.split_whitespace().map(str::to_string).collect()
}

pub fn parse_marker_label(text: &str) -> Option<AnnouncedMarker> {
    let words = tokens(text);
    let normalized = words.concat();
    let number_start = normalized
        .trim_end_matches(|character: char| character.is_ascii_digit())
        .len();
    let (label, number) = normalized.split_at(number_start);
    let (label, variant) = if number.is_empty() {
        match words.split_last() {
            Some((last, rest)) if number_word(last).is_some() => {
                (rest.concat(), Some(u8::try_from(number_word(last)?).ok()?))
            }
            _ => (normalized, None),
        }
    } else {
        (label.to_string(), Some(number.parse::<u8>().ok()?))
    };
    if variant == Some(0) {
        return None;
    }
    let kind = PHRASES.iter().find_map(|(phrase, kind)| {
        (phrase.concat() == label || kind.replace('_', "") == label).then_some(*kind)
    })?;
    let is_section = SECTION_KINDS.contains(&kind)
        || matches!(
            kind,
            "drum_solo" | "bass_solo" | "guitar_solo" | "next_song"
        );
    if variant.is_some() && !is_section {
        return None;
    }
    Some(AnnouncedMarker { kind, variant })
}

#[cfg(test)]
mod marker_label_tests {
    use super::{parse_marker_label, AnnouncedMarker};

    #[test]
    fn recognizes_exact_section_and_cue_labels() {
        for (label, kind, variant) in [
            (" INTRO ", "intro", None),
            ("Estrofa 2", "verse", Some(2)),
            ("Verse3", "verse", Some(3)),
            ("Coro dos", "chorus", Some(2)),
            ("PRE-CHORUS 1", "pre_chorus", Some(1)),
            ("Guitar Solo 2", "guitar_solo", Some(2)),
            ("All In", "all_in", None),
            ("drums_in", "drums_in", None),
            ("Subir intensidad", "build", None),
            ("key_change_up", "key_change_up", None),
            ("tempo_down", "tempo_down", None),
        ] {
            assert_eq!(
                parse_marker_label(label),
                Some(AnnouncedMarker { kind, variant }),
                "{label}"
            );
        }
    }

    #[test]
    fn leaves_unknown_ambiguous_and_invalid_labels_untyped() {
        for label in [
            "",
            "Pass",
            "My intro notes",
            "Verse / Chorus",
            "Verse 0",
            "Verse 256",
            "Build 2",
            "Lighting cue",
        ] {
            assert_eq!(parse_marker_label(label), None, "{label}");
        }
    }
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut current = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            let substitution = previous[j] + usize::from(ca != cb);
            current[j + 1] = substitution.min(previous[j + 1] + 1).min(current[j] + 1);
        }
        previous = current;
    }
    previous[b.len()]
}

/// A heard word against a dictionary word: exact up to 3 letters (tag, rap,
/// in), one slip from 4, two from 7.
fn same_word(heard: &str, word: &str) -> bool {
    let allowed = match word.chars().count() {
        0..=3 => 0,
        4..=6 => 1,
        _ => 2,
    };
    edit_distance(heard, word) <= allowed
}

/// Fillers that may sit between a phrase's words.
fn is_filler(token: &str) -> bool {
    token.chars().count() <= 3 && number_word(token).is_none()
}

/// Letters a whole phrase may be off: one in five ("bajar intensidad", 15
/// letters, takes 3; "bajar" and "subir" are 4 apart).
fn phrase_slips(letters: usize) -> usize {
    letters / 5
}

/// The phrase at `start`, if it matches: the index after it, and how many
/// letters off it was heard (0 for a word-by-word match).
fn match_phrase(words: &[String], start: usize, phrase: &[&str]) -> Option<(usize, usize)> {
    let word_by_word = || {
        let mut position = start;
        for (index, expected) in phrase.iter().enumerate() {
            if index > 0 && position < words.len() && !same_word(&words[position], expected) {
                // One filler may sit between two words of a phrase.
                if is_filler(&words[position]) {
                    position += 1;
                }
            }
            if position >= words.len() || !same_word(&words[position], expected) {
                return None;
            }
            position += 1;
        }
        Some(position)
    };
    if let Some(end) = word_by_word() {
        let heard: String = words[start..end]
            .iter()
            .filter(|word| !is_filler(word) || phrase.contains(&word.as_str()))
            .map(String::as_str)
            .collect();
        return Some((end, edit_distance(&heard, &phrase.concat())));
    }
    if phrase.len() < 2 {
        return None;
    }
    // The phrase's words, with one filler allowed between two of them
    // ("Bajel la intensidad").
    let mut heard_words: Vec<&str> = Vec::with_capacity(phrase.len());
    let mut position = start;
    while heard_words.len() < phrase.len() {
        let word = words.get(position)?;
        if !heard_words.is_empty()
            && is_filler(word)
            && words.get(position + 1).is_some_and(|next| !is_filler(next))
        {
            position += 1;
            continue;
        }
        if number_word(word).is_some() {
            return None;
        }
        heard_words.push(word);
        position += 1;
    }
    let end = position;
    let heard = heard_words.concat();
    let expected = phrase.concat();
    let off = edit_distance(&heard, &expected);
    (off <= phrase_slips(expected.chars().count())).then_some((end, off))
}

/// The announcement is only a count ("uno, dos, tres, cuatro", "5, 6").
pub fn is_count(text: &str) -> bool {
    let words = tokens(text);
    !words.is_empty() && words.iter().all(|word| number_word(word).is_some())
}

/// The numbers a count says, in order: "Uno, dos, uno, dos, tres, cuatro" is
/// 1, 2, 1, 2, 3, 4. Numbers past the recorded counts (1..7) are left out.
pub fn count_numbers(text: &str) -> Vec<u8> {
    tokens(text)
        .iter()
        .filter_map(|word| number_word(word))
        .filter(|number| (1..=MAX_COUNT).contains(number))
        .map(|number| number as u8)
        .collect()
}

/// Whether `kind` is a section (the rest are cues).
pub fn is_section_kind(kind: &str) -> bool {
    SECTION_KINDS.contains(&kind)
}

/// The announcement ends counting in ("Toda la banda, tres, cuatro").
fn ends_counting(text: &str) -> bool {
    let words = tokens(text);
    let numbers: Vec<u32> = words
        .iter()
        .rev()
        .map_while(|word| number_word(word))
        .collect();
    numbers.len() >= 2 && numbers.windows(2).all(|w| w[0] == w[1] + 1)
}

/// An announcement read with the count that follows it within a breath, if
/// any: "Coro, uno." + "Dos, tres, cuatro." is a chorus counted in, not
/// chorus 1. `counted_in`: a count follows the words, so they start a
/// section (a cue said with a count-in, "Toda la banda" + "tres, cuatro",
/// goes in the section lane).
pub fn read_announcement(
    text: &str,
    following_count: Option<&str>,
) -> (Vec<AnnouncedMarker>, bool) {
    match following_count {
        Some(count) => (parse_announcement(&format!("{text} {count}")), true),
        None => (parse_announcement(text), ends_counting(text)),
    }
}

/// The markers a transcribed announcement names, in order, without repeats.
pub fn parse_announcement(text: &str) -> Vec<AnnouncedMarker> {
    let words = tokens(text);
    let mut found: Vec<AnnouncedMarker> = Vec::new();
    let mut position = 0;
    while position < words.len() {
        // Longest phrase first ("solo guitarra" before "solo", "final
        // grande" before "final"), then the one heard closest.
        let matched = PHRASES
            .iter()
            .filter_map(|(phrase, kind)| {
                match_phrase(&words, position, phrase)
                    .map(|(end, off)| (end, off, phrase.len(), *kind))
            })
            .min_by_key(|&(_, off, length, _)| (std::cmp::Reverse(length), off))
            .map(|(end, _, _, kind)| (end, kind));
        let Some((end, kind)) = matched else {
            position += 1;
            continue;
        };
        position = end;
        let mut variant = None;
        if SECTION_KINDS.contains(&kind) {
            let numbers: Vec<u32> = words[position..]
                .iter()
                .map_while(|word| number_word(word))
                .collect();
            let counting = numbers.len() >= 2 && numbers.windows(2).all(|w| w[1] == w[0] + 1);
            if let Some(&first) = numbers.first() {
                if !counting && (1..=MAX_VARIANT).contains(&first) {
                    variant = Some(first as u8);
                }
            }
            position += numbers.len();
        }
        let marker = AnnouncedMarker { kind, variant };
        if found.last() != Some(&marker) {
            found.push(marker);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> Vec<(&'static str, Option<u8>)> {
        parse_announcement(text)
            .into_iter()
            .map(|marker| (marker.kind, marker.variant))
            .collect()
    }

    // Every case below is a real transcription of a guide track (whisper.cpp
    // base, 2026-10-17), slips included.

    #[test]
    fn two_markers_in_one_announcement() {
        assert_eq!(
            parsed("Verso 3, Entra batería."),
            vec![("verse", Some(3)), ("drums_in", None)]
        );
    }

    #[test]
    fn a_count_after_the_section_is_not_its_number() {
        assert_eq!(parsed("Verso 2, tres, cuatro."), vec![("verse", None)]);
        assert_eq!(
            parsed("Pre coro, dos, tres, cuatro."),
            vec![("pre_chorus", None)]
        );
        assert_eq!(parsed("Verse 2, Three, Four."), vec![("verse", None)]);
        assert_eq!(
            parsed("Intra, Uno, dos, tres, cuatro."),
            vec![("intro", None)]
        );
    }

    #[test]
    fn a_lone_number_is_the_variant() {
        assert_eq!(parsed("Coro Uno."), vec![("chorus", Some(1))]);
        assert_eq!(parsed("Coro dos."), vec![("chorus", Some(2))]);
        assert_eq!(parsed("Bridge 1."), vec![("bridge", Some(1))]);
        assert_eq!(parsed("Verso 1."), vec![("verse", Some(1))]);
    }

    #[test]
    fn misheard_words_still_match() {
        assert_eq!(parsed("Entro."), vec![("intro", None)]);
        assert_eq!(parsed("Cordo!"), vec![("chorus", None)]);
        assert_eq!(parsed("Re-frame."), vec![("refrain", None)]);
        assert_eq!(parsed("Solo ve guitarra."), vec![("guitar_solo", None)]);
        // Real ("Rey de Reyes"): both words slip, too far each on its own.
        assert_eq!(parsed("Bajel insensidad."), vec![("ease_down", None)]);
        assert_eq!(parsed("Bajel la intensidad."), vec![("ease_down", None)]);
        assert_eq!(parsed("Subir insensidad."), vec![("build", None)]);
        assert_eq!(
            parsed("Salida, dos, tres, cuatro, tin, dos, tres, cuatro."),
            vec![("outro", None)]
        );
    }

    #[test]
    fn cues_in_spanish_and_english() {
        assert_eq!(
            parsed("Subir intensidad, Subir intensidad,"),
            vec![("build", None)]
        );
        assert_eq!(parsed("Bajar intensidad."), vec![("ease_down", None)]);
        assert_eq!(parsed("Toda la banda."), vec![("all_in", None)]);
        assert_eq!(parsed("Pulsos."), vec![("hits", None)]);
        assert_eq!(parsed("Suave."), vec![("softly", None)]);
        assert_eq!(parsed("Drums in."), vec![("drums_in", None)]);
        assert_eq!(parsed("All in."), vec![("all_in", None)]);
        assert_eq!(parsed("Slowly build."), vec![("slowly_build", None)]);
        assert_eq!(parsed("Hits!"), vec![("hits", None)]);
    }

    #[test]
    fn sections_in_spanish_and_english() {
        assert_eq!(parsed("Solo de guitarra."), vec![("guitar_solo", None)]);
        assert_eq!(parsed("Instrumental."), vec![("instrumental", None)]);
        assert_eq!(parsed("Interludio."), vec![("interlude", None)]);
        assert_eq!(parsed("Puente."), vec![("bridge", None)]);
        assert_eq!(parsed("Final."), vec![("ending", None)]);
        assert_eq!(parsed("Vamp!"), vec![("vamp", None)]);
        assert_eq!(parsed("Tag!"), vec![("tag", None)]);
        assert_eq!(parsed("Breakdown."), vec![("breakdown", None)]);
        assert_eq!(parsed("Chorus."), vec![("chorus", None)]);
        assert_eq!(parsed("Interlude."), vec![("interlude", None)]);
        assert_eq!(parsed("End."), vec![("ending", None)]);
        assert_eq!(parsed("Outro."), vec![("outro", None)]);
    }

    #[test]
    fn a_count_split_from_its_word_is_still_a_count() {
        // Real: "Coro, Uno." and, 0.4 s later, "¡Dos, tres, cuatro!".
        let (markers, counted_in) = read_announcement("Coro, Uno.", Some("¡Dos, tres, cuatro!"));
        assert_eq!(
            markers,
            vec![AnnouncedMarker {
                kind: "chorus",
                variant: None
            }]
        );
        assert!(counted_in);
        // Alone, the number is the variant.
        assert_eq!(
            read_announcement("Coro, Uno.", None).0,
            vec![AnnouncedMarker {
                kind: "chorus",
                variant: Some(1)
            }]
        );
    }

    #[test]
    fn a_cue_with_a_count_in_is_counted_in() {
        assert!(read_announcement("Toda la banda.", Some("Tres, cuatro.")).1);
        assert!(read_announcement("Toda la banda, tres, cuatro.", None).1);
        assert!(!read_announcement("Toda la banda.", None).1);
        assert!(!read_announcement("Coro 2.", None).1);
    }

    #[test]
    fn a_bare_count_is_recognised_as_one() {
        assert!(is_count("5, 6, Uno, dos, tres, cuatro, cinco, seis."));
        assert!(is_count("Uno."));
        assert!(!is_count("Coro, dos, tres, cuatro."));
        assert!(!is_count(""));
    }

    #[test]
    fn a_count_reads_as_its_numbers() {
        // Real: the start of a Spanish and an English guide.
        assert_eq!(
            count_numbers("Uno, dos, uno, dos, tres, cuatro."),
            vec![1, 2, 1, 2, 3, 4]
        );
        assert_eq!(count_numbers("1, 2, 1, 2, 3, 4."), vec![1, 2, 1, 2, 3, 4]);
        assert_eq!(count_numbers("One, two, three, four."), vec![1, 2, 3, 4]);
        assert_eq!(count_numbers("Siete, ocho."), vec![7]);
    }

    #[test]
    fn counts_and_unknown_words_name_nothing() {
        assert!(parsed("Uno.").is_empty());
        assert!(parsed("5, 6, Uno, dos, tres, cuatro, cinco, seis.").is_empty());
        assert!(parsed("Repite, dos, tres, cuatro.").is_empty());
        assert!(parsed("¡Vir frayne!").is_empty());
        assert!(parsed("").is_empty());
    }
}
