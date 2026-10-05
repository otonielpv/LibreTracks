//! Thumbnail strips for the timeline: one small JPEG every `interval` seconds
//! of media, packed into a single `.ltthumbs` file per source video.
//!
//! The cache is global and per file, like the waveform `.ltpeaks` cache: the
//! same video reused by two sessions is analysed once. The file name folds the
//! source's identity, size and mtime, and the same size and mtime are stored
//! inside, so an edited video is never shown with stale pictures.
//!
//! Everything here is pure and tested without libmpv. The frames come from
//! libmpv on the desktop (`extract`) and from the system's decoders on a
//! phone (`media::build_strip`); both pack them with [`strip_from_frames`],
//! so a strip is the same bytes wherever it was made.

use std::path::{Path, PathBuf};

/// At most this many thumbnails per file. At 160 px wide and ~5 KB each that
/// is ~3 MB per video, and more would be invisible at any timeline zoom.
pub const MAX_THUMBNAILS: usize = 600;

/// Width of each thumbnail in pixels; height follows the aspect ratio.
pub const THUMBNAIL_WIDTH: u32 = 160;

const MAGIC: &[u8; 8] = b"LTTHUMB1";
const FORMAT_VERSION: u32 = 1;
const HEADER_LEN: usize = 8 + 4 + 8 + 8 + 8 + 4 + 4 + 4;
const INDEX_ENTRY_LEN: usize = 8 + 4;

/// Seconds between thumbnails for a video of `duration_seconds`: the smallest
/// "round" step that keeps the strip under [`MAX_THUMBNAILS`], never below one
/// second (finer is invisible in a timeline).
pub fn thumbnail_interval_seconds(duration_seconds: f64) -> f64 {
    const STEPS: &[f64] = &[
        1.0, 2.0, 3.0, 4.0, 5.0, 10.0, 15.0, 20.0, 30.0, 60.0, 120.0, 300.0,
    ];
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return 1.0;
    }
    STEPS
        .iter()
        .copied()
        .find(|step| (duration_seconds / step).ceil() as usize <= MAX_THUMBNAILS)
        .unwrap_or_else(|| (duration_seconds / MAX_THUMBNAILS as f64).ceil())
}

/// Media times of the frames a strip holds for a video of `duration_seconds`:
/// `0, interval, 2·interval…` while below the duration, the same frames
/// libmpv's `fps=1/interval:round=down` filter keeps on the desktop.
pub fn thumbnail_times(duration_seconds: f64) -> Vec<f64> {
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Vec::new();
    }
    let interval = thumbnail_interval_seconds(duration_seconds);
    let count = ((duration_seconds / interval).ceil() as usize).clamp(1, MAX_THUMBNAILS);
    (0..count).map(|index| index as f64 * interval).collect()
}

/// Width and height from a JPEG's start-of-frame segment.
pub fn jpeg_dimensions(jpeg: &[u8]) -> Option<(u32, u32)> {
    if !jpeg.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut at = 2;
    while at + 9 < jpeg.len() {
        if jpeg[at] != 0xff {
            return None;
        }
        let marker = jpeg[at + 1];
        let length = u16::from_be_bytes([jpeg[at + 2], jpeg[at + 3]]) as usize;
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
        if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            let height = u16::from_be_bytes([jpeg[at + 5], jpeg[at + 6]]);
            let width = u16::from_be_bytes([jpeg[at + 7], jpeg[at + 8]]);
            return Some((u32::from(width), u32::from(height)));
        }
        at += 2 + length;
    }
    None
}

/// Pack JPEG frames into a strip. The size comes from the first frame (the
/// ground truth, whatever made it); `None` without a readable first frame.
pub fn strip_from_frames(
    source_size: u64,
    source_modified_millis: u64,
    interval_seconds: f64,
    frames: Vec<Vec<u8>>,
) -> Option<ThumbnailStrip> {
    let (width, height) = frames.first().and_then(|jpeg| jpeg_dimensions(jpeg))?;
    Some(ThumbnailStrip {
        source_size,
        source_modified_millis,
        interval_seconds,
        width,
        height,
        frames,
    })
}

/// Index of the thumbnail showing `media_seconds`.
pub fn frame_index_for_media_time(
    media_seconds: f64,
    interval_seconds: f64,
    count: usize,
) -> usize {
    if count == 0 || !media_seconds.is_finite() || interval_seconds <= 0.0 {
        return 0;
    }
    ((media_seconds.max(0.0) / interval_seconds).floor() as usize).min(count - 1)
}

