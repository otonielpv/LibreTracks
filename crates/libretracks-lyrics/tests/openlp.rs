//! OpenLP (issue #9): what the client sends over the network, against a fake
//! OpenLP 3 on `libretracks-test-http`.

use std::sync::{Arc, Mutex};

use libretracks_core::LyricsSoftware;
use libretracks_lyrics::clients::{client_for, Connection, LyricsClient};
use libretracks_lyrics::plan::LyricsCommand;
use libretracks_lyrics::LyricsError;
use libretracks_test_http::{serve, Request, Response};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    target: String,
    authorization: Option<String>,
    body: String,
}

type Log = Arc<Mutex<Vec<Seen>>>;

async fn server<H>(handler: H) -> (Connection, Log)
where
    H: Fn(&Request) -> Option<Response> + Send + Sync + 'static,
{
    let log: Log = Arc::default();
    let seen = Arc::clone(&log);
    let base = serve(move |request, _| {
        seen.lock().unwrap().push(Seen {
            method: request.method.clone(),
            target: request.target.clone(),
            authorization: request.headers.get("authorization").cloned(),
            body: String::from_utf8_lossy(&request.body).into_owned(),
        });
        handler(&request)
    })
    .await;
    let port = base.rsplit(':').next().unwrap().parse().unwrap();
    (
        Connection {
            host: "127.0.0.1".into(),
            port,
            token: None,
        },
        log,
    )
}

fn client(connection: Connection) -> Box<dyn LyricsClient> {
    client_for(LyricsSoftware::OpenLp, connection).unwrap()
}

/// What `controller/live-items` answers for each service item.
fn live_item(id: &str) -> String {
    match id {
        "U-WAY" => r#"{"id":"U-WAY","title":"Way Maker","name":"songs","slides":[
            {"tag":"V1","text":"You are here\nmoving in our midst","selected":false},
            {"tag":"C1","text":"Way maker","selected":true},
            {"tag":"C1","text":"Miracle worker","selected":false},
            {"tag":"V2","text":"You are here\ntouching every heart","selected":false},
            {"tag":"C1","text":"Way maker","selected":false},
            {"tag":"C1","text":"Miracle worker","selected":false}]}"#
            .into(),
        "U-GRACE" => r#"{"id":"U-GRACE","title":"Amazing Grace","name":"songs","slides":[
            {"tag":"V1","text":"Amazing grace","selected":true},
            {"tag":"O1","text":"Amen","selected":false}]}"#
            .into(),
        _ => "{}".into(),
    }
}

/// A fake OpenLP 3: a service with two songs and a picture, the live item
/// following `service/show`, and the websocket port pointing at nothing (so
/// the screen's state is unknown) unless a state socket is given.
async fn openlp(live: Option<&str>) -> (Connection, Log, Arc<Mutex<Option<String>>>) {
    openlp_with_socket(live, 1).await
}

async fn openlp_with_socket(
    live: Option<&str>,
    websocket_port: u16,
) -> (Connection, Log, Arc<Mutex<Option<String>>>) {
    let state = Arc::new(Mutex::new(live.map(str::to_string)));
    let shared = Arc::clone(&state);
    let (connection, log) = server(move |request| {
        let path = request.target.trim_start_matches("/api/v2/");
        match path {
            "core/system" => Response::json(
                200,
                format!(
                    r#"{{"websocket_port":{websocket_port},"login_required":false,"api_version":2,"api_revision":7}}"#
                ),
            ),
            "service/items" => Response::json(
                200,
                r#"[{"id":"U-WAY","title":"Way Maker","plugin":"songs","selected":false,"is_valid":true},
                    {"id":"U-GRACE","title":"Amazing Grace","plugin":"songs","selected":false,"is_valid":true},
                    {"id":"U-PIC","title":"Welcome","plugin":"images","selected":false,"is_valid":true}]"#,
            ),
            "controller/live-items" => {
                let live = shared.lock().unwrap().clone().unwrap_or_default();
                Response::json(200, live_item(&live))
            }
            "service/show" => {
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                *shared.lock().unwrap() = body["id"].as_str().map(str::to_string);
                Response::json(204, "")
            }
            "controller/clear/live" => {
                *shared.lock().unwrap() = None;
                Response::json(204, "")
            }
            _ => Response::json(204, ""),
        }
    })
    .await;
    (connection, log, state)
}

