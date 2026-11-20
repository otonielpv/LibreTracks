//! Audio subsystem: the `AudioController`/engine bridge to the C++ audio
//! engine (`engine`) and the automation document/model (`automation`).

pub mod automation;
pub mod engine;
pub(crate) mod eq_spectrum;
pub mod idle_suspend;
pub mod pitch_prerender;
pub mod wake_prompt;
