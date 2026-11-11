//! Bringing a `.lttemplate` from elsewhere into the templates folder.
//!
//! The templates folder is the one place the app looks for templates (the
//! landing list, «Nueva canción desde plantilla», the default template in
//! Settings). A template saved on another machine, sent by a bandmate or
//! downloaded from the cloud only becomes usable once it lives there, so
//! "importing" a template is copying it in, after checking it really is one.

use std::fs;
use std::path::{Path, PathBuf};

use libretracks_project::load_song_from_file;

use super::TemplateSummary;
use crate::infra::error::DesktopError;

/// Copy `source` into `catalog_dir` and return how it is listed there.
///
/// `preferred_stem` is the name the user knows the template by. It matters
/// when `source` is a staged copy whose own name is not the real one (a cloud
/// download keeps its name, an Android pick lands as `<stamp>-<name>`).
///
/// - A file that does not parse as a session document is refused before
///   anything is written, so a stray file cannot end up in the picker.
/// - Importing the same template twice is a no-op that returns the copy
///   already there, instead of piling up `Banda (2)`, `Banda (3)`…
/// - A different template with the same name gets a numbered name: the one
///   already in the folder may be the default template in Settings, and
///   overwriting it would silently change what new songs start from.
pub(crate) fn import_template_into_catalog(
    source: &Path,
    catalog_dir: &Path,
    preferred_stem: Option<&str>,
) -> Result<TemplateSummary, DesktopError> {
    load_song_from_file(source).map_err(|error| {
        DesktopError::AudioCommand(format!("el archivo no es una plantilla válida: {error}"))
    })?;
    let bytes = fs::read(source)?;

    let stem = preferred_stem
        .map(str::trim)
        .filter(|stem| !stem.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            source
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_owned)
        })
        .map(|stem| sanitize_stem(&stem))
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "Plantilla".to_owned());

    fs::create_dir_all(catalog_dir)?;
    let mut index = 1;
    let target = loop {
        let name = if index == 1 {
            stem.clone()
        } else {
            format!("{stem} ({index})")
        };
        let candidate = catalog_dir.join(format!("{name}.lttemplate"));
        if !candidate.exists() {
            break candidate;
        }
        if fs::read(&candidate).is_ok_and(|existing| existing == bytes) {
            return Ok(summary_for(candidate, name));
        }
        index += 1;
    };

    libretracks_project::write_file_atomically(&target, &bytes)?;
    let name = target
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(&stem)
        .to_owned();
    Ok(summary_for(target, name))
}

/// Strip the extension a caller may have left on, and anything a file name
/// cannot hold on some platform.
fn sanitize_stem(stem: &str) -> String {
    let stem = stem
        .strip_suffix(".lttemplate")
        .or_else(|| stem.strip_suffix(".LTTEMPLATE"))
        .unwrap_or(stem);
    stem.chars()
        .map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { '-' } else { c })
        .collect::<String>()
        .trim()
        .trim_end_matches('.')
        .to_owned()
}

fn summary_for(path: PathBuf, name: String) -> TemplateSummary {
    TemplateSummary {
        name,
        path: path.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libretracks_project::save_song_to_file;
    use tempfile::tempdir;

    fn write_template(path: &Path, title: &str) {
        let mut song = super::super::strip_song_to_template(
            super::super::tests::demo_song_with_two_sections(),
        );
        song.title = title.into();
        save_song_to_file(path, &song).expect("write template");
    }

    #[test]
    fn copies_a_template_into_the_catalog_under_its_name() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("Mi banda.lttemplate");
        write_template(&source, "Mi banda");
        let catalog = dir.path().join("templates");

        let summary = import_template_into_catalog(&source, &catalog, None).unwrap();

        assert_eq!(summary.name, "Mi banda");
        assert!(catalog.join("Mi banda.lttemplate").exists());
    }

    #[test]
    fn the_preferred_name_wins_over_a_staged_file_name() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("1731312000-Coro.lttemplate");
        write_template(&source, "Coro");
        let catalog = dir.path().join("templates");

        let summary =
            import_template_into_catalog(&source, &catalog, Some("Coro.lttemplate")).unwrap();

        assert_eq!(summary.name, "Coro");
        assert!(catalog.join("Coro.lttemplate").exists());
    }

    #[test]
    fn importing_the_same_template_twice_keeps_one_copy() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("Banda.lttemplate");
        write_template(&source, "Banda");
        let catalog = dir.path().join("templates");

        let first = import_template_into_catalog(&source, &catalog, None).unwrap();
        let second = import_template_into_catalog(&source, &catalog, None).unwrap();

        assert_eq!(first.path, second.path);
        assert_eq!(fs::read_dir(&catalog).unwrap().count(), 1);
    }

    #[test]
    fn a_different_template_with_the_same_name_does_not_overwrite() {
        let dir = tempdir().unwrap();
        let catalog = dir.path().join("templates");
        fs::create_dir_all(&catalog).unwrap();
        write_template(&catalog.join("Banda.lttemplate"), "La de siempre");
        let source = dir.path().join("Banda.lttemplate");
        write_template(&source, "Otra distinta");

        let summary = import_template_into_catalog(&source, &catalog, None).unwrap();

        assert_eq!(summary.name, "Banda (2)");
        let original = load_song_from_file(&catalog.join("Banda.lttemplate")).unwrap();
        assert_eq!(original.title, "La de siempre");
    }

    #[test]
    fn a_file_that_is_not_a_template_is_refused_and_nothing_is_written() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("notas.lttemplate");
        fs::write(&source, b"esto no es json").unwrap();
        let catalog = dir.path().join("templates");

        assert!(import_template_into_catalog(&source, &catalog, None).is_err());
        assert!(!catalog.join("notas.lttemplate").exists());
    }
}
