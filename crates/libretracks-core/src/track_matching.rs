//! Which track a dropped stem belongs on, judged by its file name.
//!
//! A template gives some of its tracks and folders a list of aliases
//! ([`crate::Track::match_aliases`]): "EG", "Guitarra", "Electric Guitar"…
//! When a batch of stems is dropped, every file name is compared against them
//! and the stem lands on the target that matches best. This module is only the
//! judging — pure, no session state — so it can be tested against the names
//! real multitracks ship with. Where the stem is then placed (an existing
//! track, a new child of a folder, a sibling when the track is taken) is the
//! caller's business.
//!
//! The rules, in order:
//! 1. A name is split into words: lowercased, accents folded, and cut at
//!    anything that is not a letter or digit, at a lowercase→uppercase step
//!    (`HiHat`) and between letters and digits (`EG1`).
//! 2. The part every file of the batch shares at the start (`Way Maker - `) is
//!    ignored, and so is the song's own name, so a song called "Keys to the
//!    Kingdom" does not send its whole multitrack to the keys. A shared start
//!    of a single word that is itself an alias is the instrument, not a title
//!    (`EG Lead`, `EG Rhythm`; `Click`, `Click alt`), and stays. If ignoring
//!    the start leaves nothing but numbers (`EG 1`, `EG 2`), the whole name is
//!    used instead.
//! 3. An alias matches when its words appear in the name consecutively and
//!    whole: `ag` does not match `stage`. A plural `s`/`es` on the name's
//!    word is tolerated for aliases of three letters or more (`Pads`, `BGVs`),
//!    and so is a singular name for a plural alias of four or more (`Key` for
//!    `keys`). A word glued from the start of one alias and another whole
//!    alias of the same target (`EGtr` = `e`(lectric) + `gtr`) counts as a
//!    one-word match for that target.
//! 4. The alias with the most words wins (`Synth Bass` beats `Synth`); on a
//!    tie the target listed first wins, which lets the template's order set
//!    priorities.

/// The best target for each file, by index into `targets`; `None` where no
/// alias matched. `targets[i]` is the alias list of the i-th target, in the
/// template's order. `song_name` is the song the stems are dropped into, if
/// known, so its name is not mistaken for an instrument.
pub fn match_stems<S: AsRef<str>>(
    file_names: &[&str],
    song_name: Option<&str>,
    targets: &[&[S]],
) -> Vec<Option<usize>> {
    let target_aliases: Vec<Vec<Vec<String>>> = targets
        .iter()
        .map(|aliases| {
            aliases
                .iter()
                .map(|alias| tokenize(alias.as_ref()))
                .filter(|tokens| !tokens.is_empty())
                .collect()
        })
        .collect();
    let files: Vec<Vec<String>> = file_names
        .iter()
        .map(|name| tokenize(file_stem(name)))
        .collect();
    let song_tokens = song_name.map(tokenize).unwrap_or_default();
    let batch_prefix = if files.len() >= 2 {
        common_prefix_len(&files)
    } else {
        0
    };
    // One shared word that names an instrument is what the batch is, not the
    // song it comes from: keep it.
    let batch_prefix =
        if batch_prefix == 1 && best_target(&files[0][..1], &target_aliases).is_some() {
            0
        } else {
            batch_prefix
        };

    files
        .iter()
        .map(|tokens| {
            let words = significant_words(tokens, batch_prefix, &song_tokens);
            best_target(words, &target_aliases)
        })
        .collect()
}

/// The words of `text`, as the matcher compares them. Public so the UI can
/// show the user how an alias will be read.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut previous: Option<char> = None;
    for ch in text.chars() {
        if !ch.is_alphanumeric() {
            flush(&mut tokens, &mut current);
            previous = None;
            continue;
        }
        if let Some(prev) = previous {
            let case_step = prev.is_lowercase() && ch.is_uppercase();
            let letter_digit_step = prev.is_alphabetic() != ch.is_alphabetic();
            if case_step || letter_digit_step {
                flush(&mut tokens, &mut current);
            }
        }
        for lower in ch.to_lowercase() {
            current.push(fold_accent(lower));
        }
        previous = Some(ch);
    }
    flush(&mut tokens, &mut current);
    tokens
}

fn flush(tokens: &mut Vec<String>, current: &mut String) {
    if !current.is_empty() {
        tokens.push(std::mem::take(current));
    }
}

