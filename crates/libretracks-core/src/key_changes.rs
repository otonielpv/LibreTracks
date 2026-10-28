//! Cambios de nota dentro de una canción (modulaciones).
//!
//! La nota es metadato de la región: `SongRegion.key` es la inicial y
//! `SongRegion.key_changes` los cambios, con posiciones relativas al inicio de
//! la región. Aquí viven las reglas que comparten todas las operaciones que
//! recortan, parten o reconstruyen una región: qué nota rige en un instante y
//! cómo se reparte un mapa de notas entre dos trozos.

use crate::model::{KeyChange, KeyMap, SongRegion};

/// Dos posiciones a menos de esto son el mismo instante.
pub const KEY_CHANGE_EPS: f64 = 1e-6;

impl KeyMap {
    /// Nota que rige en `offset`: la del último cambio en o antes de él, o la
    /// inicial.
    pub fn key_at(&self, offset: f64) -> Option<&str> {
        self.changes
            .iter()
            .filter(|change| change.offset_seconds <= offset + KEY_CHANGE_EPS)
            .max_by(|left, right| left.offset_seconds.total_cmp(&right.offset_seconds))
            .map(|change| change.key.as_str())
            .or(self.key.as_deref())
    }

    /// El tramo `[start, end)` de este mapa, con las posiciones contadas desde
    /// `start`: la nota inicial es la que regía en `start`.
    pub fn slice(&self, start: f64, end: f64) -> KeyMap {
        KeyMap {
            key: self.key_at(start).map(str::to_string),
            changes: self
                .changes
                .iter()
                .filter(|change| {
                    change.offset_seconds > start + KEY_CHANGE_EPS
                        && change.offset_seconds < end - KEY_CHANGE_EPS
                })
                .map(|change| KeyChange {
                    offset_seconds: change.offset_seconds - start,
                    ..change.clone()
                })
                .collect(),
        }
    }

    /// Ordena los cambios y quita los que caen fuera de `(0, length)` y los
    /// que no cambian nada (la misma nota que ya regía). Un cambio en el mismo
    /// instante que otro gana sobre él.
    pub fn normalized(mut self, length: f64) -> KeyMap {
        self.changes.retain(|change| {
            change.offset_seconds.is_finite()
                && change.offset_seconds > KEY_CHANGE_EPS
                && change.offset_seconds < length - KEY_CHANGE_EPS
                && !change.key.trim().is_empty()
        });
        self.changes
            .sort_by(|left, right| left.offset_seconds.total_cmp(&right.offset_seconds));
        let mut kept: Vec<KeyChange> = Vec::with_capacity(self.changes.len());
        for change in self.changes {
            if let Some(last) = kept.last_mut() {
                if (change.offset_seconds - last.offset_seconds).abs() <= KEY_CHANGE_EPS {
                    *last = change;
                    continue;
                }
            }
            kept.push(change);
        }
        let mut previous = self.key.clone();
        kept.retain(|change| {
            let changes = previous.as_deref() != Some(change.key.as_str());
            if changes {
                previous = Some(change.key.clone());
            }
            changes
        });
        self.changes = kept;
        self
    }
}

impl SongRegion {
    /// La nota inicial y los cambios de la región.
    pub fn key_map(&self) -> KeyMap {
        KeyMap {
            key: self.key.clone(),
            changes: self.key_changes.clone(),
        }
    }

    /// Sustituye la nota de la región por `map`, normalizado a su duración.
    pub fn set_key_map(&mut self, map: KeyMap) {
        let map = map.normalized(self.end_seconds - self.start_seconds);
        self.key = map.key;
        self.key_changes = map.changes;
    }

    /// Nota que rige en `timeline_seconds` (tiempo de fuente del timeline).
    pub fn key_at(&self, timeline_seconds: f64) -> Option<&str> {
        self.key_changes
            .iter()
            .filter(|change| {
                self.start_seconds + change.offset_seconds <= timeline_seconds + KEY_CHANGE_EPS
            })
            .max_by(|left, right| left.offset_seconds.total_cmp(&right.offset_seconds))
            .map(|change| change.key.as_str())
            .or(self.key.as_deref())
    }

    /// El trozo `[start, end)` del timeline de la nota de esta región, listo
    /// para una región que empiece en `start` (partir, recortar un fragmento).
    pub fn key_map_between(&self, start: f64, end: f64) -> KeyMap {
        self.key_map()
            .slice(start - self.start_seconds, end - self.start_seconds)
    }

