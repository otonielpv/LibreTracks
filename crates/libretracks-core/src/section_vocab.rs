//! The one vocabulary of section names: "Verso 2", "Chorus 1", "Refrão",
//! "pre_chorus" → the marker kind and number they name.
//!
//! Spanish, English and Portuguese. The voice guide's transcription
//! (`libretracks-analysis::guide_text`) and the lyrics sync (matching
//! LibreTracks markers to the groups of ProPresenter, FreeShow and Holyrics)
//! both read this table: there is no second copy anywhere.

use crate::model::{Marker, MarkerCategory, MarkerKind};

/// Phrases (words without fillers) and the kind they name. Spanish and
/// English together: a guide may mix them ("Refrain" in a Spanish guide).
/// Portuguese section names too, for the lyrics programs' group names
/// (Holyrics in Brazil); FreeShow's group ids (`pre_chorus`) read as the
/// kind token itself.
pub const PHRASES: &[(&[&str], &str)] = &[
    // Sections.
    (&["intro"], "intro"),
    (&["introducao"], "intro"),
    (&["introduccion"], "intro"),
    (&["verso"], "verse"),
    (&["estrofa"], "verse"),
    (&["verse"], "verse"),
    (&["estrofe"], "verse"),
    (&["pre", "coro"], "pre_chorus"),
    (&["precoro"], "pre_chorus"),
    (&["pre", "chorus"], "pre_chorus"),
    (&["prechorus"], "pre_chorus"),
    (&["pre", "refrao"], "pre_chorus"),
    (&["prerefrao"], "pre_chorus"),
    (&["coro"], "chorus"),
    (&["chorus"], "chorus"),
    (&["refrao"], "chorus"),
    (&["post", "coro"], "post_chorus"),
    (&["postcoro"], "post_chorus"),
    (&["post", "chorus"], "post_chorus"),
    (&["postchorus"], "post_chorus"),
    (&["puente"], "bridge"),
    (&["bridge"], "bridge"),
    (&["ponte"], "bridge"),
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
    (&["metales"], "horns"),
    (&["vientos"], "horns"),
    (&["horns"], "horns"),
    (&["brass"], "horns"),
    (&["ad", "lib"], "ad_lib"),
    (&["espontaneo"], "worship_freely"),
    (&["worship", "freely"], "worship_freely"),
    (&["preparados"], "get_ready"),
    (&["get", "ready"], "get_ready"),
    (&["marcar"], "count_it"),
    (&["marcando"], "count_it"),
    (&["count", "it"], "count_it"),
    (&["silencio"], "silence"),
    (&["silence"], "silence"),
    (&["fuerte"], "loud"),
    (&["loud"], "loud"),
    (&["empezamos"], "here_we_go"),
    (&["here", "we", "go"], "here_we_go"),
    (&["siguiente", "cancion"], "next_song"),
    (&["next", "song"], "next_song"),
    (&["swell"], "swell"),
];