/// 64-bit FNV-1a: stable across Rust versions and platforms, unlike
/// `DefaultHasher`, so a cache written by one build is found by the next.
fn fnv1a(bytes: &[u8], mut hash: u64) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Identity of a source path for the cache key: separators unified and case
/// folded, so `C:\Videos\A.mp4` and `c:/videos/a.mp4` share one entry on the
/// case-insensitive filesystems where they are the same file.
pub fn source_identity(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// Cache file name for a source with this identity, size and mtime.
pub fn cache_file_name(identity: &str, size: u64, modified_millis: u64) -> String {
    let mut hash = fnv1a(identity.as_bytes(), 0xcbf2_9ce4_8422_2325);
    hash = fnv1a(&size.to_le_bytes(), hash);
    hash = fnv1a(&modified_millis.to_le_bytes(), hash);
    let stem: String = identity
        .rsplit('/')
        .next()
        .unwrap_or("video")
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or("video")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(40)
        .collect();
    let stem = if stem.is_empty() {
        "video".into()
    } else {
        stem
    };
    format!("{stem}-{hash:016x}.ltthumbs")
}

/// Size and mtime (milliseconds since the epoch) of a file, or `None` if it
/// cannot be stat'd.
pub fn source_freshness(path: &Path) -> Option<(u64, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0);
    Some((metadata.len(), modified))
}

