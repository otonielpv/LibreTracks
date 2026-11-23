//! The real-account probe of step 01 (smart-chart-import): sign in to Planning
//! Center through the loopback, the same flow the app uses, and dump the raw
//! answers of the calls the chart import needs.
//!
//! ```text
//! cargo run -p libretracks-pco --example pco_probe -- dump <folder> [song title]
//! ```
//!
//! The registered client id by default (`PCO_CLIENT_ID` overrides it). The dump holds real data:
//! sanitize it (names, ids, copyrighted lyrics) before anything goes in the
//! repo. Tokens are never printed or written; only their lifetime is.

use std::path::{Path, PathBuf};
use std::time::Duration;

use libretracks_cloud::loopback::LoopbackListener;
use libretracks_cloud::oauth::{OAuthProvider, TokenResponse};
use libretracks_cloud::token::exchange_code;
use libretracks_pco::oauth::{begin, LOOPBACK_PORTS, REGISTERED_CLIENT_ID, TOKEN_ENDPOINT};
use libretracks_pco::PlanningCenterOAuth;

const API: &str = "https://api.planningcenteronline.com/services/v2";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("dump") {
        return Err("usage: pco_probe dump <folder> [song title]".into());
    }
    let folder = PathBuf::from(args.next().ok_or("missing <folder>")?);
    let title = args.next().unwrap_or_else(|| "LT test".to_string());
    // The registered app by default; PCO_CLIENT_ID tries another one.
    let client_id = std::env::var("PCO_CLIENT_ID").unwrap_or_else(|_| REGISTERED_CLIENT_ID.to_string());
    std::fs::create_dir_all(&folder)?;

    let provider = PlanningCenterOAuth::new(client_id);
    let listener = LoopbackListener::bind_first_free(&LOOPBACK_PORTS).await?;
    let session = begin(listener.port())?;
    println!("Open this URL and authorise:\n\n{}\n", provider.authorization_url(&session));
    let redirect = tokio::time::timeout(Duration::from_secs(300), listener.wait_for_redirect()).await??;
    session.verify_state(&redirect.state)?;
    // Q1: a Public client redeems the code without a secret, or this fails.
    let token = exchange_code(&provider, &session, &redirect.code).await?;
    let now = libretracks_cloud::token::now_unix();
    println!("Q1 exchange without client_secret: OK");
    println!("Q3 access token lifetime: {} s", token.expires_at_unix.saturating_sub(now));

    // Q3: does the refresh token rotate?
    let http = reqwest::Client::new();
    let refreshed: TokenResponse = http
        .post(TOKEN_ENDPOINT)
        .form(&provider.refresh_form(&token.refresh_token))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let rotated = refreshed
        .refresh_token
        .as_deref()
        .is_some_and(|new| new != token.refresh_token);
    println!("Q3 refresh token rotates: {rotated}");
    let access = refreshed.access_token;

    let get = |path: String| {
        let http = http.clone();
        let access = access.clone();
        async move {
            let response = http
                .get(format!("{API}{path}"))
                .bearer_auth(access)
                .send()
                .await?;
            let headers: Vec<String> = response
                .headers()
                .iter()
                .filter(|(name, _)| name.as_str().starts_with("x-pco-api") || name.as_str() == "retry-after")
                .map(|(name, value)| format!("{name}: {}", value.to_str().unwrap_or("")))
                .collect();
            let status = response.status().as_u16();
            let body: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
            Ok::<_, reqwest::Error>((status, headers, body))
        }
    };
    let save = |name: &str, body: &serde_json::Value| -> std::io::Result<()> {
        write(&folder, name, body)
    };

    let (status, headers, me) = get("/me".to_string()).await?;
    println!("me: HTTP {status}; {}", headers.join("; "));
    save("me.json", &me)?;
    let (_, _, organization) = get(String::new()).await?;
    save("organization.json", &organization)?;

    let query = url::form_urlencoded::byte_serialize(title.as_bytes()).collect::<String>();
    let (_, _, songs) = get(format!("/songs?where[title]={query}&per_page=10")).await?;
    save("songs_search.json", &songs)?;
    for song in songs["data"].as_array().into_iter().flatten() {
        let song_id = song["id"].as_str().unwrap_or_default();
        let (_, _, arrangements) = get(format!("/songs/{song_id}/arrangements")).await?;
        save(&format!("song_{song_id}_arrangements.json"), &arrangements)?;
        for arrangement in arrangements["data"].as_array().into_iter().flatten() {
            let id = arrangement["id"].as_str().unwrap_or_default();
            let (_, _, full) = get(format!("/songs/{song_id}/arrangements/{id}")).await?;
            save(&format!("arrangement_{id}.json"), &full)?;
            // Recorded only to show it does not match the chart (Q6).
            let (_, _, sections) = get(format!("/songs/{song_id}/arrangements/{id}/sections")).await?;
            save(&format!("arrangement_{id}_sections.json"), &sections)?;
        }
    }

    let (_, _, service_types) = get("/service_types".to_string()).await?;
    save("service_types.json", &service_types)?;
    for service_type in service_types["data"].as_array().into_iter().flatten() {
        let type_id = service_type["id"].as_str().unwrap_or_default();
        let (_, _, plans) = get(format!("/service_types/{type_id}/plans?filter=future&order=sort_date")).await?;
        save(&format!("service_type_{type_id}_plans.json"), &plans)?;
        for plan in plans["data"].as_array().into_iter().flatten().take(2) {
            let plan_id = plan["id"].as_str().unwrap_or_default();
            let (_, _, items) = get(format!(
                "/service_types/{type_id}/plans/{plan_id}/items?include=song,arrangement,key"
            ))
            .await?;
            save(&format!("plan_{plan_id}_items.json"), &items)?;
        }
    }
    println!("Dumped to {}", folder.display());
    Ok(())
}

fn write(folder: &Path, name: &str, body: &serde_json::Value) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(body).unwrap_or_default();
    std::fs::write(folder.join(name), text + "\n")
}