/// Kinds that are sections (and so take a variant number).
pub const SECTION_KINDS: &[&str] = &[
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
pub const MAX_VARIANT: u32 = 9;
/// The voice guide's counts go up to seven (counts/1..7.wav).
pub const MAX_COUNT: u32 = 7;

/// Numbers said or written as words.
pub const NUMBER_WORDS: &[(&str, u32)] = &[
    ("uno", 1),
    ("una", 1),
    // Whisper writes a short "uno" said on its own as "Un." ("Al estar ante
    // ti": "Coro." … "Un." "Dos." "Tres." "Cuatro." lost the count-in).
    ("un", 1),
    ("one", 1),
    ("dos", 2),
    ("two", 2),
    ("tres", 3),
    ("three", 3),
    ("cuatro", 4),
    ("four", 4),
    ("cinco", 5),
    ("five", 5),
    ("seis", 6),
    ("six", 6),
    ("siete", 7),
    ("seven", 7),
    ("ocho", 8),
    ("eight", 8),
];

/// Roman numerals a written label uses ("Verse II", "Estrofa IV").
pub const ROMAN_NUMERALS: &[(&str, u32)] = &[
    ("i", 1),
    ("ii", 2),
    ("iii", 3),
    ("iv", 4),
    ("v", 5),
    ("vi", 6),
];

pub fn number_word(token: &str) -> Option<u32> {
    if let Ok(value) = token.parse::<u32>() {
        return Some(value);
    }
    NUMBER_WORDS
        .iter()
        .find_map(|(word, value)| (*word == token).then_some(*value))
}

/// Lowercase, accents off, hyphens joined ("re-frame" → "reframe",
/// "pre-coro" → "precoro"), other punctuation as spaces.
pub fn tokens(text: &str) -> Vec<String> {
    let mut cleaned = String::with_capacity(text.len());
    for c in text.chars() {
        let c = match c {
            'á' | 'à' | 'ä' | 'â' | 'Á' | 'À' | 'Ä' | 'Â' => 'a',
            'é' | 'è' | 'ë' | 'ê' | 'É' | 'È' | 'Ë' | 'Ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' | 'Í' | 'Ì' | 'Ï' | 'Î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'Ó' | 'Ò' | 'Ö' | 'Ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' | 'Ú' | 'Ù' | 'Ü' | 'Û' => 'u',
            'ã' | 'Ã' => 'a',
            'õ' | 'Õ' => 'o',
            'ñ' | 'Ñ' => 'n',
            'ç' | 'Ç' => 'c',
            '-' => continue,
            c if c.is_alphanumeric() => c.to_ascii_lowercase(),
            _ => ' ',
        };
        cleaned.push(c);
    }
    cleaned.split_whitespace().map(str::to_string).collect()
}

/// A label that names a marker exactly ("Verso 2", "PRE-CHORUS 1",
/// "drums_in"): its kind (serde token) and number. Unknown or ambiguous text,
/// a number on a cue, or number 0 → `None`.
pub fn parse_marker_label(text: &str) -> Option<(&'static str, Option<u8>)> {
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
    Some((kind, variant))
}

/// A section: its kind and number ("Verso 2" = verse, 2). `variant: None` is
/// the unnumbered section ("Coro").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SectionId {
    pub kind: MarkerKind,
    pub variant: Option<u8>,
}

/// The marker kind of a serde token ("pre_chorus" → `PreChorus`).
pub fn kind_from_token(token: &str) -> Option<MarkerKind> {
    serde_json::from_value(serde_json::Value::String(token.to_string())).ok()
}

/// Short forms the lyrics programs use for group names: "V1", "C", "PC",
/// "B2". Only read as the whole label, so "C" alone is a chorus and "Coda"
/// is not.
/// Planning Center's short sequences add "Inst"; "I" stays the intro (the
/// lyrics programs' meaning; Planning Center writes the interlude out).
pub const ABBREVIATIONS: &[(&str, &str)] = &[
    ("v", "verse"),
    ("c", "chorus"),
    ("ch", "chorus"),
    ("pc", "pre_chorus"),
    ("p", "pre_chorus"),
    ("pre", "pre_chorus"),
    ("b", "bridge"),
    ("br", "bridge"),
    ("i", "intro"),
    ("inst", "instrumental"),
    ("o", "outro"),
    ("t", "tag"),
    ("e", "ending"),
];

/// The section a label names, in any of the three languages, as a lyrics
/// program writes it: "Verso 1", "Chorus 1", "Pre-Coro", "verse_2",
/// "Refrão", "V1", "C". Cues ("Build"), counts and unknown text → `None`.
pub fn canonical_section(text: &str) -> Option<SectionId> {
    if let Some((token, variant)) = parse_marker_label(text) {
        let kind = kind_from_token(token)?;
        if kind.category() != MarkerCategory::Section || kind == MarkerKind::NextSong {
            return None;
        }
        return Some(SectionId { kind, variant });
    }
    let normalized = tokens(text).concat();
    let letters = normalized.trim_end_matches(|character: char| character.is_ascii_digit());
    let number = &normalized[letters.len()..];
    let variant = if number.is_empty() {
        None
    } else {
        Some(number.parse::<u8>().ok().filter(|value| *value > 0)?)
    };
    let token = ABBREVIATIONS
        .iter()
        .find_map(|(short, token)| (*short == letters).then_some(*token))?;
    Some(SectionId {
        kind: kind_from_token(token)?,
        variant,
    })
}