/// The orders (POSTs) sent, path under `/api/v2/` and JSON body.
fn sent(log: &Log) -> Vec<(String, Value)> {
    log.lock()
        .unwrap()
        .iter()
        .filter(|request| request.method == "POST")
        .map(|request| {
            (
                request.target.trim_start_matches("/api/v2/").to_string(),
                serde_json::from_str(&request.body).unwrap_or(Value::Null),
            )
        })
        .collect()
}

fn paths(log: &Log) -> Vec<String> {
    sent(log).into_iter().map(|(path, _)| path).collect()
}

#[tokio::test]
async fn lists_the_service_songs_and_reads_the_live_one() {
    let (connection, _log, _) = openlp(Some("U-WAY")).await;
    let openlp = client(connection);
    let probe = openlp.probe().await.unwrap();
    assert_eq!(probe.version, "OpenLP (API 2.7)");
    // The picture has no lyrics.
    assert_eq!(probe.presentations, 2);

    let structure = openlp.structure("U-WAY").await.unwrap();
    assert_eq!(structure.title, "Way Maker");
    let entries: Vec<(&str, u32, u32)> = structure
        .entries
        .iter()
        .map(|entry| (entry.group_label.as_str(), entry.first_index, entry.slide_count))
        .collect();
    // Verse order expanded, 0-based; a verse split in two is one section.
    assert_eq!(entries, vec![("V1", 0, 1), ("C1", 1, 2), ("V2", 3, 1), ("C1", 4, 2)]);
    assert_eq!(structure.slides[0].text, "You are here\nmoving in our midst");
    assert!(structure.entries[0].canonical.is_some());

    let current = openlp.current().await.unwrap().unwrap();
    assert_eq!(current.presentation_id.as_deref(), Some("U-WAY"));
    assert_eq!(current.label.as_deref(), Some("C1"));
    assert_eq!(current.index, Some(1));

    assert!(matches!(
        openlp.structure("U-GONE").await,
        Err(LyricsError::NotFound { .. })
    ));
}

#[tokio::test]
async fn borrows_a_free_screen_to_read_a_song_and_puts_it_back() {
    // Nothing live: the song goes live behind a text-less screen and is
    // cleared again.
    let (connection, log, state) = openlp(None).await;
    let openlp = client(connection);
    let structure = openlp.structure("U-GRACE").await.unwrap();
    assert_eq!(structure.entries.len(), 2);
    // "O" is OpenLP's "Other", not an outro.
    assert_eq!(structure.entries[1].canonical, None);
    assert_eq!(*state.lock().unwrap(), None);
    assert_eq!(
        sent(&log),
        vec![
            // Nothing live: black while the song is read.
            ("core/display".to_string(), json!({"display": "blank"})),
            ("service/show".to_string(), json!({"id": "U-GRACE"})),
            ("controller/clear/live".to_string(), json!({})),
            // Nothing was live: the screen shows (nothing) again.
            ("core/display".to_string(), json!({"display": "show"})),
        ]
    );

    // Read once, kept: the screen is not borrowed again for it.
    log.lock().unwrap().clear();
    openlp.structure("U-GRACE").await.unwrap();
    assert!(sent(&log).is_empty());
}