/// `text` lowercased with its accents folded, for comparisons that ignore
/// both (scene rules match "Vóz guía" with "voz").
pub fn fold_text(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .map(fold_accent)
        .collect()
}

/// Folds the accented letters a Spanish, Portuguese or French stem name
/// carries, so "Batería" matches the alias "bateria". Pulling a Unicode
/// normalisation crate in for this would be a dependency for a dozen letters.
fn fold_accent(ch: char) -> char {
    match ch {
        'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' => 'a',
        'é' | 'è' | 'ë' | 'ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
        'ú' | 'ù' | 'ü' | 'û' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        other => other,
    }
}

/// The file name without its folders or its extension. An extension is a last
/// dot followed by one to five letters or digits, so "Gtr. Lead" keeps its
/// words while "EG 1.wav" loses the `.wav`.
fn file_stem(name: &str) -> &str {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rsplit_once('.') {
        Some((stem, ext))
            if !stem.is_empty()
                && (1..=5).contains(&ext.len())
                && ext.chars().all(|ch| ch.is_ascii_alphanumeric()) =>
        {
            stem
        }
        _ => base,
    }
}

fn common_prefix_len(files: &[Vec<String>]) -> usize {
    let shortest = files.iter().map(Vec::len).min().unwrap_or(0);
    (0..shortest)
        .take_while(|&index| files.iter().all(|tokens| tokens[index] == files[0][index]))
        .count()
}

/// The words that say what instrument a file is: without the batch's shared
/// start or the song's name, unless that leaves only numbers or nothing.
fn significant_words<'a>(
    tokens: &'a [String],
    batch_prefix: usize,
    song_tokens: &[String],
) -> &'a [String] {
    let song_prefix = if !song_tokens.is_empty() && tokens.starts_with(song_tokens) {
        song_tokens.len()
    } else {
        0
    };
    let skip = batch_prefix.max(song_prefix).min(tokens.len());
    let rest = &tokens[skip..];
    let only_numbers = rest
        .iter()
        .all(|token| token.chars().all(|ch| ch.is_numeric()));
    if only_numbers {
        tokens
    } else {
        rest
    }
}

fn best_target(words: &[String], targets: &[Vec<Vec<String>>]) -> Option<usize> {
    let mut best: Option<(usize, usize)> = None;
    for (index, aliases) in targets.iter().enumerate() {
        let score = aliases
            .iter()
            .filter(|alias| contains_words(words, alias))
            .map(Vec::len)
            .max()
            .or_else(|| words.iter().any(|word| is_compound(word, aliases)).then_some(1));
        if let Some(score) = score {
            // Strictly greater: on a tie the earlier target keeps the stem.
            if best.is_none_or(|(_, best_score)| score > best_score) {
                best = Some((index, score));
            }
        }
    }
    best.map(|(index, _)| index)
}

fn contains_words(words: &[String], alias: &[String]) -> bool {
    !alias.is_empty()
        && words.len() >= alias.len()
        && words.windows(alias.len()).any(|window| {
            window
                .iter()
                .zip(alias)
                .all(|(word, alias_word)| word_matches(word, alias_word))
        })
}

fn word_matches(word: &str, alias_word: &str) -> bool {
    if word == alias_word {
        return true;
    }
    if alias_word.chars().count() < 3 {
        return false;
    }
    if word
        .strip_prefix(alias_word)
        .is_some_and(|plural| plural == "s" || plural == "es")
    {
        return true;
    }
    // The other way round: the alias is the plural and the file the singular
    // ("keys" ↔ "Key"). Not for a double s, which is no plural ("bass").
    alias_word.chars().count() >= 4
        && !alias_word.ends_with("ss")
        && alias_word.strip_suffix('s') == Some(word)
}

