//! `PcoClient` against `libretracks-test-http` serving the answers recorded
//! from a real account in step 01. No real network, no real account.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use libretracks_cloud::CloudError;
use libretracks_pco::{PcoClient, PcoError, PcoTokens};
use libretracks_test_http::{serve, Request, Response};

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("missing fixture {path}"))
}

/// Tokens that count refreshes; `refresh_ok = false` is a dead refresh token.
struct FakeTokens {
    current: Mutex<String>,
    refreshes: AtomicUsize,
    refresh_ok: bool,
}

impl FakeTokens {
    fn new(refresh_ok: bool) -> Arc<Self> {
        Arc::new(Self {
            current: Mutex::new("t1".into()),
            refreshes: AtomicUsize::new(0),
            refresh_ok,
        })
    }
}

#[async_trait]
impl PcoTokens for FakeTokens {
    async fn access_token(&self) -> Result<String, CloudError> {
        Ok(self.current.lock().unwrap().clone())
    }

    async fn refresh_rejected(&self, _rejected: &str) -> Result<String, CloudError> {
        self.refreshes.fetch_add(1, Ordering::SeqCst);
        if !self.refresh_ok {
            return Err(CloudError::NotConnected);
        }
        *self.current.lock().unwrap() = "t2".into();
        Ok("t2".into())
    }
}

/// The recorded answers, by path. `None` = 404.
fn recorded(request: &Request) -> Option<String> {
    let path = request.target.split('?').next().unwrap_or_default();
    let name = match path {
        "/services/v2/me" => "me.json",
        "/services/v2" | "/services/v2/" => "organization.json",
        "/services/v2/songs" => "songs_search.json",
        "/services/v2/songs/9000009/arrangements" => "song_arrangements.json",
        "/services/v2/songs/9000003/arrangements/9000001" => "arrangement_amazing_grace.json",
        "/services/v2/songs/9000005/arrangements/9000004" => "arrangement_prueba_uno.json",
        "/services/v2/songs/9000014/arrangements/9000013" => "arrangement_canta_mi_alma.json",
        "/services/v2/service_types" => "service_types.json",
        "/services/v2/service_types/9000016/plans" => "plans_future.json",
        "/services/v2/service_types/9000016/plans/9000017/items" => "plan_items.json",
        _ => return None,
    };
    Some(fixture(name))
}

async fn client_for<H>(handler: H, tokens: Arc<FakeTokens>) -> PcoClient
where
    H: Fn(Request, &str) -> Option<Response> + Send + Sync + 'static,
{
    let base = serve(handler).await;
    PcoClient::with_base(&format!("{base}/services/v2"), tokens).unwrap()
}

