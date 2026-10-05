//! The phone's [`VideoProbe`] and [`FrameExtractor`] (plan `video-mobile`,
//! paso 07): thin calls into the platform (`MediaMetadataRetriever` on
//! Android, `AVURLAsset` / `AVAssetImageGenerator` on iOS). What the answers
//! mean is decided in `libretracks_video::media`, tested on every host.
//!
//! Both block the calling thread, which is the thumbnail worker or an async
//! import command — never the UI or the audio thread.

#![cfg(any(target_os = "android", target_os = "ios"))]

use std::path::Path;

use libretracks_core::VideoAssetInfo;
use libretracks_video::media::{parse_native_probe, FrameExtractor, ProbeError, VideoProbe};

#[cfg(target_os = "android")]
use crate::platform::android_video as platform;
#[cfg(target_os = "ios")]
use crate::platform::ios_video as platform;

fn label(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

pub struct NativeVideoProbe;

impl VideoProbe for NativeVideoProbe {
    fn probe(&self, path: &Path) -> Result<VideoAssetInfo, ProbeError> {
        let json = platform::probe_json(&path.to_string_lossy()).map_err(ProbeError::Failed)?;
        parse_native_probe(&json, &label(path))
    }
}

pub struct NativeFrameExtractor;

impl FrameExtractor for NativeFrameExtractor {
    fn frames(&mut self, path: &Path, times: &[f64], max_width: u32) -> Vec<Option<Vec<u8>>> {
        platform::frames(&path.to_string_lossy(), times, max_width)
    }
}
