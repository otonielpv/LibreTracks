//! Plan lyrics-sync, paso 06: el worker de envío sin escritorio, contra el
//! servidor falso (FreeShow, con la canción de prueba de las fixtures).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use libretracks_core::lyrics_schedule::LyricsEvent;
use libretracks_core::{
    LyricsLink, LyricsSoftware, Marker, MarkerKind, RegionLyrics, Song, SongMaster, SongRegion,
};
use libretracks_lyrics::clients::Connection;
use libretracks_lyrics::worker::{
    coalesce, ConnectionState, LyricsStatus, LyricsWorker, WorkerConfig, WorkerHost, WorkerInput,
};
use libretracks_test_http::{serve, Response};
use serde_json::Value;

fn fixture(path: &str) -> String {
    let full = format!("{}/tests/fixtures/{path}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&full).expect(&full)
}

#[derive(Default)]
struct Recorder {
    statuses: Mutex<Vec<LyricsStatus>>,
    links: Mutex<Vec<(String, LyricsLink)>>,
    counts: Mutex<HashMap<String, u32>>,
}

impl WorkerHost for Recorder {
    fn status(&self, status: &LyricsStatus) {
        self.statuses.lock().unwrap().push(status.clone());
    }
    fn link_resolved(&self, region_id: &str, link: LyricsLink) {
        self.links.lock().unwrap().push((region_id.to_string(), link));
    }
    fn slide_counts(&self, counts: HashMap<String, u32>) {
        *self.counts.lock().unwrap() = counts;
    }
}

fn marker(id: &str, kind: MarkerKind, variant: Option<u8>, start: f64) -> Marker {
    Marker {
        id: id.into(),
        name: id.into(),
        start_seconds: start,
        digit: None,
        kind,
        variant,
        color: None,
        category_override: None,
    }
}

fn song(link: Option<LyricsLink>) -> Song {
    Song {
        id: "s".into(),
        title: "S".into(),
        artist: None,
        key: None,
        bpm: 120.0,
        time_signature: "4/4".into(),
        duration_seconds: 64.0,
        tempo_markers: vec![],
        time_signature_markers: vec![],
        regions: vec![SongRegion {
            drum_loop: None,
            lyrics: Some(RegionLyrics {
                links: link.into_iter().collect(),
                ..RegionLyrics::default()
            }),
            key_changes: Vec::new(),
            id: "r1".into(),
            name: "Way Maker".into(),
            start_seconds: 0.0,
            end_seconds: 64.0,
            transpose_semitones: 0,
            key: None,
            warp_enabled: false,
            warp_source_bpm: None,
            master: SongMaster::default(),
            compact_column_width_rem: None,
            chart: None,
            cover_image: None,
            voice_guide_count_style: None,
            structure: None,
        }],
        tracks: vec![],
        clips: vec![],
        midi_clips: vec![],
        video_clips: vec![],
        section_markers: vec![
            marker("intro", MarkerKind::Intro, None, 0.0),
            marker("v1", MarkerKind::Verse, Some(1), 4.0),
            marker("c", MarkerKind::Chorus, None, 20.0),
            marker("v2", MarkerKind::Verse, Some(2), 28.0),
            marker("c~1", MarkerKind::Chorus, None, 36.0),
        ],
    }
}

type Sent = Arc<Mutex<Vec<Value>>>;

/// A FreeShow that records every action; `slow` actions answer after 2 s.
async fn freeshow(shows: &'static str, slow: Arc<Mutex<bool>>) -> (Connection, Sent) {
    let sent: Sent = Arc::default();
    let log = Arc::clone(&sent);
    let base = serve(move |request, _| {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let action = body["action"].as_str().unwrap_or_default().to_string();
        log.lock().unwrap().push(body.clone());
        match action.as_str() {
            "get_shows" => Response::json(200, shows),
            // FreeShow answers no data for an id it does not have.
            "get_show" | "get_show_layout" if body["id"] != "show-waymaker" => {
                Response::json(200, r#"{"data":null}"#)
            }
            "get_show" => Response::json(200, fixture("freeshow/get_show.json")),
            "get_show_layout" => Response::json(200, fixture("freeshow/get_show_layout.json")),
            _ if *slow.lock().unwrap() => Response::delayed(204, "", Duration::from_secs(2)),
            _ => Response::json(204, ""),
        }
    })
    .await;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    (
        Connection {
            host: "127.0.0.1".into(),
            port,
            token: None,
        },
        sent,
    )
}

fn config(connection: Connection) -> WorkerConfig {
    WorkerConfig {
        software: LyricsSoftware::FreeShow,
        connection,
        clear_on_song_end: true,
        clear_on_stop: false,
    }
}

fn section(marker: &str) -> WorkerInput {
    WorkerInput::Event(LyricsEvent::Section {
        region_id: "r1".into(),
        marker_id: marker.into(),
        occurrence: 0,
    })
}

fn step(marker: &str, k: u32) -> WorkerInput {
    WorkerInput::Event(LyricsEvent::Step {
        region_id: "r1".into(),
        marker_id: marker.into(),
        k,
    })
}

fn slide_orders(sent: &Sent) -> Vec<u64> {
    sent.lock()
        .unwrap()
        .iter()
        .filter(|body| body["action"] == "index_select_slide")
        .map(|body| body["index"].as_u64().unwrap())
        .collect()
}

const SHOWS: &str = r#"{"data":{"show-waymaker":{"name":"Way Maker"},"show-oceans":{"name":"Oceans"}}}"#;

async fn ready_worker(connection: Connection) -> (LyricsWorker, Arc<Recorder>) {
    let host = Arc::new(Recorder::default());
    let mut worker = LyricsWorker::new(host.clone());
    worker
        .handle(vec![
            WorkerInput::Configure(Some(config(connection))),
            WorkerInput::Song(Arc::new(song(None))),
        ])
        .await;
    worker.ensure_plan("r1").await.unwrap().expect("plan");
    (worker, host)
}

#[tokio::test]
async fn three_queued_sections_send_only_the_last_and_old_steps_are_dropped() {
    let (connection, sent) = freeshow(SHOWS, Arc::default()).await;
    let (mut worker, _) = ready_worker(connection).await;
    sent.lock().unwrap().clear();
    worker
        .handle(vec![section("intro"), section("v1"), step("v1", 1), section("c")])
        .await;
    assert_eq!(slide_orders(&sent), vec![4], "only the chorus (layout index 4)");

    // A step of the verse while the chorus is on screen: dropped.
    sent.lock().unwrap().clear();
    worker.handle(vec![step("v1", 1)]).await;
    assert!(slide_orders(&sent).is_empty());
    worker.handle(vec![step("c", 1)]).await;
    assert_eq!(slide_orders(&sent), vec![5]);
}

#[test]
fn coalescing_keeps_settings_and_the_last_anchor() {
    let batch = vec![
        section("intro"),
        WorkerInput::Paused(false),
        step("intro", 1),
        section("v1"),
        step("v1", 1),
    ];
    let kept = coalesce(batch);
    assert_eq!(kept.len(), 3);
    assert!(matches!(kept[0], WorkerInput::Paused(false)));
    assert!(matches!(&kept[1], WorkerInput::Event(LyricsEvent::Section { marker_id, .. }) if marker_id == "v1"));
}

#[tokio::test]
async fn a_hanging_program_is_abandoned_at_800_ms_and_the_next_order_goes_normally() {
    let slow = Arc::new(Mutex::new(false));
    let (connection, sent) = freeshow(SHOWS, Arc::clone(&slow)).await;
    let (mut worker, host) = ready_worker(connection).await;
    *slow.lock().unwrap() = true;
    let started = Instant::now();
    worker.handle(vec![section("v1")]).await;
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_millis(1000), "{elapsed:?}");
    assert_eq!(worker.status().connection, ConnectionState::Unreachable);
    assert!(host
        .statuses
        .lock()
        .unwrap()
        .iter()
        .any(|status| status.connection == ConnectionState::Unreachable));

    *slow.lock().unwrap() = false;
    sent.lock().unwrap().clear();
    worker.handle(vec![section("c")]).await;
    assert_eq!(slide_orders(&sent), vec![4], "not retried: only the new order");
    assert_eq!(worker.status().connection, ConnectionState::Ok);
    assert_eq!(worker.status().last_sent.as_ref().unwrap().marker_id.as_deref(), Some("c"));
}

#[tokio::test]
async fn a_stale_id_is_relinked_by_unique_name_and_an_ambiguous_one_stays_unlinked() {
    let (connection, _) = freeshow(SHOWS, Arc::default()).await;
    let host = Arc::new(Recorder::default());
    let mut worker = LyricsWorker::new(host.clone());
    let stale = LyricsLink {
        software: LyricsSoftware::FreeShow,
        presentation_id: Some("id-from-another-church".into()),
        presentation_name: "Way Maker".into(),
        overrides: vec![],
        slides: vec![],
        start: None,
    };
    worker
        .handle(vec![
            WorkerInput::Configure(Some(config(connection))),
            WorkerInput::Song(Arc::new(song(Some(stale)))),
        ])
        .await;
    let plan = worker.ensure_plan("r1").await.unwrap().expect("resolved by name");
    assert_eq!(plan.presentation_id, "show-waymaker");
    let links = host.links.lock().unwrap().clone();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].1.presentation_id.as_deref(), Some("show-waymaker"));
    assert_eq!(host.counts.lock().unwrap().get("v1"), Some(&2));

    const TWINS: &str =
        r#"{"data":{"a":{"name":"Way Maker"},"b":{"name":"Way Maker (Live)"}}}"#;
    let (connection, _) = freeshow(TWINS, Arc::default()).await;
    let host = Arc::new(Recorder::default());
    let mut worker = LyricsWorker::new(host.clone());
    worker
        .handle(vec![
            WorkerInput::Configure(Some(config(connection))),
            WorkerInput::Song(Arc::new(song(None))),
        ])
        .await;
    assert_eq!(worker.ensure_plan("r1").await.unwrap(), None);
    assert!(host.links.lock().unwrap().is_empty());
    // Counted as an unlinked song in the status.
    worker.handle(vec![WorkerInput::Paused(false)]).await;
    let last = host.statuses.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.unlinked_songs, 1);
}

