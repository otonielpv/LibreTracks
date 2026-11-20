//! Plan lyrics-sync, paso 05: lo que cada cliente manda por la red y cómo
//! entiende los errores, contra el servidor de `libretracks-test-http`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use libretracks_core::LyricsSoftware;
use libretracks_lyrics::clients::{client_for, Connection, LyricsClient};
use libretracks_lyrics::plan::LyricsCommand;
use libretracks_lyrics::LyricsError;
use libretracks_test_http::{serve, Request, Response};

fn fixture(path: &str) -> String {
    let full = format!("{}/tests/fixtures/{path}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&full).expect(&full)
}

#[derive(Debug, Clone, PartialEq)]
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

fn client(software: LyricsSoftware, connection: Connection) -> Box<dyn LyricsClient> {
    client_for(software, connection).unwrap()
}

fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap()
}

#[tokio::test]
async fn propresenter_requests() {
    let (connection, log) = server(|request| match request.target.as_str() {
        "/version" => Response::json(200, fixture("propresenter/version.json")),
        "/v1/libraries" => Response::json(200, fixture("propresenter/libraries.json")),
        "/v1/library/LIB-1" => Response::json(200, fixture("propresenter/library.json")),
        "/v1/presentation/PRES-WAYMAKER" => {
            Response::json(200, fixture("propresenter/presentation.json"))
        }
        "/v1/presentation/slide_index" => Response::json(
            200,
            r#"{"presentation_index":{"index":3,"presentation_id":{"uuid":"PRES-WAYMAKER","name":"Way Maker","index":0}}}"#,
        ),
        _ => Response::json(204, ""),
    })
    .await;
    let pp = client(LyricsSoftware::ProPresenter, connection);
    let probe = pp.probe().await.unwrap();
    assert_eq!(probe.version, "ProPresenter 7.16");
    assert_eq!(probe.presentations, 2);
    assert_eq!(pp.structure("PRES-WAYMAKER").await.unwrap().entries.len(), 6);
    let id = "PRES-WAYMAKER".to_string();
    for command in [
        LyricsCommand::Section {
            presentation_id: id.clone(),
            group_label: "Pre-Coro 2".into(),
            index: 0,
        },
        LyricsCommand::Step {
            presentation_id: id.clone(),
            index: None,
        },
        LyricsCommand::Step {
            presentation_id: id.clone(),
            index: Some(4),
        },
        LyricsCommand::Prepare {
            presentation_id: id.clone(),
        },
        LyricsCommand::Clear,
    ] {
        pp.send(&command).await.unwrap();
    }
    let current = pp.current().await.unwrap().unwrap();
    assert_eq!(current.index, Some(3));
    assert_eq!(current.presentation_id.as_deref(), Some("PRES-WAYMAKER"));
    let targets: Vec<String> = log
        .lock()
        .unwrap()
        .iter()
        .filter(|seen| seen.method == "GET")
        .map(|seen| seen.target.clone())
        .collect();
    for expected in [
        "/v1/presentation/PRES-WAYMAKER/group/Pre-Coro%202/trigger",
        "/v1/presentation/PRES-WAYMAKER/next/trigger",
        "/v1/presentation/PRES-WAYMAKER/4/trigger",
        "/v1/presentation/PRES-WAYMAKER/focus",
        "/v1/clear/layer/slide",
    ] {
        assert!(targets.iter().any(|target| target == expected), "{expected} not in {targets:?}");
    }
}

#[tokio::test]
async fn propresenter_encodes_accents_and_reports_404() {
    let (connection, log) = server(|request| {
        if request.target.contains("/group/") {
            Response::json(404, "")
        } else {
            Response::json(204, "")
        }
    })
    .await;
    let pp = client(LyricsSoftware::ProPresenter, connection);
    let error = pp
        .send(&LyricsCommand::Section {
            presentation_id: "P".into(),
            group_label: "Pré-Coro 2".into(),
            index: 0,
        })
        .await
        .unwrap_err();
    assert!(matches!(error, LyricsError::NotFound { .. }), "{error:?}");
    assert_eq!(
        log.lock().unwrap()[0].target,
        "/v1/presentation/P/group/Pr%C3%A9-Coro%202/trigger"
    );
}

