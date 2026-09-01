//! Display name of a document picked through Android's Storage Access
//! Framework.
//!
//! A SAF pick is a `content://` URI, not a path, and its last segment is a
//! *document id* whose shape depends on the provider that answered the picker:
//!
//! - external storage: `primary:Download/Mi Set.ltset`
//! - the Downloads provider: `raw:/storage/emulated/0/Download/Mi Set.ltset`
//!   (and, on newer Android, opaque ids like `msf:28`)
//!
//! Only the last path component of that id is a name a person recognises.
//! Taking the whole id is what produced session folders literally called
//! `raw--storage-emulated-0-Download-mi-set`: the import derives the new
//! project folder from this name, and the sanitiser downstream turns every
//! `/` and `:` into `-`.
//!
//! Lives outside `mobile_files` (which is `#![cfg(target_os = "android")]`, so
//! no desktop `cargo check` ever compiles it) precisely so the parsing is
//! covered by the normal test run — the same split as
//! `platform::merge_output_devices`.

/// The user-facing file name inside a SAF document URI's last segment.
///
/// The segment arrives percent-encoded (`primary%3ADownload%2Fx.ltset`).
/// Returns the empty string only when the segment itself carries nothing
/// usable; callers fall back to a generic name in that case.
// Only the Android SAF flows call these; a desktop build compiles the module
// (that is the whole point — its tests run everywhere) but nothing in it.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn document_display_name(uri_segment: &str) -> String {
    let document_id = percent_decode(uri_segment);
    // Document ids are `<root>:<path>`. Split on the FIRST colon so a file name
    // that legitimately contains one keeps it (ext4 allows `:`), then keep the
    // last component of the path half.
    let path = document_id
        .split_once(':')
        .map(|(_root, path)| path)
        .unwrap_or(document_id.as_str());
    let name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .trim()
        .to_string();
    if name.is_empty() {
        // A trailing separator (or an id that was nothing but a root) leaves us
        // empty-handed; hand back the decoded id so the caller can still show
        // *something* in an error message.
        return document_id.trim().to_string();
    }
    name
}

/// Minimal percent-decoder for the URI segments SAF hands back. Kept local:
/// pulling a URL crate in for `%20`/`%3A` would be the only reason to have one.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_downloads_provider_raw_id_yields_just_the_file_name() {
        // The reported bug: importing a .ltset from Downloads created a session
        // folder called "raw--storage-emulated-0-Download-mi-set".
        assert_eq!(
            document_display_name("raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2FMi%20Set.ltset"),
            "Mi Set.ltset"
        );
    }

    #[test]
    fn the_external_storage_id_yields_just_the_file_name() {
        assert_eq!(
            document_display_name("primary%3ADownload%2FMi%20Set.ltset"),
            "Mi Set.ltset"
        );
    }

    #[test]
    fn an_opaque_id_keeps_its_id_so_the_caller_can_reject_it() {
        // "msf:28" has no extension; `sanitize_saf_name_hint` turns anything
        // without a dot into the generic fallback name, which is what we want
        // — but that decision belongs to the caller, not here.
        assert_eq!(document_display_name("msf%3A28"), "28");
    }

    #[test]
    fn a_plain_segment_passes_through() {
        assert_eq!(document_display_name("Mi%20Set.ltset"), "Mi Set.ltset");
    }

    #[test]
    fn a_colon_inside_the_file_name_survives() {
        // Only the root prefix is stripped, so a name that itself contains a
        // colon is not truncated to its tail.
        assert_eq!(
            document_display_name("primary%3AMusic%2FIntro%3A%20Reprise.ltset"),
            "Intro: Reprise.ltset"
        );
    }

    #[test]
    fn an_empty_or_rootless_segment_never_panics() {
        assert_eq!(document_display_name(""), "");
        assert_eq!(document_display_name("primary%3A"), "primary:");
    }
}
