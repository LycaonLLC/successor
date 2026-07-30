use std::{env, fs, path::Path};

use serde::Serialize;
use successor_sim::combat_ai::verification::{
    navigation_overlay_artifact, primitive_map_artifact, reason_histogram_artifact,
    tactical_affordance_overlay_artifact, verify_primitive_maps,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let report = verify_primitive_maps();
    if let Some(output_dir) = env::args_os().nth(1) {
        let output_dir = Path::new(&output_dir);
        fs::create_dir_all(output_dir)?;
        write_json(output_dir.join("report.json"), &report)?;
        write_json(
            output_dir.join("primitive-map.json"),
            &primitive_map_artifact(&report),
        )?;
        write_json(
            output_dir.join("navigation-overlay.json"),
            &navigation_overlay_artifact(&report),
        )?;
        write_json(
            output_dir.join("tactical-affordance-overlay.json"),
            &tactical_affordance_overlay_artifact(&report),
        )?;
        write_json(
            output_dir.join("reason-histogram.json"),
            &reason_histogram_artifact(&report),
        )?;
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).expect("primitive report serializes")
        );
    }
    if !report.passed {
        std::process::exit(1);
    }
    Ok(())
}

fn write_json(
    path: impl AsRef<Path>,
    value: &impl Serialize,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}