#[tokio::test]
async fn freeshow_requests_carry_the_key_and_one_based_indices() {
    let (mut connection, log) = server(|request| {
        let body = json(&String::from_utf8_lossy(&request.body));
        match body["action"].as_str().unwrap() {
            "get_shows" => Response::json(200, fixture("freeshow/get_shows.json")),
            "get_show" => Response::json(200, fixture("freeshow/get_show.json")),
            "get_show_layout" => Response::json(200, fixture("freeshow/get_show_layout.json")),
            "get_output_group_name" => Response::json(200, r#"{"data":"Estribillo"}"#),
            _ => Response::json(204, ""),
        }
    })
    .await;
    connection.token = Some("clave".into());
    let fs = client(LyricsSoftware::FreeShow, connection);
    assert_eq!(fs.probe().await.unwrap().presentations, 2);
    let structure = fs.structure("show-waymaker").await.unwrap();
    assert_eq!(structure.entries[2].first_index, 4);
    fs.send(&LyricsCommand::Section {
        presentation_id: "show-waymaker".into(),
        group_label: "Estribillo".into(),
        index: 7,
    })
    .await
    .unwrap();
    fs.send(&LyricsCommand::Step {
        presentation_id: "show-waymaker".into(),
        index: Some(8),
    })
    .await
    .unwrap();
    fs.send(&LyricsCommand::Prepare {
        presentation_id: "show-waymaker".into(),
    })
    .await
    .unwrap();
    fs.send(&LyricsCommand::Clear).await.unwrap();
    assert_eq!(
        fs.current().await.unwrap().unwrap().label.as_deref(),
        Some("Estribillo")
    );
    let seen = log.lock().unwrap().clone();
    assert!(seen.iter().all(|request| request.method == "POST" && request.target == "/"));
    assert!(seen
        .iter()
        .all(|request| request.authorization.as_deref() == Some("Bearer clave")));
    let bodies: Vec<serde_json::Value> = seen.iter().map(|request| json(&request.body)).collect();
    assert!(bodies.contains(&json(
        r#"{"action":"index_select_slide","showId":"show-waymaker","index":7}"#
    )));
    assert!(bodies.contains(&json(
        r#"{"action":"index_select_slide","showId":"show-waymaker","index":8}"#
    )));
    assert!(bodies.contains(&json(r#"{"action":"id_select_show","id":"show-waymaker"}"#)));
    assert!(bodies.contains(&json(r#"{"action":"clear_slide"}"#)));
}

fn holyrics_action(target: &str) -> String {
    target
        .trim_start_matches("/api/")
        .split('?')
        .next()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn holyrics_requests_carry_the_token_and_lift_the_blank() {
    let (mut connection, log) = server(|request| match holyrics_action(&request.target).as_str() {
        "GetTokenInfo" => Response::json(200, fixture("holyrics/GetTokenInfo.json")),
        "CheckPermissions" => {
            Response::json(200, r#"{"status":"ok","data":{"unauthorized_actions":[]}}"#)
        }
        "GetSongs" => Response::json(200, fixture("holyrics/GetSongs.json")),
        "GetLyrics" => Response::json(200, fixture("holyrics/GetLyrics.json")),
        "GetSlideDescriptions" => Response::json(200, fixture("holyrics/GetSlideDescriptions.json")),
        "GetCurrentPresentation" => Response::json(
            200,
            r#"{"status":"ok","data":{"id":"812","slide_number":4,"slide_description":"Coro"}}"#,
        ),
        _ => Response::json(200, r#"{"status":"ok","data":null}"#),
    })
    .await;
    connection.token = Some("tok en".into());
    let holyrics = client(LyricsSoftware::Holyrics, connection);
    let probe = holyrics.probe().await.unwrap();
    assert_eq!(probe.version, "Holyrics 2.30.0");
    assert_eq!(probe.presentations, 2);
    assert_eq!(holyrics.structure("812").await.unwrap().entries.len(), 8);
    holyrics.send(&LyricsCommand::Clear).await.unwrap();
    holyrics
        .send(&LyricsCommand::Section {
            presentation_id: "812".into(),
            group_label: "Coro".into(),
            index: 6,
        })
        .await
        .unwrap();
    holyrics
        .send(&LyricsCommand::Step {
            presentation_id: "812".into(),
            index: Some(7),
        })
        .await
        .unwrap();
    let current = holyrics.current().await.unwrap().unwrap();
    assert_eq!(current.index, Some(3));
    let seen = log.lock().unwrap().clone();
    assert!(seen
        .iter()
        .all(|request| request.method == "POST" && request.target.ends_with("?token=tok%20en")));
    let sent: Vec<(String, serde_json::Value)> = seen
        .iter()
        .map(|request| (holyrics_action(&request.target), json(&request.body)))
        .collect();
    let after_clear: Vec<&(String, serde_json::Value)> = sent
        .iter()
        .skip_while(|(action, body)| !(action == "SetF8" && body["enable"] == true))
        .collect();
    assert_eq!(after_clear[1], &("SetF8".to_string(), json(r#"{"enable":false}"#)));
    assert_eq!(
        after_clear[2],
        &("ShowLyrics".to_string(), json(r#"{"id":"812","initial_index":6}"#))
    );
    assert_eq!(
        after_clear[3],
        &("ActionGoToIndex".to_string(), json(r#"{"index":7}"#))
    );
}

#[tokio::test]
async fn holyrics_reports_missing_permissions_and_a_bad_token() {
    let (connection, _) = server(|request| match holyrics_action(&request.target).as_str() {
        "GetTokenInfo" => Response::json(200, fixture("holyrics/GetTokenInfo.json")),
        "CheckPermissions" => Response::json(200, fixture("holyrics/CheckPermissions_missing.json")),
        _ => Response::json(200, r#"{"status":"ok","data":[]}"#),
    })
    .await;
    let error = client(LyricsSoftware::Holyrics, connection).probe().await.unwrap_err();
    assert_eq!(
        error,
        LyricsError::Unauthorized {
            missing: vec!["ActionGoToIndex".into(), "SetF8".into()]
        }
    );

    let (connection, _) =
        server(|_| Response::json(200, fixture("holyrics/invalid_token.json"))).await;
    let error = client(LyricsSoftware::Holyrics, connection).probe().await.unwrap_err();
    assert_eq!(error, LyricsError::Unauthorized { missing: vec![] });
}

#[tokio::test]
async fn a_silent_program_times_out_within_a_second_and_a_closed_port_is_unreachable() {
    let (connection, _) =
        server(|_| Response::delayed(204, "", Duration::from_secs(3))).await;
    let started = Instant::now();
    let error = client(LyricsSoftware::FreeShow, connection)
        .send(&LyricsCommand::Clear)
        .await
        .unwrap_err();
    assert_eq!(error, LyricsError::Timeout);
    assert!(started.elapsed() <= Duration::from_secs(1), "{:?}", started.elapsed());

    // A port nobody listens on.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let error = client(
        LyricsSoftware::ProPresenter,
        Connection {
            host: "127.0.0.1".into(),
            port,
            token: None,
        },
    )
    .send(&LyricsCommand::Clear)
    .await
    .unwrap_err();
    assert!(matches!(error, LyricsError::Unreachable { .. }), "{error:?}");
}
