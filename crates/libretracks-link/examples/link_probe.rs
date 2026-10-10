//! Manual diagnosis of a running host: joins as a viewer and runs a few
//! mirror-mode reads, printing a summary of each answer.
//! `cargo run -p libretracks-link --example link_probe -- 127.0.0.1:3040`

use std::time::Duration;

use libretracks_link::{join, GuestConfig, GuestEvent, GuestState, LinkCommand};
use serde_json::json;

#[tokio::main]
async fn main() {
    let address = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "127.0.0.1:3040".into());
    let mut runtime = join(GuestConfig {
        device_name: "probe".into(),
        platform: "windows".into(),
        app_version: "probe".into(),
        ..GuestConfig::new(format!("ws://{address}"), "link-probe")
    })
    .expect("runtime");

    let connected = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = runtime.events.recv().await {
            match event {
                GuestEvent::State(GuestState::Connected) => return true,
                GuestEvent::State(GuestState::Rejected { reason, .. }) => {
                    println!("rejected: {reason:?}");
                    return false;
                }
                _ => {}
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    if !connected {
        println!("not connected");
        return;
    }
    println!("connected");

    for (command, args) in [
        ("get_transport_snapshot", json!({})),
        ("get_song_view", json!({ "includeWaveforms": false })),
        ("get_song_view", json!({ "includeWaveforms": true })),
        ("get_song_view", json!({})),
        ("get_settings", json!({})),
    ] {
        let result = runtime
            .handle
            .send_command(
                LinkCommand::Invoke {
                    command: command.into(),
                    args,
                },
                None,
            )
            .await;
        match result {
            Ok(value) => {
                let text = value.to_string();
                let regions = value
                    .get("regions")
                    .and_then(|r| r.as_array())
                    .map(|r| r.len());
                println!(
                    "{command}: ok, {} bytes, regions={regions:?}, head={}",
                    text.len(),
                    &text[..text.len().min(160)]
                );
            }
            Err(error) => println!("{command}: ERROR {error:?}"),
        }
    }
    runtime.handle.leave();
    tokio::time::sleep(Duration::from_millis(200)).await;
}