/// Words that only a written label uses (a chord chart's header, a sequence
/// from Planning Center), never a voice guide or a lyrics program's group:
/// in `PHRASES` they would change what the guide hears ("coro final" spoken is
/// a chorus and then an ending) and what `canonical_section` answers ("Coda"
/// is not a group name there). Read before `PHRASES`.
pub const LABEL_PHRASES: &[(&[&str], &str)] = &[
    (&["coro", "final"], "chorus"),
    (&["ultimo", "coro"], "chorus"),
    (&["chorus", "out"], "chorus"),
    (&["final", "chorus"], "chorus"),
    (&["last", "chorus"], "chorus"),
    (&["refran"], "refrain"),
    (&["pre", "estribillo"], "pre_chorus"),
    (&["post", "estribillo"], "post_chorus"),
    (&["stanza"], "verse"),
    (&["inter"], "interlude"),
    (&["coda"], "outro"),
    (&["acorde", "final"], "ending"),
    (&["final", "chord"], "ending"),
    (&["break"], "breakdown"),
    (&["a", "capela"], "acapella"),
];

/// Kinds that name the same part of a song in different sheets: a "Refrain"
/// marker plays the "Coro" of the chart. A kind not listed is its own family.
pub const FAMILIES: &[(&str, &str)] = &[
    ("chorus", "chorus"),
    ("refrain", "chorus"),
    ("outro", "end"),
    ("ending", "end"),
    ("instrumental", "instrumental"),
    ("interlude", "instrumental"),
    ("turnaround", "instrumental"),
];

/// The family of a kind token (`FAMILIES`, or the kind itself).
pub fn section_family(kind: &str) -> &str {
    FAMILIES
        .iter()
        .find_map(|(member, family)| (*member == kind).then_some(*family))
        .unwrap_or(kind)
}

/// How a chord chart reads a kind the vocabulary keeps apart: a Spanish
/// sheet's "Estribillo" is its chorus (the vocabulary says refrain for the
/// lyrics programs, which may have both groups). Same family either way.
pub const CHART_KIND_ALIASES: &[(&str, &str)] = &[("refrain", "chorus")];

/// Where a label was written. Abbreviations ("V1", "C", "PC") are only read
/// in a sequence, where every item is a label: a header or free text "C" is a
/// chord or a letter, not a chorus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LabelContext {
    Header,
    Sequence,
    Free,
}

impl LabelContext {
    pub fn from_token(token: &str) -> Option<Self> {
        match token {
            "header" => Some(Self::Header),
            "sequence" => Some(Self::Sequence),
            "free" => Some(Self::Free),
            _ => None,
        }
    }
}

/// "x2", "2x": a repeat mark after a label ("Coro (x2)", "Chorus 2x").
fn is_repeat_mark(word: &str) -> bool {
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    word.strip_prefix('x').is_some_and(digits) || word.strip_suffix('x').is_some_and(digits)
}

fn roman_numeral(word: &str) -> Option<u32> {
    ROMAN_NUMERALS
        .iter()
        .find_map(|(numeral, value)| (*numeral == word).then_some(*value))
}

fn section_token(token: &'static str) -> Option<&'static str> {
    let kind = kind_from_token(token)?;
    (kind.category() == MarkerCategory::Section && kind != MarkerKind::NextSong).then_some(token)
}

fn exact_label_kind(text: &str) -> Option<&'static str> {
    LABEL_PHRASES
        .iter()
        .chain(PHRASES.iter())
        .find_map(|(phrase, kind)| (phrase.concat() == text).then_some(*kind))
        .or_else(|| {
            SECTION_KINDS
                .iter()
                .find(|kind| kind.replace('_', "") == text)
                .copied()
        })
        .and_then(section_token)
}

fn label_kind(letters: &str) -> Option<&'static str> {
    exact_label_kind(letters)
        // Plurals: "Verses", "Coros".
        .or_else(|| letters.strip_suffix('s').and_then(exact_label_kind))
        .or_else(|| letters.strip_suffix("es").and_then(exact_label_kind))
}