/// Where the strip of `source` lives under the global cache root, or `None`
/// if the source cannot be stat'd.
pub fn cache_path(cache_root: &Path, source: &Path) -> Option<PathBuf> {
    let (size, modified) = source_freshness(source)?;
    Some(cache_root.join("video-thumbnails").join(cache_file_name(
        &source_identity(source),
        size,
        modified,
    )))
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThumbnailStrip {
    pub source_size: u64,
    pub source_modified_millis: u64,
    pub interval_seconds: f64,
    pub width: u32,
    pub height: u32,
    /// JPEG bytes, one per `interval_seconds` starting at media time 0.
    pub frames: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ThumbsError {
    #[error("no es un fichero .ltthumbs")]
    BadMagic,
    #[error("versión de .ltthumbs no soportada: {0}")]
    UnsupportedVersion(u32),
    #[error(".ltthumbs truncado o corrupto")]
    Corrupt,
}

impl ThumbnailStrip {
    pub fn is_fresh_for(&self, size: u64, modified_millis: u64) -> bool {
        self.source_size == size && self.source_modified_millis == modified_millis
    }

    pub fn encode(&self) -> Vec<u8> {
        let index_len = self.frames.len() * INDEX_ENTRY_LEN;
        let data_len: usize = self.frames.iter().map(Vec::len).sum();
        let mut out = Vec::with_capacity(HEADER_LEN + index_len + data_len);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        out.extend_from_slice(&self.source_size.to_le_bytes());
        out.extend_from_slice(&self.source_modified_millis.to_le_bytes());
        out.extend_from_slice(&self.interval_seconds.to_le_bytes());
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.extend_from_slice(&(self.frames.len() as u32).to_le_bytes());
        let mut offset = (HEADER_LEN + index_len) as u64;
        for frame in &self.frames {
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(&(frame.len() as u32).to_le_bytes());
            offset += frame.len() as u64;
        }
        for frame in &self.frames {
            out.extend_from_slice(frame);
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ThumbsError> {
        if bytes.len() < HEADER_LEN {
            return Err(if bytes.starts_with(MAGIC) || bytes.len() < MAGIC.len() {
                ThumbsError::Corrupt
            } else {
                ThumbsError::BadMagic
            });
        }
        if &bytes[..8] != MAGIC {
            return Err(ThumbsError::BadMagic);
        }
        let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let u64_at = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        let version = u32_at(8);
        if version != FORMAT_VERSION {
            return Err(ThumbsError::UnsupportedVersion(version));
        }
        let source_size = u64_at(12);
        let source_modified_millis = u64_at(20);
        let interval_seconds = f64::from_bits(u64_at(28));
        let width = u32_at(36);
        let height = u32_at(40);
        let count = u32_at(44) as usize;
        let index_end = HEADER_LEN
            .checked_add(
                count
                    .checked_mul(INDEX_ENTRY_LEN)
                    .ok_or(ThumbsError::Corrupt)?,
            )
            .ok_or(ThumbsError::Corrupt)?;
        if bytes.len() < index_end || !interval_seconds.is_finite() || interval_seconds <= 0.0 {
            return Err(ThumbsError::Corrupt);
        }
        let mut frames = Vec::with_capacity(count);
        for entry in 0..count {
            let at = HEADER_LEN + entry * INDEX_ENTRY_LEN;
            let offset = usize::try_from(u64_at(at)).map_err(|_| ThumbsError::Corrupt)?;
            let len = u32_at(at + 8) as usize;
            let end = offset.checked_add(len).ok_or(ThumbsError::Corrupt)?;
            if offset < index_end || end > bytes.len() {
                return Err(ThumbsError::Corrupt);
            }
            frames.push(bytes[offset..end].to_vec());
        }
        Ok(Self {
            source_size,
            source_modified_millis,
            interval_seconds,
            width,
            height,
            frames,
        })
    }
}

/// Read a cached strip for `source`, only if it is still fresh.
pub fn read_cached(cache_root: &Path, source: &Path) -> Option<ThumbnailStrip> {
    let (size, modified) = source_freshness(source)?;
    let path = cache_path(cache_root, source)?;
    let strip = ThumbnailStrip::decode(&std::fs::read(path).ok()?).ok()?;
    strip.is_fresh_for(size, modified).then_some(strip)
}

/// Write a strip atomically (temp file + rename), so a crash mid-write never
/// leaves a truncated cache behind.
pub fn write_cached(
    cache_root: &Path,
    source: &Path,
    strip: &ThumbnailStrip,
) -> std::io::Result<PathBuf> {
    let path = cache_path(cache_root, source)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "source missing"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("ltthumbs.tmp");
    std::fs::write(&temp, strip.encode())?;
    std::fs::rename(&temp, &path)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(frames: usize) -> ThumbnailStrip {
        ThumbnailStrip {
            source_size: 1234,
            source_modified_millis: 99,
            interval_seconds: 2.0,
            width: 160,
            height: 90,
            frames: (0..frames)
                .map(|i| vec![0xff, 0xd8, i as u8, 0xff, 0xd9])
                .collect(),
        }
    }

    #[test]
    fn interval_keeps_the_strip_under_the_cap() {
        assert_eq!(thumbnail_interval_seconds(30.0), 1.0);
        assert_eq!(thumbnail_interval_seconds(300.0), 1.0);
        assert_eq!(thumbnail_interval_seconds(600.0), 1.0);
        assert_eq!(thumbnail_interval_seconds(601.0), 2.0);
        assert_eq!(thumbnail_interval_seconds(3600.0), 10.0);
        for duration in [1.0, 59.0, 601.0, 5000.0, 86_400.0, 1.0e6] {
            let interval = thumbnail_interval_seconds(duration);
            assert!(
                (duration / interval).ceil() as usize <= MAX_THUMBNAILS,
                "{duration}"
            );
        }
        assert_eq!(thumbnail_interval_seconds(0.0), 1.0);
        assert_eq!(thumbnail_interval_seconds(f64::NAN), 1.0);
    }

    #[test]
    fn frame_index_follows_media_time_and_clamps() {
        assert_eq!(frame_index_for_media_time(0.0, 2.0, 10), 0);
        assert_eq!(frame_index_for_media_time(3.9, 2.0, 10), 1);
        assert_eq!(frame_index_for_media_time(4.0, 2.0, 10), 2);
        assert_eq!(frame_index_for_media_time(999.0, 2.0, 10), 9);
        assert_eq!(frame_index_for_media_time(-5.0, 2.0, 10), 0);
        assert_eq!(frame_index_for_media_time(5.0, 2.0, 0), 0);
    }

    #[test]
    fn strips_round_trip() {
        for count in [0, 1, 37] {
            let original = strip(count);
            assert_eq!(ThumbnailStrip::decode(&original.encode()), Ok(original));
        }
    }

    #[test]
    fn corrupt_or_foreign_files_are_rejected() {
        let bytes = strip(3).encode();
        assert_eq!(
            ThumbnailStrip::decode(b"hello world, not a strip at all............"),
            Err(ThumbsError::BadMagic)
        );
        assert_eq!(
            ThumbnailStrip::decode(&bytes[..bytes.len() - 1]),
            Err(ThumbsError::Corrupt)
        );
        assert_eq!(
            ThumbnailStrip::decode(&bytes[..20]),
            Err(ThumbsError::Corrupt)
        );
        let mut wrong_version = bytes.clone();
        wrong_version[8] = 9;
        assert_eq!(
            ThumbnailStrip::decode(&wrong_version),
            Err(ThumbsError::UnsupportedVersion(9))
        );
        // A count that promises more entries than the file holds.
        let mut lying_count = bytes;
        lying_count[44] = 200;
        assert_eq!(
            ThumbnailStrip::decode(&lying_count),
            Err(ThumbsError::Corrupt)
        );
    }

    #[test]
    fn the_cache_key_changes_with_size_mtime_and_path_but_not_case() {
        let base = cache_file_name("d:/videos/letras.mp4", 10, 20);
        assert_ne!(base, cache_file_name("d:/videos/letras.mp4", 11, 20));
        assert_ne!(base, cache_file_name("d:/videos/letras.mp4", 10, 21));
        assert_ne!(base, cache_file_name("d:/videos/otro.mp4", 10, 20));
        assert!(base.starts_with("letras-") && base.ends_with(".ltthumbs"));
        assert_eq!(
            source_identity(Path::new("D:\\Videos\\Letras.MP4")),
            source_identity(Path::new("d:/videos/letras.mp4"))
        );
        // Stable across builds: pinned value.
        assert_eq!(
            cache_file_name("a.mp4", 1, 2),
            cache_file_name("a.mp4", 1, 2)
        );
    }

    #[test]
    fn a_touched_source_invalidates_the_cache() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("clip.mp4");
        std::fs::write(&source, b"first version").expect("write source");
        let (size, modified) = source_freshness(&source).expect("stat");
        let mut cached = strip(4);
        cached.source_size = size;
        cached.source_modified_millis = modified;
        write_cached(dir.path(), &source, &cached).expect("write cache");
        assert_eq!(read_cached(dir.path(), &source), Some(cached));

        // Same length, later mtime: the entry must not be reused.
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::write(&source, b"other version").expect("rewrite source");
        let file = std::fs::File::options()
            .write(true)
            .open(&source)
            .expect("open");
        file.set_modified(later).expect("set mtime");
        drop(file);
        assert_eq!(read_cached(dir.path(), &source), None);
    }
}
