//! Speech recognition for "Analizar canción": reads a guide track's
//! announcements ("Verso 3, entra batería") whatever the voice.
//!
//! whisper.cpp (via `whisper-rs`) with the multilingual `base` model,
//! quantised (57 MB), downloaded once on demand from the whisper.cpp model
//! repository and checked against its SHA-256. Desktop only for now: on
//! Android and iOS whisper.cpp is not built yet, and the guide analysis falls
//! back to the app's voice clips. See docs/plans/completed/song-analysis/04.

use serde::Serialize;
use tauri::{AppHandle, Manager};

pub const SPEECH_MODEL_PROGRESS_EVENT: &str = "speech-model-progress";

const MODEL_FILE: &str = "ggml-base-q5_1.bin";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin";
const MODEL_SHA256: &str = "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898";
const MODEL_BYTES: u64 = 59_707_625;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelStatus {
    /// Speech recognition is built for this platform.
    pub supported: bool,
    /// The model is on disk.
    pub downloaded: bool,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelProgressPayload {
    fraction: f64,
}

fn model_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join("models").join(MODEL_FILE))
}

/// The model file, once downloaded.
pub(crate) fn ready_model(app: &AppHandle) -> Option<std::path::PathBuf> {
    model_path(app).filter(|path| path.is_file())
}

#[tauri::command(async)]
pub fn speech_model_status(app: AppHandle) -> SpeechModelStatus {
    SpeechModelStatus {
        supported: true,
        downloaded: ready_model(&app).is_some(),
        size_bytes: MODEL_BYTES,
    }
}

#[tauri::command]
pub async fn download_speech_model(app: AppHandle) -> Result<SpeechModelStatus, String> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    use tauri::Emitter;

    let path = model_path(&app).ok_or_else(|| "No app data folder".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let partial = path.with_extension("part");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 30))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(MODEL_URL)
        .send()
        .await
        .map_err(|e| format!("download request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download returned HTTP {}", response.status()));
    }
    let total = response
        .content_length()
        .filter(|&l| l > 0)
        .unwrap_or(MODEL_BYTES);
    let mut file = std::fs::File::create(&partial).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_percent = u64::MAX;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download stream error: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        let percent = downloaded.min(total) * 100 / total;
        if percent != last_percent {
            last_percent = percent;
            let _ = app.emit(
                SPEECH_MODEL_PROGRESS_EVENT,
                ModelProgressPayload {
                    fraction: percent as f64 / 100.0,
                },
            );
        }
    }
    drop(file);
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if digest != MODEL_SHA256 {
        let _ = std::fs::remove_file(&partial);
        return Err("The downloaded model is damaged (checksum mismatch)".to_string());
    }
    std::fs::rename(&partial, &path).map_err(|e| e.to_string())?;
    Ok(speech_model_status(app))
}

pub(crate) use whisper::WhisperTranscriber;

mod whisper {
    use libretracks_analysis::Transcriber;
    use whisper_rs::{
        FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
    };

    /// What a guide may say, given to the recogniser as context: lone words
    /// are guessed far better when the vocabulary is known ("Coro", not
    /// "Godo").
    const PROMPT_ES: &str = concat!(
        "Intro, Verso 1, Verso 2, Pre coro, Coro, Puente, Instrumental, Interludio, Solo, ",
        "Final, Tag, Vamp, Exhortación, Toda la banda, Entra batería, Subir intensidad, ",
        "Bajar intensidad, Suave, Uno, dos, tres, cuatro."
    );
    const PROMPT_EN: &str = concat!(
        "Intro, Verse 1, Verse 2, Pre chorus, Chorus, Bridge, Instrumental, Interlude, Solo, ",
        "Outro, Ending, Tag, Vamp, Turnaround, Breakdown, All in, Drums in, Build, Softly, ",
        "One, two, three, four."
    );

    pub(crate) struct WhisperTranscriber {
        state: WhisperState,
        // Kept alive for the state.
        _context: WhisperContext,
        language: &'static str,
        threads: i32,
        cancelled: Box<dyn Fn() -> bool + Send>,
    }