/// The section a written label names, and its number: "Estrofa 2",
/// "Pre-Estribillo", "CORO (x2)", "Verse II", "Coro final", "V1" (only in a
/// sequence). Cues, counts, unknown text and number 0 → `None`. TS
/// `canonicalLabel` is the same code over `sectionVocab.json`; both pass
/// `sectionLabels.cases.json`.
pub fn canonical_label(text: &str, context: LabelContext) -> Option<(&'static str, Option<u8>)> {
    let mut words = tokens(text);
    if words.len() > 1 && words.last().is_some_and(|word| is_repeat_mark(word)) {
        words.pop();
    }
    let mut number = None;
    if words.len() > 1 {
        let last = words.last()?;
        if let Some(value) = number_word(last).or_else(|| roman_numeral(last)) {
            number = Some(value);
            words.pop();
        }
    }
    let joined = words.concat();
    let letters = joined.trim_end_matches(|character: char| character.is_ascii_digit());
    let glued = &joined[letters.len()..];
    if !glued.is_empty() {
        if number.is_some() {
            return None;
        }
        number = Some(glued.parse::<u32>().ok()?);
    }
    let number = match number {
        Some(0) => return None,
        Some(value) if value > 99 => return None,
        other => other.map(|value| value as u8),
    };
    if letters.is_empty() {
        return None;
    }
    let abbreviation = || {
        ABBREVIATIONS
            .iter()
            .find_map(|(short, token)| (*short == letters).then_some(*token))
    };
    let kind = label_kind(letters).or_else(|| {
        if context == LabelContext::Sequence {
            abbreviation()
        } else {
            None
        }
    })?;
    Some((kind, number))
}

/// The kinds `is_lyricless` answers yes for, as tokens (for the JSON).
pub fn lyricless_tokens() -> Vec<&'static str> {
    SECTION_KINDS
        .iter()
        .copied()
        .filter(|token| kind_from_token(token).is_some_and(is_lyricless))
        .collect()
}

/// Every kind a written label can name (sections, solos included; cues and
/// "next song" not), sorted, for the JSON.
pub fn label_kind_tokens() -> Vec<&'static str> {
    let mut kinds: Vec<&'static str> = LABEL_PHRASES
        .iter()
        .chain(PHRASES.iter())
        .map(|(_, kind)| *kind)
        .chain(SECTION_KINDS.iter().copied())
        .filter_map(section_token)
        .collect();
    kinds.sort_unstable();
    kinds.dedup();
    kinds
}

/// The vocabulary as TS reads it (`packages/shared/src/charts/sectionVocab.json`):
/// stable order, one entry per line, no timestamps. The test
/// `section_vocab_json` keeps the file in step with this module.
pub fn vocabulary_json() -> String {
    fn quote(text: &str) -> String {
        serde_json::to_string(text).expect("a string serializes")
    }
    fn block(lines: Vec<String>) -> String {
        format!("[\n{}\n  ]", lines.join(",\n"))
    }
    fn phrases(entries: &[(&[&str], &str)]) -> String {
        block(
            entries
                .iter()
                .map(|(words, kind)| {
                    let words: Vec<String> = words.iter().map(|word| quote(word)).collect();
                    format!("    [[{}], {}]", words.join(", "), quote(kind))
                })
                .collect(),
        )
    }
    fn texts(entries: &[(&str, &str)]) -> String {
        block(
            entries
                .iter()
                .map(|(key, value)| format!("    [{}, {}]", quote(key), quote(value)))
                .collect(),
        )
    }
    fn numbers(entries: &[(&str, u32)]) -> String {
        block(
            entries
                .iter()
                .map(|(key, value)| format!("    [{}, {value}]", quote(key)))
                .collect(),
        )
    }
    fn list(items: &[&str]) -> String {
        let items: Vec<String> = items.iter().map(|item| quote(item)).collect();
        format!("[{}]", items.join(", "))
    }
    let fields = [
        (
            "_generated",
            quote(
                "From crates/libretracks-core/src/section_vocab.rs. Do not edit: \
                 UPDATE_SECTION_VOCAB=1 cargo test -p libretracks-core section_vocab_json",
            ),
        ),
        ("phrases", phrases(PHRASES)),
        ("labelPhrases", phrases(LABEL_PHRASES)),
        ("abbreviations", texts(ABBREVIATIONS)),
        ("sectionKinds", list(SECTION_KINDS)),
        ("labelKinds", list(&label_kind_tokens())),
        ("families", texts(FAMILIES)),
        ("chartKindAliases", texts(CHART_KIND_ALIASES)),
        ("lyricless", list(&lyricless_tokens())),
        ("numberWords", numbers(NUMBER_WORDS)),
        ("romanNumerals", numbers(ROMAN_NUMERALS)),
    ];
    let body: Vec<String> = fields
        .iter()
        .map(|(name, value)| format!("  {}: {value}", quote(name)))
        .collect();
    format!("{{\n{}\n}}\n", body.join(",\n"))
}

