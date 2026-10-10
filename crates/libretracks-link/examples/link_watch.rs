//! Manual diagnosis of a running host's timing: joins as a viewer and prints
//! when each message arrives (transport pushes, song pushes, relayed events),
//! flags gaps in the transport stream, and times a song-view read every
//! second, as a mirror-mode guest does after a change.
//! `cargo run -p libretracks-link --example link_watch -- 192.168.1.30:3040 [pin] [seconds]`

use std::time::{Duration, Instant};

use libretracks_link::{join, GuestConfig, GuestEvent, GuestState, LinkCommand};
use serde_json::{json, Value};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let address = args.next().unwrap_or_else(|| "127.0.0.1:3040".into());
    let pin = args.next().filter(|pin| !pin.is_empty() && pin != "-");
    let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(120);

    let mut runtime = join(GuestConfig {
        device_name: "link-watch".into(),
        platform: "windows".into(),
        app_version: "probe".into(),
        pin,
        ..GuestConfig::new(format!("ws://{address}"), "link-watch")
    })
    .expect("runtime");

    let started = Instant::now();
    let t = move || started.elapsed().as_secs_f64();
    let handle = runtime.handle.clone();

    // A song-view read every second, timed: this is what blocks behind the
    // host's session lock.
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let sent = Instant::now();
            let result = handle
                .send_command(
                    LinkCommand::Invoke {
                        command: "get_song_view".into(),
                        args: json!({ "includeWaveforms": false }),
                    },
                    None,
                )
                .await;
            let ms = sent.elapsed().as_millis();
            if ms > 150 || result.is_err() {
                println!(
                    "{:8.3}  READ get_song_view {ms} ms {}",
                    t(),
                    if result.is_err() { "ERR" } else { "" }
                );
            }
        }
    });

    let deadline = tokio::time::sleep(Duration::from_secs(seconds));
    tokio::pin!(deadline);
    let mut last_transport: Option<f64> = None;
    let mut last_line = String::new();
    loop {
        let event = tokio::select! {
            _ = &mut deadline => break,
            event = runtime.events.recv() => match event { Some(e) => e, None => break },
        };
        let now = t();
        match event {
            GuestEvent::State(state) => {
                println!("{now:8.3}  STATE {state:?}");
                if let GuestState::Rejected { .. } = state {
                    return;
                }
            }
            GuestEvent::Welcome { host_name, grants, .. } => {
                println!("{now:8.3}  WELCOME {host_name} {grants:?}")
            }
            GuestEvent::Transport { snapshot, .. } => {
                if let Some(previous) = last_transport {
                    if now - previous > 0.3 {
                        println!("{now:8.3}  GAP transport silent {:.0} ms", (now - previous) * 1000.0);
                    }
                }
                last_transport = Some(now);
                let line = summary(&snapshot);
                if line != last_line {
                    println!("{now:8.3}  TRANSPORT {line}");
                    last_line = line;
                }
            }
            GuestEvent::Song(song) => {
                let size = song.to_string().len();
                println!("{now:8.3}  SONG push {} KB", size / 1024);
            }
            GuestEvent::LiveSettings(_) => println!("{now:8.3}  LIVE-SETTINGS"),
            GuestEvent::Event { name, payload, .. } => {
                if !name.contains("meters") {
                    let text = payload.to_string();
                    let cut: String = text.chars().take(120).collect();
                    println!("{now:8.3}  EVENT {name} {cut}");
                }
            }
            other => println!("{now:8.3}  {other:?}"),
        }
    }
}

/// The fields that matter for this diagnosis; position left out (it always
/// moves) so only real changes print.
fn summary(s: &Value) -> String {
    format!(
        "{} rev={} mix={} rate={} pitchPrep={}/{}",
        s["playbackState"].as_str().unwrap_or("?"),
        s["projectRevision"],
        s["mixRevision"],
        s["transportClock"]["playbackRate"],
        s["pitch"]["pitchPrepareActive"],
        s["pitch"]["pitchPreparePending"],
    )
}