async fn recorded_client() -> PcoClient {
    client_for(
        |request, _| match recorded(&request) {
            Some(body) => Response::json(200, body),
            None => Response::json(404, r#"{"errors":[{"status":"404","title":"Not Found"}]}"#),
        },
        FakeTokens::new(true),
    )
    .await
}

#[tokio::test]
async fn me_reads_the_person_and_the_organization() {
    let account = recorded_client().await.me().await.unwrap();
    assert_eq!(account.name, "Ana Ejemplo");
    assert_eq!(account.organization, "LibreTracks");
}

#[tokio::test]
async fn search_sends_the_title_filter_and_reads_songs() {
    let seen = Arc::new(Mutex::new(String::new()));
    let seen_by_server = Arc::clone(&seen);
    let client = client_for(
        move |request, _| {
            *seen_by_server.lock().unwrap() = request.target.clone();
            Response::json(200, fixture("songs_search.json"))
        },
        FakeTokens::new(true),
    )
    .await;
    let page = client.search_songs("LT test", 0).await.unwrap();
    let target = seen.lock().unwrap().clone();
    assert!(target.contains("where%5Btitle%5D=LT+test"), "{target}");
    assert!(target.contains("per_page=25"), "{target}");
    assert_eq!(page.total, Some(6));
    assert!(!page.has_more);
    assert!(page.items.iter().any(|song| song.title == "Amazing Grace (LT test)"));
}

#[tokio::test]
async fn arrangements_bring_chart_key_sequence_and_date() {
    let client = recorded_client().await;
    let grace = client.arrangement("9000003", "9000001").await.unwrap();
    assert_eq!(grace.song_id, "9000003");
    assert_eq!(grace.chord_chart_key.as_deref(), Some("G"));
    assert!(grace.chord_chart.as_deref().unwrap().contains("[G]"));
    assert_eq!(grace.meter.as_deref(), Some("3/4"));
    assert!(grace.updated_at.is_some());
    assert_eq!(grace.sequence_full[0].label, "Intro");
    assert_eq!(grace.sequence_full[0].number.as_deref(), Some("1"));
    assert_eq!(grace.sequence.len(), grace.sequence_full.len());

    let latin = client.arrangement("9000014", "9000013").await.unwrap();
    assert!(latin.chord_chart.as_deref().unwrap().contains("ESTROFA I"));

    let list = client.arrangements("9000009").await.unwrap();
    assert_eq!(list.len(), 2);
    assert!(list.iter().any(|arrangement| arrangement.name == "Acoustic (D)"));
}

#[tokio::test]
async fn plans_and_their_song_items_with_own_sequence_and_key() {
    let client = recorded_client().await;
    let types = client.service_types().await.unwrap();
    assert_eq!(types[0].name, "Domingo (LT test)");
    let plans = client.upcoming_plans(&types[0].id).await.unwrap();
    assert_eq!(plans[0].title.as_deref(), Some("Culto de prueba LT"));
    let items = client.plan_items(&types[0].id, &plans[0].id).await.unwrap();
    assert_eq!(items.len(), 6);
    let first = &items[0];
    assert_eq!(first.song_id.as_deref(), Some("9000005"));
    assert_eq!(first.arrangement_id.as_deref(), Some("9000004"));
    assert_eq!(first.key_name.as_deref(), Some("E"));
    let acoustic = items
        .iter()
        .find(|item| item.title.as_deref() == Some("Test Song Two (LT test)"))
        .unwrap();
    let labels: Vec<String> = acoustic
        .custom_arrangement_sequence_full
        .iter()
        .map(|entry| format!("{} {}", entry.label, entry.number.as_deref().unwrap_or("")))
        .collect();
    assert_eq!(labels, ["Verse 1", "Chorus 1", "Verse 2", "Chorus 1", "Chorus 1"]);
}

fn song_page(base: &str, page: usize, last: usize) -> String {
    let next = if page < last {
        format!(r#""next":"https://api.planningcenteronline.com/services/v2/service_types?offset={page}","#)
    } else {
        String::new()
    };
    let _ = base;
    format!(
        r#"{{"links":{{{next}"self":"x"}},"data":[{{"type":"ServiceType","id":"{page}","attributes":{{"name":"Servicio {page}"}}}}]}}"#
    )
}

#[tokio::test]
async fn pages_are_joined_and_the_cap_is_respected() {
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&requests);
    let client = client_for(
        move |request, base| {
            counter.fetch_add(1, Ordering::SeqCst);
            let page = request
                .target
                .split("offset=")
                .nth(1)
                .and_then(|value| value.parse::<usize>().ok())
                .map(|value| value + 1)
                .unwrap_or(1);
            Response::json(200, song_page(base, page, 3))
        },
        FakeTokens::new(true),
    )
    .await;
    let types = client.service_types().await.unwrap();
    assert_eq!(
        types.iter().map(|service| service.name.as_str()).collect::<Vec<_>>(),
        ["Servicio 1", "Servicio 2", "Servicio 3"]
    );
    assert_eq!(requests.load(Ordering::SeqCst), 3);

    // Endless "next": stops at MAX_PAGES.
    let endless = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&endless);
    let client = client_for(
        move |request, base| {
            counter.fetch_add(1, Ordering::SeqCst);
            let page = request
                .target
                .split("offset=")
                .nth(1)
                .and_then(|value| value.parse::<usize>().ok())
                .map(|value| value + 1)
                .unwrap_or(1);
            Response::json(200, song_page(base, page, usize::MAX))
        },
        FakeTokens::new(true),
    )
    .await;
    assert_eq!(client.service_types().await.unwrap().len(), libretracks_pco::client::MAX_PAGES);
    assert_eq!(endless.load(Ordering::SeqCst), libretracks_pco::client::MAX_PAGES);
}

fn rate_limited() -> Option<Response> {
    let recorded: serde_json::Value = serde_json::from_str(&fixture("rate_limited_429.json")).unwrap();
    let body = recorded["body"].to_string();
    Response::with_headers(429, body, &[("Retry-After", "1"), ("X-PCO-API-Request-Rate-Limit", "100")])
}

#[tokio::test]
async fn one_429_waits_and_retries_two_in_a_row_give_up() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let client = client_for(
        move |_, _| {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                rate_limited()
            } else {
                Response::json(200, fixture("service_types.json"))
            }
        },
        FakeTokens::new(true),
    )
    .await;
    let started = std::time::Instant::now();
    assert_eq!(client.service_types().await.unwrap().len(), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(started.elapsed() >= std::time::Duration::from_millis(900));

    let client = client_for(|_, _| rate_limited(), FakeTokens::new(true)).await;
    assert_eq!(
        client.service_types().await.unwrap_err(),
        PcoError::RateLimited { retry_after_secs: 1 }
    );
}