/// The section a marker stands for: its `kind` and `variant` (the label is
/// the translated name it was created with, not reliable). A `Custom` marker
/// is read from its name; a cue → `None`.
/// Sections that are usually played, not sung: with no group for them in the
/// presentation, the lyrics program clears the text (the background stays).
/// Intro and outro are here too: when they do have words, the presentation
/// has a group for them and it wins.
pub fn is_lyricless(kind: MarkerKind) -> bool {
    matches!(
        kind,
        MarkerKind::Intro
            | MarkerKind::Instrumental
            | MarkerKind::Interlude
            | MarkerKind::Vamp
            | MarkerKind::Solo
            | MarkerKind::Breakdown
            | MarkerKind::Drop
            | MarkerKind::Turnaround
            | MarkerKind::Exhortation
            | MarkerKind::Outro
            | MarkerKind::Ending
    )
}

pub fn marker_section_id(marker: &Marker) -> Option<SectionId> {
    if marker.category() != MarkerCategory::Section {
        return None;
    }
    if marker.kind == MarkerKind::Custom {
        return canonical_section(&marker.name);
    }
    Some(SectionId {
        kind: marker.kind,
        variant: marker.variant,
    })
}

/// A song title as compared between LibreTracks and a lyrics program:
/// lowercase, no accents or punctuation, without a leading track number
/// ("01 "), parentheses or brackets ("(En vivo)", "[Key of D]") or a trailing
/// key ("- G", "- F#m").
pub fn normalize_title(text: &str) -> String {
    let mut without_brackets = String::with_capacity(text.len());
    let mut depth = 0usize;
    for character in text.chars() {
        match character {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => without_brackets.push(character),
            _ => {}
        }
    }
    let mut title = without_brackets.trim().to_string();
    // A trailing key after a dash: "Cuán Grande Es Él - G", "Way Maker - F#m".
    if let Some((rest, tail)) = title.rsplit_once(['-', '\u{2013}', '\u{2014}']) {
        if is_key_name(tail.trim()) && !rest.trim().is_empty() {
            title = rest.trim().to_string();
        }
    }
    let title = strip_track_number(&title);
    tokens(&title.replace(['\'', '\u{2019}'], "")).join(" ")
}

/// "01 Way Maker", "1. Way Maker", "03 - Oceans" → the title; "10,000
/// Reasons" and "7" stay as they are.
fn strip_track_number(title: &str) -> &str {
    let digits = title.len() - title.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 || digits > 3 {
        return title;
    }
    let rest = &title[digits..];
    let after_separator = rest
        .strip_prefix(['.', ')', '-', '_'])
        .unwrap_or(rest);
    let trimmed = after_separator.trim_start_matches([' ', '-', '\t']);
    let separated = after_separator.len() != rest.len() || trimmed.len() != after_separator.len();
    if separated && !trimmed.is_empty() {
        trimmed
    } else {
        title
    }
}

/// "G", "F#", "Bb", "C#m", "Ebm".
fn is_key_name(text: &str) -> bool {
    let mut characters = text.chars();
    let Some(letter) = characters.next() else {
        return false;
    };
    if !('A'..='G').contains(&letter) {
        return false;
    }
    let rest: String = characters.collect();
    matches!(rest.as_str(), "" | "#" | "b" | "m" | "#m" | "bm")
}

#[cfg(test)]
#[path = "section_vocab_tests.rs"]
mod tests;