#[tokio::test]
async fn leaving_the_song_clears_only_when_something_of_ours_is_on_screen() {
    let (connection, sent) = freeshow(SHOWS, Arc::default()).await;
    let (mut worker, _) = ready_worker(connection).await;
    sent.lock().unwrap().clear();
    worker.handle(vec![WorkerInput::Outside]).await;
    assert!(sent.lock().unwrap().is_empty());
    worker.handle(vec![section("v1")]).await;
    worker
        .handle(vec![WorkerInput::Event(LyricsEvent::ExitSong {
            region_id: "r1".into(),
        })])
        .await;
    assert!(sent
        .lock()
        .unwrap()
        .iter()
        .any(|body| body["action"] == "clear_slide"));
}

#[tokio::test]
async fn turning_it_on_checks_the_program_even_without_a_session() {
    let (connection, _) = freeshow(SHOWS, Arc::default()).await;
    let host = Arc::new(Recorder::default());
    let mut worker = LyricsWorker::new(host.clone());
    worker
        .handle(vec![WorkerInput::Configure(Some(config(connection)))])
        .await;
    assert_eq!(worker.status().connection, ConnectionState::Ok);

    // Nothing listening there: unreachable, not stuck on "connecting".
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut worker = LyricsWorker::new(Arc::new(Recorder::default()));
    worker
        .handle(vec![WorkerInput::Configure(Some(config(Connection {
            host: "127.0.0.1".into(),
            port,
            token: None,
        })))])
        .await;
    assert_eq!(worker.status().connection, ConnectionState::Unreachable);
}