/// A WebSocket that answers OpenLP's state once per connection.
async fn state_socket(results: Value) -> u16 {
    use futures_util::SinkExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let message = json!({ "results": results }).to_string();
            tokio::spawn(async move {
                if let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await {
                    let _ = socket
                        .send(tokio_tungstenite::tungstenite::Message::Text(message))
                        .await;
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn puts_back_the_item_and_slide_that_were_live_on_a_blank_screen() {
    let ws = state_socket(json!({"item": "U-WAY", "slide": 1, "blank": true, "theme": false, "display": false})).await;
    let (connection, log, state) = openlp_with_socket(Some("U-WAY"), ws).await;
    let openlp = client(connection);
    openlp.structure("U-GRACE").await.unwrap();
    assert_eq!(state.lock().unwrap().as_deref(), Some("U-WAY"));
    assert_eq!(
        sent(&log),
        vec![
            // The black screen is never touched.
            ("service/show".to_string(), json!({"id": "U-GRACE"})),
            ("service/show".to_string(), json!({"id": "U-WAY"})),
            ("controller/show".to_string(), json!({"id": 1})),
        ]
    );
}

#[tokio::test]
async fn a_screen_showing_text_is_not_borrowed() {
    let ws = state_socket(json!({"item": "U-WAY", "slide": 1, "blank": false, "theme": false, "display": false})).await;
    let (connection, log, _) = openlp_with_socket(Some("U-WAY"), ws).await;
    assert!(matches!(
        client(connection).structure("U-GRACE").await,
        Err(LyricsError::Busy { .. })
    ));
    assert!(sent(&log).is_empty());
}

#[tokio::test]
async fn does_not_take_a_screen_showing_other_lyrics_until_the_song_starts() {
    let (connection, log, state) = openlp(Some("U-WAY")).await;
    let openlp = client(connection);
    // Another song is live and the screen's state cannot be read.
    assert!(matches!(
        openlp.structure("U-GRACE").await,
        Err(LyricsError::Busy { .. })
    ));
    assert!(sent(&log).is_empty());
    assert_eq!(state.lock().unwrap().as_deref(), Some("U-WAY"));

    // The song starts: it takes the screen and stays live, text hidden.
    openlp.set_may_take_screen(true);
    let structure = openlp.structure("U-GRACE").await.unwrap();
    openlp.set_may_take_screen(false);
    assert_eq!(structure.presentation_id, "U-GRACE");
    assert_eq!(state.lock().unwrap().as_deref(), Some("U-GRACE"));
    assert_eq!(paths(&log), vec!["core/display", "service/show"]);

    // Prepare then finds it already live: nothing to send.
    log.lock().unwrap().clear();
    openlp
        .send(&LyricsCommand::Prepare {
            presentation_id: "U-GRACE".into(),
        })
        .await
        .unwrap();
    assert!(sent(&log).is_empty());
}

fn section(index: u32) -> LyricsCommand {
    LyricsCommand::Section {
        presentation_id: "U-GRACE".into(),
        group_label: "V1".into(),
        index,
    }
}

/// Past the wait for the slide's transition (800 ms).
async fn after_transition() {
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
}

#[tokio::test]
async fn from_black_the_slide_changes_first_and_the_black_goes_after_its_transition() {
    let (connection, log, state) = openlp(Some("U-WAY")).await;
    let openlp = client(connection);
    openlp
        .send(&LyricsCommand::Prepare {
            presentation_id: "U-GRACE".into(),
        })
        .await
        .unwrap();
    assert_eq!(state.lock().unwrap().as_deref(), Some("U-GRACE"));
    openlp.send(&section(0)).await.unwrap();
    // Unknown screen: black before going live. The slide is changed under
    // it; the screen is not shown yet, and the order returns without
    // waiting for it.
    assert_eq!(
        sent(&log),
        vec![
            ("core/display".to_string(), json!({"display": "blank"})),
            ("service/show".to_string(), json!({"id": "U-GRACE"})),
            ("controller/show".to_string(), json!({"id": 0})),
        ]
    );
    after_transition().await;
    assert_eq!(sent(&log).last().unwrap(), &("core/display".to_string(), json!({"display": "show"})));

    // With the text up, slides change with nothing else.
    log.lock().unwrap().clear();
    openlp.send(&section(1)).await.unwrap();
    openlp
        .send(&LyricsCommand::Step {
            presentation_id: "U-GRACE".into(),
            index: None,
        })
        .await
        .unwrap();
    after_transition().await;
    assert_eq!(
        sent(&log),
        vec![
            ("controller/show".to_string(), json!({"id": 1})),
            ("controller/progress".to_string(), json!({"action": "next"})),
        ]
    );

    // Text cleared, then a slide: shown again after the transition.
    log.lock().unwrap().clear();
    openlp.send(&LyricsCommand::ClearText).await.unwrap();
    openlp
        .send(&LyricsCommand::Slide {
            presentation_id: "U-GRACE".into(),
            index: 1,
        })
        .await
        .unwrap();
    after_transition().await;
    openlp.send(&LyricsCommand::Clear).await.unwrap();
    assert_eq!(
        sent(&log),
        vec![
            ("core/display".to_string(), json!({"display": "theme"})),
            ("controller/show".to_string(), json!({"id": 1})),
            ("core/display".to_string(), json!({"display": "show"})),
            ("core/display".to_string(), json!({"display": "blank"})),
        ]
    );
}

#[tokio::test]
async fn hiding_the_text_while_waiting_cancels_the_pending_unblank() {
    let (connection, log, _) = openlp(Some("U-GRACE")).await;
    let openlp = client(connection);
    openlp.send(&LyricsCommand::Clear).await.unwrap();
    openlp.send(&section(0)).await.unwrap();
    // Stopped before the transition ended: the screen stays black.
    openlp.send(&LyricsCommand::Clear).await.unwrap();
    after_transition().await;
    assert!(
        !sent(&log).contains(&("core/display".to_string(), json!({"display": "show"}))),
        "{:?}",
        sent(&log)
    );
}

#[tokio::test]
async fn a_black_screen_stays_black_when_the_next_song_is_prepared() {
    let (connection, log, state) = openlp(Some("U-WAY")).await;
    let openlp = client(connection);
    // Song end: black. The next song goes live behind it, still black.
    openlp.send(&LyricsCommand::Clear).await.unwrap();
    openlp
        .send(&LyricsCommand::Prepare {
            presentation_id: "U-GRACE".into(),
        })
        .await
        .unwrap();
    assert_eq!(state.lock().unwrap().as_deref(), Some("U-GRACE"));
    assert_eq!(
        sent(&log),
        vec![
            ("core/display".to_string(), json!({"display": "blank"})),
            ("service/show".to_string(), json!({"id": "U-GRACE"})),
        ]
    );

    // Lyrics up, then another song: only the text goes, the background
    // stays.
    openlp.send(&section(0)).await.unwrap();
    after_transition().await;
    log.lock().unwrap().clear();
    openlp
        .send(&LyricsCommand::Prepare {
            presentation_id: "U-WAY".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        sent(&log),
        vec![
            ("core/display".to_string(), json!({"display": "theme"})),
            ("service/show".to_string(), json!({"id": "U-WAY"})),
        ]
    );
}

#[tokio::test]
async fn logs_in_when_asked_and_sends_the_bare_token() {
    let (mut connection, log) = server(|request| {
        let authorized = request.headers.get("authorization").map(String::as_str) == Some("TOKEN-1");
        match request.target.as_str() {
            "/api/v2/core/login" => {
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                if body == json!({"username": "openlp", "password": "secreto"}) {
                    Response::json(200, r#"{"token":"TOKEN-1"}"#)
                } else {
                    Response::json(401, "")
                }
            }
            _ if !authorized => Response::json(401, ""),
            _ => Response::json(204, ""),
        }
    })
    .await;
    connection.token = Some("secreto".into());
    let openlp = client(connection.clone());
    openlp.send(&LyricsCommand::ClearText).await.unwrap();
    let seen: Vec<(String, Option<String>)> = log
        .lock()
        .unwrap()
        .iter()
        .map(|request| (request.target.clone(), request.authorization.clone()))
        .collect();
    assert_eq!(
        seen,
        vec![
            ("/api/v2/core/display".into(), None),
            ("/api/v2/core/login".into(), None),
            ("/api/v2/core/display".into(), Some("TOKEN-1".into())),
        ]
    );

    // Wrong user and password, or none: unauthorized.
    connection.token = Some("ana:otra".into());
    assert!(matches!(
        client(connection.clone()).send(&LyricsCommand::ClearText).await,
        Err(LyricsError::Unauthorized { .. })
    ));
    connection.token = None;
    assert!(matches!(
        client(connection).send(&LyricsCommand::ClearText).await,
        Err(LyricsError::Unauthorized { .. })
    ));
}
