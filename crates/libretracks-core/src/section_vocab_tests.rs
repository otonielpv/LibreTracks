use super::*;
use crate::model::{Marker, MarkerKind};

fn id(kind: MarkerKind, variant: Option<u8>) -> Option<SectionId> {
    Some(SectionId { kind, variant })
}

#[test]
fn real_group_names_read_as_their_section() {
    use MarkerKind::*;
    let cases: &[(&str, Option<SectionId>)] = &[
        ("Verso 1", id(Verse, Some(1))),
        ("VERSO 2", id(Verse, Some(2))),
        ("Estrofa", id(Verse, None)),
        ("Coro", id(Chorus, None)),
        ("Pre-Coro", id(PreChorus, None)),
        ("Precoro", id(PreChorus, None)),
        ("Puente", id(Bridge, None)),
        ("Estribillo", id(Refrain, None)),
        ("Verse 1", id(Verse, Some(1))),
        ("Chorus 1", id(Chorus, Some(1))),
        ("Pre-Chorus", id(PreChorus, None)),
        ("Bridge 2", id(Bridge, Some(2))),
        ("Tag", id(Tag, None)),
        ("V1", id(Verse, Some(1))),
        ("C", id(Chorus, None)),
        ("C2", id(Chorus, Some(2))),
        ("PC", id(PreChorus, None)),
        ("B", id(Bridge, None)),
        ("verse_2", id(Verse, Some(2))),
        ("pre_chorus", id(PreChorus, None)),
        ("Refrão", id(Chorus, None)),
        ("Refrao 2", id(Chorus, Some(2))),
        ("Pré-refrão", id(PreChorus, None)),
        ("Ponte", id(Bridge, None)),
        ("Estrofe 3", id(Verse, Some(3))),
        ("Final", id(Ending, None)),
        ("Outro", id(Outro, None)),
        ("Intro", id(Intro, None)),
        ("Introducción", id(Intro, None)),
        ("Introdução", id(Intro, None)),
        ("Instrumental", id(Instrumental, None)),
        ("Interludio", id(Interlude, None)),
        ("Interlude", id(Interlude, None)),
        ("Turnaround", id(Turnaround, None)),
        ("Vamp", id(Vamp, None)),
        ("Ending", id(Ending, None)),
        ("Post-Chorus", id(PostChorus, None)),
        ("Coro dos", id(Chorus, Some(2))),
        ("  chorus   3 ", id(Chorus, Some(3))),
        ("Solo de guitarra", None), // a filler word: not an exact label
        ("Guitar Solo", id(GuitarSolo, None)),
        ("Anuncios", None),
        ("Bienvenida", None),
        ("", None),
        ("Build", None),        // a cue, not a section
        ("Break", None),        // FreeShow's break: a cue kind here
        ("Siguiente canción", None),
        ("Verse 0", None),
        ("Coda", None),
    ];
    assert!(cases.len() >= 40);
    for (text, expected) in cases {
        assert_eq!(canonical_section(text), *expected, "{text:?}");
    }
}

#[test]
fn markers_read_kind_and_variant_not_the_label() {
    let marker = |kind, variant, name: &str| Marker {
        id: "m".into(),
        name: name.into(),
        start_seconds: 0.0,
        digit: None,
        kind,
        variant,
        color: None,
        category_override: None,
    };
    // The label is whatever language the marker was created in.
    assert_eq!(
        marker_section_id(&marker(MarkerKind::Chorus, Some(2), "Estribillo raro")),
        id(MarkerKind::Chorus, Some(2))
    );
    assert_eq!(
        marker_section_id(&marker(MarkerKind::Custom, None, "Puente 2")),
        id(MarkerKind::Bridge, Some(2))
    );
    assert_eq!(marker_section_id(&marker(MarkerKind::Custom, None, "Ofrenda")), None);
    assert_eq!(marker_section_id(&marker(MarkerKind::Build, None, "Build")), None);
    // Dragged into the cue lane: no longer a section.
    let mut dragged = marker(MarkerKind::Chorus, None, "Coro");
    dragged.category_override = Some(crate::model::MarkerCategory::Cue);
    assert_eq!(marker_section_id(&dragged), None);
}

#[test]
fn titles_normalize_for_matching() {
    for (text, expected) in [
        ("Way Maker (En vivo)", "way maker"),
        ("01 Cuán Grande Es Él - G", "cuan grande es el"),
        ("1. Way Maker - F#m", "way maker"),
        ("Oceans [Key of D]", "oceans"),
        ("  Tú   Reinas! ", "tu reinas"),
        ("What A Beautiful Name", "what a beautiful name"),
        ("God's Great Dance Floor", "gods great dance floor"),
        ("Rey de reyes - En vivo", "rey de reyes en vivo"),
        ("Coração Igual Ao Teu", "coracao igual ao teu"),
        ("10,000 Reasons", "10 000 reasons"),
    ] {
        assert_eq!(normalize_title(text), expected, "{text:?}");
    }
}