    /// Tras cambiar `start_seconds`/`end_seconds` en sitio, devuelve los
    /// cambios a su instante del timeline: `previous_start` es el inicio que
    /// tenía la región. Redimensionar nunca mueve el contenido, así que la
    /// modulación sigue donde suena; la que queda fuera se pierde.
    pub fn rebase_key_changes(&mut self, previous_start: f64) {
        let previous = KeyMap {
            key: self.key.clone(),
            changes: self.key_changes.clone(),
        };
        let map = previous.slice(
            self.start_seconds - previous_start,
            self.end_seconds - previous_start,
        );
        // Al alargar por la izquierda el tramo nuevo no tenía nota: sigue
        // siendo la inicial de antes, no `None`.
        let key = if self.start_seconds < previous_start {
            self.key.clone()
        } else {
            map.key
        };
        self.set_key_map(KeyMap {
            key,
            changes: map.changes,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(offset: f64, key: &str) -> KeyChange {
        KeyChange {
            id: format!("k{offset}"),
            offset_seconds: offset,
            key: key.to_string(),
        }
    }

    fn map(key: &str, changes: Vec<KeyChange>) -> KeyMap {
        KeyMap {
            key: Some(key.to_string()),
            changes,
        }
    }

    #[test]
    fn the_key_in_force_is_the_last_change_at_or_before() {
        let keys = map("D", vec![change(180.0, "E"), change(240.0, "F#")]);
        assert_eq!(keys.key_at(0.0), Some("D"));
        assert_eq!(keys.key_at(179.9), Some("D"));
        assert_eq!(keys.key_at(180.0), Some("E"));
        assert_eq!(keys.key_at(300.0), Some("F#"));
    }

    #[test]
    fn a_slice_starts_in_the_key_that_was_sounding() {
        let keys = map("D", vec![change(100.0, "E"), change(200.0, "F#")]);
        let right = keys.slice(150.0, 300.0);
        assert_eq!(right.key.as_deref(), Some("E"));
        assert_eq!(right.changes.len(), 1);
        assert_eq!(right.changes[0].id, "k200");
        assert_eq!(right.changes[0].offset_seconds, 50.0);
        let left = keys.slice(0.0, 150.0);
        assert_eq!(left.key.as_deref(), Some("D"));
        assert_eq!(left.changes.len(), 1);
    }

    #[test]
    fn normalizing_drops_changes_that_change_nothing_or_fall_outside() {
        let keys = map(
            "D",
            vec![
                change(50.0, "D"),
                change(300.0, "G"),
                change(100.0, "E"),
                change(0.0, "A"),
                change(120.0, "E"),
            ],
        )
        .normalized(200.0);
        assert_eq!(keys.changes.len(), 1);
        assert_eq!(keys.changes[0].key, "E");
        assert_eq!(keys.changes[0].offset_seconds, 100.0);
    }

    #[test]
    fn two_changes_at_the_same_instant_keep_the_last() {
        let keys = map("D", vec![change(100.0, "E"), change(100.0, "F")]).normalized(200.0);
        assert_eq!(keys.changes.len(), 1);
        assert_eq!(keys.changes[0].key, "F");
    }

    #[test]
    fn resizing_keeps_each_change_where_it_sounds() {
        let mut region = SongRegion {
            id: "r".into(),
            name: "r".into(),
            start_seconds: 10.0,
            end_seconds: 310.0,
            transpose_semitones: 0,
            key: Some("D".into()),
            warp_enabled: false,
            warp_source_bpm: None,
            master: Default::default(),
            compact_column_width_rem: None,
            structure: None,
            chart: None,
            cover_image: None,
            voice_guide_count_style: None,
            key_changes: vec![change(180.0, "E")],
        };
        assert_eq!(region.key_at(190.0), Some("E"));
        region.start_seconds = 4.0;
        region.rebase_key_changes(10.0);
        assert_eq!(region.key.as_deref(), Some("D"));
        assert_eq!(region.key_changes[0].offset_seconds, 186.0);
        assert_eq!(region.key_at(190.0), Some("E"));

        region.start_seconds = 200.0;
        region.rebase_key_changes(4.0);
        assert_eq!(region.key.as_deref(), Some("E"));
        assert!(region.key_changes.is_empty());
    }
}
