use std::{
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::Duration,
};

use libretracks_audio::ActiveClip;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};

use crate::state::DesktopError;

pub struct AudioRuntime {
    _stream: OutputStream,
    handle: OutputStreamHandle,
    sinks: Vec<Sink>,
}

pub struct AudioController {
    sender: Sender<AudioCommand>,
}

enum AudioCommand {
    Play {
        song_dir: PathBuf,
        active_clips: Vec<ActiveClip>,
        respond_to: Sender<Result<(), String>>,
    },
    Stop {
        respond_to: Sender<Result<(), String>>,
    },
    Shutdown,
}

impl AudioRuntime {
    pub fn new() -> Result<Self, DesktopError> {
        let (stream, handle) = OutputStream::try_default()?;

        Ok(Self {
            _stream: stream,
            handle,
            sinks: Vec::new(),
        })
    }

    pub fn stop_all(&mut self) {
        for sink in self.sinks.drain(..) {
            sink.stop();
        }
    }

    pub fn restart(
        &mut self,
        song_dir: &Path,
        active_clips: &[ActiveClip],
    ) -> Result<(), DesktopError> {
        self.stop_all();

        for clip in active_clips {
            let file = File::open(song_dir.join(&clip.file_path))?;
            let decoder = Decoder::new(BufReader::new(file))?;
            let source = decoder
                .skip_duration(Duration::from_secs_f64(clip.timeline_offset_seconds))
                .amplify(clip.gain as f32);

            let sink = Sink::try_new(&self.handle)?;
            sink.pause();
            sink.append(source);
            self.sinks.push(sink);
        }

        for sink in &self.sinks {
            sink.play();
        }

        Ok(())
    }
}

impl AudioController {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();

        thread::Builder::new()
            .name("libretracks-audio".into())
            .spawn(move || run_audio_thread(receiver))
            .expect("audio thread should start");

        Self { sender }
    }

    pub fn play(&self, song_dir: PathBuf, active_clips: Vec<ActiveClip>) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::Play {
            song_dir,
            active_clips,
            respond_to,
        })
    }

    pub fn stop(&self) -> Result<(), DesktopError> {
        self.request(|respond_to| AudioCommand::Stop { respond_to })
    }

    fn request(
        &self,
        command: impl FnOnce(Sender<Result<(), String>>) -> AudioCommand,
    ) -> Result<(), DesktopError> {
        let (respond_to, response) = mpsc::channel();

        self.sender
            .send(command(respond_to))
            .map_err(|_| DesktopError::AudioThreadUnavailable)?;

        response
            .recv()
            .map_err(|_| DesktopError::AudioThreadUnavailable)?
            .map_err(DesktopError::AudioCommand)
    }
}

impl Default for AudioController {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AudioController {
    fn drop(&mut self) {
        let _ = self.sender.send(AudioCommand::Shutdown);
    }
}

fn run_audio_thread(receiver: Receiver<AudioCommand>) {
    let mut runtime: Option<AudioRuntime> = None;

    while let Ok(command) = receiver.recv() {
        match command {
            AudioCommand::Play {
                song_dir,
                active_clips,
                respond_to,
            } => {
                let result = ensure_runtime(&mut runtime)
                    .and_then(|runtime| runtime.restart(&song_dir, &active_clips))
                    .map_err(|error| error.to_string());

                let _ = respond_to.send(result);
            }
            AudioCommand::Stop { respond_to } => {
                if let Some(runtime) = runtime.as_mut() {
                    runtime.stop_all();
                }

                let _ = respond_to.send(Ok(()));
            }
            AudioCommand::Shutdown => break,
        }
    }
}

fn ensure_runtime(runtime: &mut Option<AudioRuntime>) -> Result<&mut AudioRuntime, DesktopError> {
    if runtime.is_none() {
        *runtime = Some(AudioRuntime::new()?);
    }

    Ok(runtime.as_mut().expect("runtime should exist"))
}
