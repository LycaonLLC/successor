//! Bounded character-local macro parser/runtime. Statements resolve only to the
//! public gameplay action path; no statement can mutate projected state.

use serde_json::{json, Value};

use super::actions::GameplayAction;

pub const BODY_BYTES_MAX: usize = 8 * 1024;
pub const MACROS_MAX: usize = 64;
pub const RUN_SLOTS_MAX: usize = 4;
pub const STEPS_PER_TICK_MAX: usize = 256;
pub const RECURSION_MAX: usize = 8;
pub const STORAGE_SCHEMA: &str = "successor.macro-library.v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MacroSource {
    pub name: String,
    pub body: String,
}

#[derive(Clone, Debug)]
struct Run {
    macro_index: usize,
    line: usize,
    wait_until_tick: u64,
    depth: usize,
}

#[derive(Default)]
pub struct MacroRuntime {
    macros: Vec<MacroSource>,
    runs: Vec<Run>,
    dirty: bool,
    pub last_error: Option<String>,
}

impl MacroRuntime {
    pub fn macros(&self) -> &[MacroSource] {
        &self.macros
    }
    pub fn dirty(&self) -> bool {
        self.dirty
    }
    pub fn mark_saved(&mut self) {
        self.dirty = false;
    }

    pub fn save_macro(&mut self, name: &str, body: &str) -> Result<(), &'static str> {
        let name = name.trim();
        if name.is_empty() {
            return Err("macro_name_required");
        }
        if body.len() > BODY_BYTES_MAX {
            return Err("macro_body_too_large");
        }
        parse(body)?;
        if let Some(existing) = self
            .macros
            .iter_mut()
            .find(|item| item.name.eq_ignore_ascii_case(name))
        {
            existing.name = name.to_string();
            existing.body = body.to_string();
        } else {
            if self.macros.len() >= MACROS_MAX {
                return Err("macro_cap");
            }
            self.macros.push(MacroSource {
                name: name.to_string(),
                body: body.to_string(),
            });
        }
        self.dirty = true;
        Ok(())
    }

    pub fn delete(&mut self, name: &str) -> bool {
        let Some(index) = self
            .macros
            .iter()
            .position(|item| item.name.eq_ignore_ascii_case(name))
        else {
            return false;
        };
        self.macros.remove(index);
        self.runs.retain(|run| run.macro_index != index);
        for run in &mut self.runs {
            if run.macro_index > index {
                run.macro_index -= 1;
            }
        }
        self.dirty = true;
        true
    }

    pub fn start(&mut self, name: &str) -> Result<(), &'static str> {
        if self.runs.len() >= RUN_SLOTS_MAX {
            return Err("macro_run_slots_full");
        }
        let Some(index) = self
            .macros
            .iter()
            .position(|item| item.name.eq_ignore_ascii_case(name))
        else {
            return Err("macro_not_found");
        };
        self.runs.push(Run {
            macro_index: index,
            line: 0,
            wait_until_tick: 0,
            depth: 0,
        });
        Ok(())
    }

    pub fn stop(&mut self, name: &str) {
        self.runs.retain(|run| {
            !self
                .macros
                .get(run.macro_index)
                .is_some_and(|item| item.name.eq_ignore_ascii_case(name))
        });
    }

    pub fn tick(
        &mut self,
        tick: u64,
        selected_target: Option<&str>,
        out: &mut Vec<GameplayAction>,
    ) {
        let mut budget = STEPS_PER_TICK_MAX;
        let mut index = 0;
        while index < self.runs.len() && budget > 0 {
            if self.runs[index].wait_until_tick > tick {
                index += 1;
                continue;
            }
            let source = &self.macros[self.runs[index].macro_index];
            let lines: Vec<&str> = source
                .body
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('#'))
                .collect();
            if self.runs[index].line >= lines.len() {
                self.runs.swap_remove(index);
                continue;
            }
            let line = lines[self.runs[index].line];
            self.runs[index].line += 1;
            budget -= 1;
            let mut words = line.split_whitespace();
            let verb = words.next().unwrap_or("").to_ascii_lowercase();
            match verb.as_str() {
                "wait" => {
                    let delay = words
                        .next()
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(1)
                        .clamp(1, 1800);
                    self.runs[index].wait_until_tick = tick.saturating_add(delay);
                }
                "attack" => {
                    if let Some(target_actor_id) = selected_target {
                        out.push(GameplayAction::Attack {
                            action_id: "basic_shot".into(),
                            target_actor_id: target_actor_id.to_string(),
                        });
                    }
                }
                "reload" => out.push(GameplayAction::Reload {
                    weapon_id: None,
                    ammo_type: None,
                }),
                "kneel" | "stand" => out.push(GameplayAction::SetPosture { posture: verb }),
                "peace" => out.push(GameplayAction::Peace),
                "clone" => out.push(GameplayAction::CloneRespawn { facility_id: None }),
                "call" => {
                    let Some(name) = words.next() else {
                        self.last_error = Some("macro_call_name_required".into());
                        continue;
                    };
                    if self.runs[index].depth >= RECURSION_MAX {
                        self.last_error = Some("macro_recursion_cap".into());
                        continue;
                    }
                    if let Some(callee) = self
                        .macros
                        .iter()
                        .position(|item| item.name.eq_ignore_ascii_case(name))
                    {
                        self.runs.push(Run {
                            macro_index: callee,
                            line: 0,
                            wait_until_tick: tick,
                            depth: self.runs[index].depth + 1,
                        });
                    } else {
                        self.last_error = Some("macro_not_found".into());
                    }
                }
                _ => self.last_error = Some(format!("macro_verb_unknown:{verb}")),
            }
            index += 1;
        }
    }

    pub fn save(&self) -> Value {
        json!({"schema": STORAGE_SCHEMA, "macros": self.macros.iter().map(|item| json!({"name": item.name, "body": item.body})).collect::<Vec<_>>()})
    }

    pub fn load(value: Option<&Value>) -> Self {
        let mut runtime = Self::default();
        let Some(value) = value
            .filter(|value| value.get("schema").and_then(Value::as_str) == Some(STORAGE_SCHEMA))
        else {
            return runtime;
        };
        if let Some(rows) = value.get("macros").and_then(Value::as_array) {
            for row in rows.iter().take(MACROS_MAX) {
                if let (Some(name), Some(body)) = (
                    row.get("name").and_then(Value::as_str),
                    row.get("body").and_then(Value::as_str),
                ) {
                    let _ = runtime.save_macro(name, body);
                }
            }
        }
        runtime.dirty = false;
        runtime
    }
}