/// One word glued from a qualifier and a one-word alias of the same target:
/// `EGtr` is `e` + `gtr`, `AGtr` is `a` + `gtr`. Multitracks write them that
/// way, and the case step does not cut them. The tail must be an alias of
/// three letters or more and the head the start of another alias of this
/// target (`e` of `eg`/`electric`, `ac` of `acoustic`), so `stage` is still no
/// `ag`.
fn is_compound(word: &str, aliases: &[Vec<String>]) -> bool {
    let singles: Vec<&str> = aliases
        .iter()
        .filter(|alias| alias.len() == 1)
        .map(|alias| alias[0].as_str())
        .collect();
    singles
        .iter()
        .filter(|tail| tail.chars().count() >= 3)
        .any(|tail| {
            word.char_indices().skip(1).any(|(split, _)| {
                let (head, rest) = word.split_at(split);
                word_matches(rest, tail)
                    && singles
                        .iter()
                        .any(|other| other != tail && other.starts_with(head))
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A band template shaped like the built-in one: priorities by order.
    fn band() -> Vec<Vec<&'static str>> {
        vec![
            vec!["click", "clic", "metronome", "metronomo"],
            vec!["guide", "guia", "cues", "cue"],
            vec![
                "drums", "drum", "bateria", "kick", "snare", "hi hat", "perc", "loop",
            ],
            vec!["bass", "bajo", "sub", "synth bass"],
            vec!["eg", "ag", "guitar", "guitarra", "gtr", "electric guitar"],
            vec!["keys", "teclados", "piano", "rhodes", "organ", "b3"],
            vec!["synth", "pad", "strings", "cuerdas"],
            vec!["vox", "voz", "voces", "bgv", "choir", "coros", "lead"],
            vec!["fx", "sfx", "efectos", "sweep", "riser"],
        ]
    }

    const CLICK: usize = 0;
    const GUIDE: usize = 1;
    const DRUMS: usize = 2;
    const BASS: usize = 3;
    const GUITARS: usize = 4;
    const KEYS: usize = 5;
    const SYNTH: usize = 6;
    const VOX: usize = 7;
    const FX: usize = 8;

    fn run(files: &[&str], song: Option<&str>) -> Vec<Option<usize>> {
        let targets = band();
        let refs: Vec<&[&str]> = targets.iter().map(Vec::as_slice).collect();
        match_stems(files, song, &refs)
    }

    #[test]
    fn splits_words_at_case_steps_digits_and_punctuation() {
        assert_eq!(tokenize("EG1"), ["eg", "1"]);
        assert_eq!(tokenize("HiHat_L"), ["hi", "hat", "l"]);
        assert_eq!(
            tokenize("Way Maker - Synth Bass"),
            ["way", "maker", "synth", "bass"]
        );
        assert_eq!(tokenize("BGVs"), ["bgvs"]);
        assert_eq!(tokenize("Batería"), ["bateria"]);
        assert_eq!(tokenize("Guitarra Eléctrica"), ["guitarra", "electrica"]);
    }

    #[test]
    fn a_commercial_multitrack_lands_instrument_by_instrument() {
        let files = [
            "Way Maker - Click.wav",
            "Way Maker - Guide.wav",
            "Way Maker - Drums.wav",
            "Way Maker - Perc.wav",
            "Way Maker - Bass.wav",
            "Way Maker - EG 1.wav",
            "Way Maker - EG 2.wav",
            "Way Maker - AG.wav",
            "Way Maker - Keys.wav",
            "Way Maker - Synth.wav",
            "Way Maker - Pad.wav",
            "Way Maker - BGVs.wav",
            "Way Maker - FX.wav",
            "Way Maker - Tracks.wav",
        ];
        assert_eq!(
            run(&files, None),
            [
                Some(CLICK),
                Some(GUIDE),
                Some(DRUMS),
                Some(DRUMS),
                Some(BASS),
                Some(GUITARS),
                Some(GUITARS),
                Some(GUITARS),
                Some(KEYS),
                Some(SYNTH),
                Some(SYNTH),
                Some(VOX),
                Some(FX),
                None,
            ],
        );
    }

    #[test]
    fn spanish_names_with_accents_match_spanish_aliases() {
        let files = [
            "01 Clic.wav",
            "02 Guía.wav",
            "03 Batería.wav",
            "04 Bajo.wav",
            "05 Coros.wav",
        ];
        assert_eq!(
            run(&files, None),
            [Some(CLICK), Some(GUIDE), Some(DRUMS), Some(BASS), Some(VOX)],
        );
    }

    #[test]
    fn a_song_named_after_an_instrument_does_not_drag_its_stems_along() {
        let files = [
            "Keys to the Kingdom - Click.wav",
            "Keys to the Kingdom - Bass.wav",
            "Keys to the Kingdom - Banjo.wav",
        ];
        assert_eq!(run(&files, None), [Some(CLICK), Some(BASS), None]);
    }

    #[test]
    fn a_single_file_ignores_the_song_name_it_starts_with() {
        assert_eq!(
            run(
                &["Keys to the Kingdom Choir.wav"],
                Some("Keys to the Kingdom")
            ),
            [Some(VOX)],
        );
        // Without the song's name, "keys" is the first thing that matches.
        assert_eq!(run(&["Keys to the Kingdom Choir.wav"], None), [Some(KEYS)]);
    }

    #[test]
    fn a_shared_start_that_is_the_instrument_is_not_thrown_away() {
        // The two files share "EG"; ignoring it would leave only numbers.
        assert_eq!(
            run(&["EG 1.wav", "EG 2.wav"], None),
            [Some(GUITARS), Some(GUITARS)]
        );
    }

    #[test]
    fn a_shared_single_word_that_is_an_instrument_is_kept() {
        // "eg" is what both are; without it "lead" would send one to the vox.
        assert_eq!(
            run(&["EG Lead.wav", "EG Rhythm.wav"], None),
            [Some(GUITARS), Some(GUITARS)],
        );
        assert_eq!(
            run(&["Click.wav", "Click alt.wav"], None),
            [Some(CLICK), Some(CLICK)]
        );
        // A one-word title that is not an instrument still goes.
        assert_eq!(
            run(&["Hosanna Click.wav", "Hosanna Keys.wav"], None),
            [Some(CLICK), Some(KEYS)],
        );
    }

    #[test]
    fn longer_aliases_beat_shorter_ones() {
        // "synth bass" (two words, on the bass) beats "synth" (one, on synths).
        assert_eq!(run(&["Synth Bass.wav"], None), [Some(BASS)]);
    }

    #[test]
    fn on_a_tie_the_target_listed_first_wins() {
        // "lead" is a vox alias, "guitar" a guitar one: one word each, and
        // guitars come first in the template.
        assert_eq!(run(&["Lead Guitar.wav"], None), [Some(GUITARS)]);
        assert_eq!(run(&["Lead.wav"], None), [Some(VOX)]);
    }

    #[test]
    fn aliases_match_whole_words_only() {
        // "ag" must not fire on "stage", nor "fx" on "fxbus"-like words.
        assert_eq!(run(&["Stage Ambience.wav"], None), [None]);
        assert_eq!(run(&["Bassoon.wav"], None), [None]);
    }

    #[test]
    fn plurals_are_tolerated_on_longer_aliases_only() {
        assert_eq!(run(&["Pads.wav"], None), [Some(SYNTH)]);
        assert_eq!(run(&["Strings.wav"], None), [Some(SYNTH)]);
        // "eg" is two letters: "egs" is not read as its plural.
        assert_eq!(run(&["Egs.wav"], None), [None]);
    }

    #[test]
    fn a_singular_name_matches_a_plural_alias() {
        assert_eq!(run(&["Key.wav"], None), [Some(KEYS)]);
        // A double s is not a plural: "bass" never reads as "bas".
        assert_eq!(run(&["Bas.wav"], None), [None]);
    }

    #[test]
    fn a_qualifier_glued_to_an_alias_matches_its_target() {
        assert_eq!(
            run(&["Egtr 6.wav", "Egtr 7.wav", "AGtr.wav"], Some("Song")),
            [Some(GUITARS), Some(GUITARS), Some(GUITARS)]
        );
        assert_eq!(run(&["EGtrs.wav"], None), [Some(GUITARS)]);
        // The head has to start an alias of the same target.
        assert_eq!(run(&["Xgtr.wav"], None), [None]);
        assert_eq!(run(&["Ekeys.wav"], None), [None]);
    }

    #[test]
    fn multi_word_aliases_match_camel_case_and_separators() {
        assert_eq!(run(&["HiHat.wav"], None), [Some(DRUMS)]);
        assert_eq!(run(&["hi_hat.wav"], None), [Some(DRUMS)]);
        assert_eq!(run(&["B3.wav"], None), [Some(KEYS)]);
    }

    #[test]
    fn paths_and_extensions_are_not_part_of_the_name() {
        assert_eq!(run(&["C:\\Stems\\drums\\Bass.wav"], None), [Some(BASS)]);
        assert_eq!(run(&["/stems/keys/Click.flac"], None), [Some(CLICK)]);
        // A dot inside the name is not an extension.
        assert_eq!(run(&["Gtr. Lead"], None), [Some(GUITARS)]);
    }

    #[test]
    fn targets_without_aliases_never_match() {
        let empty: [&str; 0] = [];
        let targets: [&[&str]; 2] = [&empty, &["  ", "-"]];
        assert_eq!(match_stems(&["Click.wav"], None, &targets), [None]);
    }
}