#[tokio::test]
async fn a_refused_token_is_refreshed_once_and_a_dead_refresh_signs_out() {
    let tokens = FakeTokens::new(true);
    let client = client_for(
        |request, _| match request.headers.get("authorization").map(String::as_str) {
            Some("Bearer t2") => Response::json(200, fixture("service_types.json")),
            _ => Response::json(401, r#"{"errors":[{"status":"401"}]}"#),
        },
        Arc::clone(&tokens),
    )
    .await;
    assert_eq!(client.service_types().await.unwrap().len(), 1);
    assert_eq!(tokens.refreshes.load(Ordering::SeqCst), 1);

    let dead = FakeTokens::new(false);
    let client = client_for(|_, _| Response::json(401, "{}"), Arc::clone(&dead)).await;
    assert_eq!(client.service_types().await.unwrap_err(), PcoError::SignedOut);
    assert_eq!(dead.refreshes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn no_services_access_and_not_found_are_told_apart() {
    let client = client_for(
        |request, _| {
            if request.target.contains("/me") {
                Response::json(
                    403,
                    r#"{"errors":[{"status":"403","detail":"The authenticated user was not found in the application"}]}"#,
                )
            } else {
                Response::json(404, "{}")
            }
        },
        FakeTokens::new(true),
    )
    .await;
    assert_eq!(client.me().await.unwrap_err(), PcoError::NoServicesAccess);
    assert_eq!(client.arrangement("1", "2").await.unwrap_err(), PcoError::NotFound);
}

fn write() -> libretracks_pco::ArrangementWrite {
    libretracks_pco::ArrangementWrite {
        name: Some("LibreTracks".into()),
        chord_chart: "VERSO 1\n[D]Uno\n\nCORO\n[G]Luz\n".into(),
        chord_chart_key: "D".into(),
        sequence: vec!["Verso 1".into(), "Coro".into(), "Coro".into()],
    }
}

#[tokio::test]
async fn a_new_arrangement_is_posted_with_chart_key_and_sequence() {
    let seen = Arc::new(Mutex::new((String::new(), String::new(), String::new())));
    let seen_by_server = Arc::clone(&seen);
    let client = client_for(
        move |request, _| {
            *seen_by_server.lock().unwrap() = (
                request.method.clone(),
                request.target.clone(),
                String::from_utf8(request.body.clone()).unwrap(),
            );
            Response::json(201, fixture("arrangement_test_song_two_acoustic.json"))
        },
        FakeTokens::new(true),
    )
    .await;
    let created = client.create_arrangement("9000009", &write()).await.unwrap();
    assert_eq!(created.song_id, "9000009");
    let (method, target, body) = seen.lock().unwrap().clone();
    assert_eq!(method, "POST");
    assert_eq!(target, "/services/v2/songs/9000009/arrangements");
    let body: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["data"]["type"], "Arrangement");
    assert_eq!(body["data"]["attributes"]["name"], "LibreTracks");
    assert_eq!(body["data"]["attributes"]["chord_chart_key"], "D");
    assert_eq!(body["data"]["attributes"]["sequence"], serde_json::json!(["Verso 1", "Coro", "Coro"]));
}

#[tokio::test]
async fn replacing_patches_the_arrangement_without_renaming_it() {
    let seen = Arc::new(Mutex::new((String::new(), String::new())));
    let seen_by_server = Arc::clone(&seen);
    let client = client_for(
        move |request, _| {
            *seen_by_server.lock().unwrap() = (request.method.clone(), String::from_utf8(request.body.clone()).unwrap());
            Response::json(200, fixture("arrangement_test_song_two_acoustic.json"))
        },
        FakeTokens::new(true),
    )
    .await;
    let mut replace = write();
    replace.name = None;
    client.update_arrangement("9000009", "9000010", &replace).await.unwrap();
    let (method, body) = seen.lock().unwrap().clone();
    assert_eq!(method, "PATCH");
    let body: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(body["data"]["attributes"].get("name").is_none());
}

#[tokio::test]
async fn a_write_without_permission_says_so() {
    let client = client_for(|_, _| Response::json(403, r#"{"errors":[{"status":"403"}]}"#), FakeTokens::new(true)).await;
    assert_eq!(
        client.create_arrangement("1", &write()).await.unwrap_err(),
        PcoError::NoEditPermission
    );
}
