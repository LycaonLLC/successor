//! Emit the debug character-builder catalog.
//!
//! The native client embeds the output with `include_str!`, so the builder menu
//! lists exactly what the authority can actually grant. Regenerate with:
//!
//!   cargo run -p successor-sim --bin emit_debug_catalog -- \
//!     tools/codegen/generated/debug-catalog.generated.json
//!
//! `--check` exits non-zero when the committed file has drifted, which is what
//! the hygiene gate runs.

use std::{env, fs, path::Path};

use successor_sim::debug_catalog::{debug_catalog_items, debug_catalog_skill_boxes};

const SCHEMA: &str = "successor.debug-catalog.v1";
const REGEN: &str = "cargo run -p successor-sim --bin emit_debug_catalog -- tools/codegen/generated/debug-catalog.generated.json";

/// Curated bundles, so a tester can outfit a character in one tick instead of
/// hunting ids. Every id is asserted present in the emitted item list, so a
/// renamed or removed item breaks generation rather than shipping a dead pack.
const PACKS: &[(&str, &str, &[u32])] = &[
    // Everything the survey/extraction loop is gated on. Without the multitool
    // and a category tool the authority answers `target_unavailable` and the
    // pane looks broken, which is the single most common tester dead end.
    (
        "survey_kit",
        "Survey Kit",
        &[3001, 3006, 3008, 3009, 3010, 3011, 3007],
    ),
    (
        "extractor_kit",
        "Extractor Kit",
        &[3012, 3013, 3014, 3201, 3004],
    ),
    (
        "medic_kit",
        "Medic Kit",
        &[1001, 1002, 1003, 1007, 1008, 1009],
    ),
    (
        "weapons_ranged",
        "Ranged Weapons",
        &[3111, 3112, 3121, 3122, 3123, 3124, 3125, 3126, 3127],
    ),
    (
        "weapons_melee",
        "Melee Weapons",
        &[3103, 3104, 3105, 3106, 3107],
    ),
    (
        "resource_sampler",
        "Resource Sampler",
        &[2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010],
    ),
    (
        "creature_harvest",
        "Creature Harvest",
        &[2101, 2102, 2103, 2104],
    ),
];

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out
}

fn render() -> Result<String, String> {
    let items = debug_catalog_items();
    let skill_boxes = debug_catalog_skill_boxes();
    let known: std::collections::BTreeSet<u32> = items.iter().map(|item| item.id).collect();

    let mut out = String::new();
    out.push_str("{\n");
    out.push_str(&format!("  \"schema\": \"{SCHEMA}\",\n"));
    out.push_str(&format!("  \"regenerationCommand\": \"{REGEN}\",\n"));

    out.push_str("  \"items\": [\n");
    for (index, item) in items.iter().enumerate() {
        let comma = if index + 1 == items.len() { "" } else { "," };
        out.push_str(&format!(
            "    {{ \"id\": {}, \"name\": \"{}\" }}{comma}\n",
            item.id,
            escape(&item.name)
        ));
    }
    out.push_str("  ],\n");

    out.push_str("  \"skillBoxes\": [\n");
    for (index, entry) in skill_boxes.iter().enumerate() {
        let comma = if index + 1 == skill_boxes.len() {
            ""
        } else {
            ","
        };
        out.push_str(&format!(
            "    {{ \"id\": \"{}\", \"title\": \"{}\", \"profession\": \"{}\", \"tier\": \"{}\" }}{comma}\n",
            escape(&entry.id),
            escape(&entry.title),
            escape(&entry.profession),
            escape(&entry.tier)
        ));
    }
    out.push_str("  ],\n");

    out.push_str("  \"packs\": [\n");
    for (index, (id, label, contents)) in PACKS.iter().enumerate() {
        for item in *contents {
            if !known.contains(item) {
                return Err(format!("pack {id} references unknown item id {item}"));
            }
        }
        let comma = if index + 1 == PACKS.len() { "" } else { "," };
        let ids = contents
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!(
            "    {{ \"id\": \"{id}\", \"label\": \"{label}\", \"items\": [{ids}] }}{comma}\n"
        ));
    }
    out.push_str("  ]\n}\n");
    Ok(out)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let check = args.iter().any(|arg| arg == "--check");
    let path = args
        .iter()
        .find(|arg| !arg.starts_with("--"))
        .cloned()
        .unwrap_or_else(|| "tools/codegen/generated/debug-catalog.generated.json".to_owned());
    let rendered = render()?;
    let path = Path::new(&path);
    if check {
        let current = fs::read_to_string(path).unwrap_or_default();
        if current != rendered {
            eprintln!("debug catalog is stale; run:\n  {REGEN}");
            std::process::exit(1);
        }
        println!("debug catalog: PASS (matches the runtime)");
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, &rendered)?;
    println!("wrote {}", path.display());
    Ok(())
}
