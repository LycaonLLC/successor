use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::process;

use serde::Serialize;
use successor_sim::AuthorityBridge;

fn main() {
    if let Err(error) = run() {
        eprintln!("authority bridge server failed: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let slice_path = env::args().nth(1).ok_or(
        "usage: cargo run -p successor-sim --example authority_bridge_server -- <slice-json-path>",
    )?;
    let slice_json = fs::read_to_string(slice_path)?;
    let mut bridge = AuthorityBridge::from_snapshot_json(&slice_json)?;
    if let Some(seconds) = farm_day_seconds_override() {
        bridge.set_farm_real_seconds_per_game_day(seconds);
    }
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match bridge.dispatch_json(&line) {
            Ok(output) => {
                stdout.write_all(output.as_bytes())?;
                stdout.write_all(b"\n")?;
            }
            Err(error) => {
                let output = AuthorityBridgeErrorLine {
                    schema: "successor.rust-authority-bridge-error.v1",
                    ok: false,
                    error: error.to_string(),
                };
                serde_json::to_writer(&mut stdout, &output)?;
                stdout.write_all(b"\n")?;
            }
        }
        stdout.flush()?;
    }

    Ok(())
}

/// Dev/QA host-process override (F-Time §H). This is read once while the bridge
/// starts, before deterministic authority ticks begin.
#[allow(clippy::disallowed_methods)]
fn farm_day_seconds_override() -> Option<u32> {
    let raw = env::var("SUCCESSOR_FARM_DAY_SECONDS").ok()?;
    let seconds = raw.trim().parse::<u32>().ok()?;
    (seconds > 0).then_some(seconds)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorityBridgeErrorLine<'a> {
    schema: &'a str,
    ok: bool,
    error: String,
}
