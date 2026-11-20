//! Talk to a lyrics program by hand (plan lyrics-sync, step 01).
//!
//! ```text
//! cargo run -p libretracks-lyrics --example lyrics_probe -- \
//!   <propresenter|freeshow|holyrics> <host:port> [--token T] <order> [args]
//! ```
//!
//! Orders: probe, list, structure <id>, section <id> <group|index>,
//! index <id> <n>, next <id>, clear, current, latency <id> <group> <N>,
//! dump <id> <dir>.

use std::process::ExitCode;
use std::time::Duration;

use libretracks_core::LyricsSoftware;
use libretracks_lyrics::clients::{client_for, Connection, LyricsClient};
use libretracks_lyrics::plan::LyricsCommand;

fn usage() -> ExitCode {
    eprintln!(
        "uso: lyrics_probe <propresenter|freeshow|holyrics> <host:puerto> [--token T] <orden> [args]\n\
         órdenes: probe | list | structure <id> | section <id> <grupo|índice> | index <id> <n> |\n\
         next <id> | clear | current | latency <id> <grupo> <N> | dump <id> <dir>"
    );
    ExitCode::from(2)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut token = None;
    if let Some(position) = args.iter().position(|arg| arg == "--token") {
        if position + 1 >= args.len() {
            return usage();
        }
        token = Some(args.remove(position + 1));
        args.remove(position);
    }
    if args.len() < 3 {
        return usage();
    }
    let software = match args[0].to_lowercase().as_str() {
        "propresenter" => LyricsSoftware::ProPresenter,
        "freeshow" => LyricsSoftware::FreeShow,
        "holyrics" => LyricsSoftware::Holyrics,
        _ => return usage(),
    };
    let Some((host, port)) = args[1].rsplit_once(':') else {
        return usage();
    };
    let Ok(port) = port.parse::<u16>() else {
        return usage();
    };
    let connection = Connection {
        host: host.to_string(),
        port,
        token,
    };
    let client = match client_for(software, connection) {
        Ok(client) => client,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };
    match run(client.as_ref(), &args[2], &args[3..]).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

fn pretty<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

async fn run(client: &dyn LyricsClient, order: &str, rest: &[String]) -> Result<(), String> {
    let arg = |n: usize| rest.get(n).cloned().ok_or_else(|| format!("falta el argumento {}", n + 1));
    match order {
        "probe" => println!("{}", pretty(&client.probe().await.map_err(|e| e.to_string())?)),
        "list" => {
            for presentation in client.list_presentations().await.map_err(|e| e.to_string())? {
                println!("{}\t{}", presentation.id, presentation.name);
            }
        }
        "structure" => println!(
            "{}",
            pretty(&client.structure(&arg(0)?).await.map_err(|e| e.to_string())?)
        ),
        "section" | "index" | "next" | "clear" | "latency" => {
            let command = match order {
                "clear" => LyricsCommand::Clear,
                "next" => LyricsCommand::Step {
                    presentation_id: arg(0)?,
                    index: None,
                },
                "index" => LyricsCommand::Step {
                    presentation_id: arg(0)?,
                    index: Some(arg(1)?.parse().map_err(|_| "índice no numérico")?),
                },
                _ => {
                    let target = arg(1)?;
                    let index = target.parse::<u32>().unwrap_or(0);
                    LyricsCommand::Section {
                        presentation_id: arg(0)?,
                        group_label: target,
                        index,
                    }
                }
            };
            let times = if order == "latency" {
                arg(2)?.parse::<usize>().map_err(|_| "N no numérico")?
            } else {
                1
            };
            let mut samples: Vec<Duration> = Vec::with_capacity(times);
            for _ in 0..times {
                samples.push(client.send(&command).await.map_err(|e| e.to_string())?);
            }
            samples.sort();
            let ms = |d: Duration| d.as_secs_f64() * 1000.0;
            let at = |q: f64| samples[((samples.len() - 1) as f64 * q).round() as usize];
            println!(
                "{} envío(s): p50 {:.1} ms, p95 {:.1} ms, máx {:.1} ms",
                samples.len(),
                ms(at(0.5)),
                ms(at(0.95)),
                ms(*samples.last().expect("at least one"))
            );
        }
        "current" => println!("{}", pretty(&client.current().await.map_err(|e| e.to_string())?)),
        "dump" => {
            let id = arg(0)?;
            let dir = std::path::PathBuf::from(arg(1)?);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let write = |name: &str, text: String| {
                std::fs::write(dir.join(name), text).map_err(|e| e.to_string())
            };
            write(
                "catalog.json",
                pretty(&client.list_presentations().await.map_err(|e| e.to_string())?),
            )?;
            write(
                "structure.json",
                pretty(&client.structure(&id).await.map_err(|e| e.to_string())?),
            )?;
            write("current.json", pretty(&client.current().await.map_err(|e| e.to_string())?))?;
            println!("guardado en {}", dir.display());
        }
        _ => return Err(format!("orden desconocida: {order}")),
    }
    Ok(())
}