#[tokio::test]
async fn while_recording_a_song_its_slide_changes_are_not_sent_by_playback() {
    let (connection, sent) = freeshow(SHOWS, Arc::default()).await;
    let (mut worker, _) = ready_worker(connection).await;
    worker.handle(vec![section("v1")]).await;
    worker
        .handle(vec![WorkerInput::Recording(Some("r1".into()))])
        .await;
    sent.lock().unwrap().clear();
    worker.handle(vec![step("v1", 1)]).await;
    assert!(slide_orders(&sent).is_empty(), "playback steps held back");
    // The recorder's own taps still go out.
    worker
        .handle(vec![WorkerInput::TestSend {
            region_id: "r1".into(),
            marker_id: "v1".into(),
            k: 1,
        }])
        .await;
    assert_eq!(slide_orders(&sent), vec![2, 3]);
    worker.handle(vec![WorkerInput::Recording(None)]).await;
    sent.lock().unwrap().clear();
    worker.handle(vec![step("v1", 1)]).await;
    assert_eq!(slide_orders(&sent), vec![3]);
}

#[tokio::test]
async fn a_song_starting_before_its_first_section_blanks_what_the_last_song_left() {
    let (connection, sent) = freeshow(SHOWS, Arc::default()).await;
    let (mut worker, _) = ready_worker(connection).await;
    worker.handle(vec![section("v1")]).await;
    sent.lock().unwrap().clear();
    // The fixture opens on "Intro" (no title slide): automatic start = blank.
    worker
        .handle(vec![WorkerInput::Event(LyricsEvent::EnterSong {
            region_id: "r1".into(),
            show_start: true,
        })])
        .await;
    assert!(sent
        .lock()
        .unwrap()
        .iter()
        .any(|body| body["action"] == "clear_slide"));
}