    impl WhisperTranscriber {
        pub(crate) fn load(
            model: &std::path::Path,
            cancelled: Box<dyn Fn() -> bool + Send>,
        ) -> Option<Self> {
            let context = WhisperContext::new_with_params(
                model.to_str()?,
                WhisperContextParameters::default(),
            )
            .ok()?;
            let state = context.create_state().ok()?;
            // A quarter of the cores, 2 to 4: measured on a 20-core machine,
            // 4 threads use ~25 % less CPU in all than 8 (whisper scales
            // sublinearly) and leave room for playback, for ~3 s more a song.
            // A phone has 6 to 8 cores and nothing else to do meanwhile: half.
            let share = if cfg!(any(target_os = "android", target_os = "ios")) {
                2
            } else {
                4
            };
            let threads = std::thread::available_parallelism()
                .map(|n| (n.get() / share).clamp(2, 4))
                .unwrap_or(2) as i32;
            Some(Self {
                state,
                _context: context,
                language: "es",
                threads,
                cancelled,
            })
        }
    }

    fn params(threads: i32, language: &'static str) -> FullParams<'static, 'static> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(language));
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        params.set_single_segment(true);
        params.set_no_context(true);
        params.set_n_threads(threads);
        // No timestamps and no retries at a higher temperature: an
        // announcement is a few words, and the retries only cost time (same
        // transcripts on the validation guides, with or without them).
        params.set_no_timestamps(true);
        params.set_temperature_inc(0.0);
        // A few words: a runaway repetition ("Bridge, Bridge, …") stops here
        // instead of costing seconds.
        params.set_max_tokens(MAX_TOKENS);
        params
    }

    /// Encoder window for an announcement, in 20 ms frames: 15 s instead of
    /// whisper's 30 s halves the time per announcement (Digno es el Señor
    /// 19.9 → 9.3 s, same labels on the three validation guides). 10 s
    /// started to fail ("Deguitara", "Bridge, Bridge, …"). Always the same
    /// size: a size that changes per call rebuilds whisper's graph each time
    /// and was slower than the full window.
    const ANNOUNCEMENT_AUDIO_CTX: i32 = 750;
    /// Longer speech than this keeps the full window.
    const ANNOUNCEMENT_CTX_MAX_SECONDS: f64 = 14.0;
    const MAX_TOKENS: i32 = 48;
    /// Whisper's input rate (the analysis hands it 16 kHz mono).
    const WHISPER_RATE: f64 = 16_000.0;

    impl Transcriber for WhisperTranscriber {
        fn detect_language(&mut self, speech: &[f32]) {
            if speech.is_empty() || (self.cancelled)() {
                return;
            }
            let mut params = params(self.threads, "auto");
            params.set_detect_language(true);
            if self.state.full(params, speech).is_err() {
                return;
            }
            let detected =
                whisper_rs::get_lang_str(self.state.full_lang_id_from_state()).unwrap_or("es");
            // Only Spanish and English have a vocabulary. A lone Spanish word
            // is often taken for Portuguese, Italian or Galician.
            self.language = match detected {
                "en" => "en",
                _ => "es",
            };
        }

        fn transcribe(&mut self, speech: &[f32]) -> Option<String> {
            if speech.is_empty() || (self.cancelled)() {
                return None;
            }
            let language = self.language;
            let mut params = params(self.threads, language);
            if speech.len() as f64 <= ANNOUNCEMENT_CTX_MAX_SECONDS * WHISPER_RATE {
                params.set_audio_ctx(ANNOUNCEMENT_AUDIO_CTX);
            }
            params.set_initial_prompt(if language == "en" {
                PROMPT_EN
            } else {
                PROMPT_ES
            });
            self.state.full(params, speech).ok()?;
            let text: String = self
                .state
                .as_iter()
                .map(|segment| segment.to_string())
                .collect();
            let text = text.trim().to_string();
            (!text.is_empty()).then_some(text)
        }
    }
}
