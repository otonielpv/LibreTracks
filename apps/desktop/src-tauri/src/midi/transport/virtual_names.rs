//! LibreTracks' own virtual MIDI ports: "LibreTracks In" (other apps send to
//! it; an input for us) and "LibreTracks Out" (other apps read from it; an
//! output for us). Same names on iOS (paso 07) and Android (paso 10), so a
//! session saved on one platform finds the port on the other.
//!
//! The system lists our own virtual endpoints back to us (on iOS, the
//! CoreMIDI source we publish shows up among the sources we could open), and
//! opening our own port through the system would loop LibreTracks into
//! itself. So the system's copies are always removed, and the port is added
//! back once, as the internal one, only while publishing is enabled.

pub(crate) const VIRTUAL_IN: &str = "LibreTracks In";
pub(crate) const VIRTUAL_OUT: &str = "LibreTracks Out";

/// `system` names with our own virtual ports removed, plus `own` (our port in
/// this direction) at the end when publishing is enabled.
pub(crate) fn with_own_virtual_port(system: Vec<String>, own: Option<&str>) -> Vec<String> {
    let mut names: Vec<String> = system
        .into_iter()
        .filter(|name| name != VIRTUAL_IN && name != VIRTUAL_OUT)
        .collect();
    if let Some(own) = own {
        names.push(own.to_string());
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn our_ports_appear_exactly_once_when_enabled() {
        // The system lists both of our endpoints back to us.
        let inputs = with_own_virtual_port(
            names(&["Pedal", VIRTUAL_OUT, VIRTUAL_IN]),
            Some(VIRTUAL_IN),
        );
        assert_eq!(inputs, names(&["Pedal", VIRTUAL_IN]));
        let outputs = with_own_virtual_port(names(&[VIRTUAL_IN, "Desk"]), Some(VIRTUAL_OUT));
        assert_eq!(outputs, names(&["Desk", VIRTUAL_OUT]));
    }

    #[test]
    fn disabled_hides_them_even_if_the_system_still_lists_them() {
        assert_eq!(
            with_own_virtual_port(names(&["Pedal", VIRTUAL_OUT]), None),
            names(&["Pedal"])
        );
    }
}