fn parse(body: &str) -> Result<(), &'static str> {
    if body.len() > BODY_BYTES_MAX {
        return Err("macro_body_too_large");
    }
    for line in body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        let verb = line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(
            verb.as_str(),
            "wait" | "attack" | "reload" | "kneel" | "stand" | "peace" | "clone" | "call"
        ) {
            return Err("macro_verb_unknown");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_and_oversize_sources() {
        let mut rt = MacroRuntime::default();
        assert_eq!(
            rt.save_macro("bad", "debug-grant"),
            Err("macro_verb_unknown")
        );
        assert_eq!(
            rt.save_macro("large", &"x".repeat(BODY_BYTES_MAX + 1)),
            Err("macro_body_too_large")
        );
    }

    #[test]
    fn runs_only_public_actions_with_wait_and_round_trips() {
        let mut rt = MacroRuntime::default();
        rt.save_macro("combat", "attack\nwait 2\nreload").unwrap();
        rt.start("combat").unwrap();
        let mut out = Vec::new();
        rt.tick(1, Some("target"), &mut out);
        assert!(matches!(out[0], GameplayAction::Attack { .. }));
        rt.tick(2, Some("target"), &mut out);
        rt.tick(3, Some("target"), &mut out);
        rt.tick(4, Some("target"), &mut out);
        assert!(matches!(out.last(), Some(GameplayAction::Reload { .. })));
        let loaded = MacroRuntime::load(Some(&rt.save()));
        assert_eq!(loaded.macros(), rt.macros());
    }
}
