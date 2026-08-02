//! Streamed environment driver: `worldClock` + `weather` sections → sun,
//! fog, color grade, and precipitation. Ports the time-of-day pipeline from
//! `client-3d` (`environment/index.ts` grade anchors via
//! `engine_render::environment`, `post.ts` zoom-relative fog window) and the
//! area-weather selection from `render/weather`. Nothing here is hard-coded
//! to a fixture: before the first clock/weather packet the scene renders the
//! documented pre-stream default (noon, clear air), and every later frame is
//! derived from the accepted sections.

use serde_json::Value;
use successor_engine_render::environment::{self, EnvSample};
use successor_engine_render::weather::WeatherKind;

/// `config.camera.pitchDegrees` (fog depth solves against the iso pitch).
const PITCH_DEG: f32 = 60.0;
/// `config.camera` distance in world units.
const CAMERA_DISTANCE: f32 = 96.0;
/// `config.renderer.fog.nearT` / `farT` — the fog window starts past the
/// visible top edge so in-frame air stays uniform.
const FOG_NEAR_T: f32 = 1.05;
const FOG_FAR_T: f32 = 1.45;

/// Pre-stream default: noon. Documented, deterministic, replaced by the first
/// accepted `worldClock`.
const DEFAULT_MINUTE: f32 = 720.0;

/// Weather phase → presentation intensity scale (server phases:
/// idle/warning/active/decay).
fn phase_scale(phase: &str) -> f32 {
    match phase {
        "active" => 1.0,
        "warning" => 0.4,
        "decay" => 0.5,
        _ => 0.0,
    }
}

/// Map a streamed `eventType` to the renderer's precipitation kind.
fn kind_for_event(event_type: &str) -> WeatherKind {
    let lower = event_type.to_ascii_lowercase();
    if lower.contains("rain") || lower.contains("storm") && lower.contains("thunder") {
        WeatherKind::Rain
    } else if lower.contains("dust") || lower.contains("sand") || lower.contains("storm") {
        WeatherKind::DustStorm
    } else {
        WeatherKind::Clear
    }
}

/// The active weather selection for the player's area/position.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ActiveWeather {
    pub kind: WeatherKind,
    /// Presentation strength 0..1 (streamed intensity × phase scale ×
    /// center-distance falloff).
    pub strength: f32,
}

impl Default for ActiveWeather {
    fn default() -> Self {
        Self {
            kind: WeatherKind::Clear,
            strength: 0.0,
        }
    }
}

/// Streamed clock + weather state, smoothed for presentation.
pub struct Environs {
    minute: f32,
    have_clock: bool,
    active: ActiveWeather,
    /// Smoothed grade blend (avoids pops on sparse clock packets).
    smoothed: Option<EnvSample>,
}

impl Default for Environs {
    fn default() -> Self {
        Self::new()
    }
}

impl Environs {
    pub fn new() -> Self {
        Self {
            minute: DEFAULT_MINUTE,
            have_clock: false,
            active: ActiveWeather::default(),
            smoothed: None,
        }
    }

    pub fn minute_of_day(&self) -> f32 {
        self.minute
    }

    pub fn have_clock(&self) -> bool {
        self.have_clock
    }

    pub fn active_weather(&self) -> ActiveWeather {
        self.active
    }

    /// Adopt the streamed `worldClock` section (`minuteOfDay`). Malformed or
    /// non-finite values leave the prior accepted minute untouched.
    pub fn apply_clock(&mut self, world_clock: Option<&Value>) {
        let Some(clock) = world_clock else { return };
        let Some(minute) = clock.get("minuteOfDay").and_then(Value::as_f64) else {
            return;
        };
        let minute = minute as f32;
        if !minute.is_finite() || !(0.0..environment::DAY_MINUTES).contains(&minute) {
            return;
        }
        self.minute = minute;
        self.have_clock = true;
    }

    /// Select the strongest weather event covering the player in the active
    /// area. Events outside the area or with a zero phase scale are ignored;
    /// inside `radiusCells` the strength falls off toward the rim.
    pub fn apply_weather(&mut self, weather: &[Value], area_id: &str, player: (f32, f32)) {
        let mut best = ActiveWeather::default();
        for event in weather {
            if event.get("areaId").and_then(Value::as_str) != Some(area_id) {
                continue;
            }
            let phase = event.get("phase").and_then(Value::as_str).unwrap_or("idle");
            let scale = phase_scale(phase);
            if scale <= 0.0 {
                continue;
            }
            let event_type = event.get("eventType").and_then(Value::as_str).unwrap_or("");
            let kind = kind_for_event(event_type);
            if kind == WeatherKind::Clear {
                continue;
            }
            let intensity = event
                .get("intensity")
                .and_then(Value::as_f64)
                .unwrap_or(0.0) as f32;
            if !(0.0..=1.0).contains(&intensity) {
                continue; // malformed → skip without adopting
            }
            let cx = event.get("centerX").and_then(Value::as_f64).unwrap_or(0.0) as f32;
            let cy = event.get("centerY").and_then(Value::as_f64).unwrap_or(0.0) as f32;
            let radius = event
                .get("radiusCells")
                .and_then(Value::as_f64)
                .unwrap_or(0.0) as f32;
            let falloff = if radius > 0.0 {
                let d = ((player.0 - cx).powi(2) + (player.1 - cy).powi(2)).sqrt();
                if d >= radius * 1.25 {
                    0.0
                } else {
                    // Full strength inside the core, easing off past the rim.
                    (1.0 - ((d / radius) - 0.6).max(0.0) / 0.65).clamp(0.0, 1.0)
                }
            } else {
                1.0 // area-wide event
            };
            let strength = intensity * scale * falloff;
            if strength > best.strength {
                best = ActiveWeather { kind, strength };
            }
        }
        self.active = best;
    }

    /// The environment sample for this frame, exponentially smoothed so
    /// sparse clock packets never pop the grade. Weather darkens/desaturates
    /// on top of the time-of-day grade (storm reading from the reference).
    pub fn sample(&mut self, dt: f32) -> EnvSample {
        let mut target = environment::sample(self.minute);
        let w = self.active.strength;
        if w > 0.0 {
            match self.active.kind {
                WeatherKind::DustStorm => {
                    // Warm dust: pull fog + grade toward sand, flatten sun.
                    let dust = [0.79, 0.65, 0.46];
                    target.fog = lerp3(target.fog, dust, 0.55 * w);
                    target.desaturate = (target.desaturate + 0.18 * w).min(1.0);
                    target.scene_darken = (target.scene_darken + 0.10 * w).min(1.0);
                    target.sun_color = lerp3(target.sun_color, dust, 0.4 * w);
                }
                WeatherKind::Rain => {
                    let slate = [0.45, 0.5, 0.56];
                    target.fog = lerp3(target.fog, slate, 0.5 * w);
                    target.desaturate = (target.desaturate + 0.25 * w).min(1.0);
                    target.scene_darken = (target.scene_darken + 0.18 * w).min(1.0);
                    target.sun_color = lerp3(target.sun_color, slate, 0.5 * w);
                }
                WeatherKind::Clear => {}
            }
        }
        let alpha = 1.0 - (-dt.max(0.0) * 2.5).exp();
        match &mut self.smoothed {
            None => {
                self.smoothed = Some(target);
                target
            }
            Some(current) => {
                blend_env(current, &target, alpha);
                *current
            }
        }
    }

    /// Fog near/far for the current zoom, from the reference contract:
    /// `depth = cameraDistance + t · (halfFrustumHeight / tan(pitch))` with
    /// the config nearT/farT window (far clamped past near).
    pub fn fog_range(&self, half_frustum_height: f32) -> (f32, f32) {
        let rise = half_frustum_height / PITCH_DEG.to_radians().tan();
        // Dust/rain pulls the melt closer so heavy weather reads as air.
        let squeeze = 1.0 - 0.35 * self.active.strength;
        let near = CAMERA_DISTANCE + FOG_NEAR_T * rise * squeeze;
        let far = (CAMERA_DISTANCE + FOG_FAR_T * rise * squeeze).max(near + 1.0);
        (near, far)
    }
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn blend_env(current: &mut EnvSample, target: &EnvSample, alpha: f32) {
    current.sun_dir = lerp3(current.sun_dir, target.sun_dir, alpha);
    current.sun_color = lerp3(current.sun_color, target.sun_color, alpha);
    current.sun_elevation01 += (target.sun_elevation01 - current.sun_elevation01) * alpha;
    current.is_day = target.is_day;
    current.fog = lerp3(current.fog, target.fog, alpha);
    current.bone_tint = lerp3(current.bone_tint, target.bone_tint, alpha);
    current.desaturate += (target.desaturate - current.desaturate) * alpha;
    current.scene_darken += (target.scene_darken - current.scene_darken) * alpha;
    current.black_lift += (target.black_lift - current.black_lift) * alpha;
    current.bloom += (target.bloom - current.bloom) * alpha;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_to_noon_until_a_clock_arrives() {
        let mut env = Environs::new();
        assert!(!env.have_clock());
        assert_eq!(env.minute_of_day(), 720.0);
        env.apply_clock(Some(&json!({ "minuteOfDay": 380.0 })));
        assert!(env.have_clock());
        assert_eq!(env.minute_of_day(), 380.0);
    }

    #[test]
    fn malformed_clock_keeps_prior_accepted_minute() {
        let mut env = Environs::new();
        env.apply_clock(Some(&json!({ "minuteOfDay": 100.0 })));
        env.apply_clock(Some(&json!({ "minuteOfDay": "noon" })));
        env.apply_clock(Some(&json!({ "minuteOfDay": 999999.0 })));
        env.apply_clock(None);
        assert_eq!(env.minute_of_day(), 100.0);
    }

    #[test]
    fn weather_selection_is_area_scoped_and_phase_gated() {
        let mut env = Environs::new();
        let events = vec![
            json!({
                "areaId": "elsewhere", "eventType": "duststorm", "phase": "active",
                "centerX": 0.0, "centerY": 0.0, "radiusCells": 0.0, "intensity": 1.0,
            }),
            json!({
                "areaId": "here", "eventType": "duststorm", "phase": "idle",
                "centerX": 0.0, "centerY": 0.0, "radiusCells": 0.0, "intensity": 1.0,
            }),
        ];
        env.apply_weather(&events, "here", (0.0, 0.0));
        assert_eq!(
            env.active_weather().strength,
            0.0,
            "wrong area / idle ignored"
        );

        let active = vec![json!({
            "areaId": "here", "eventType": "duststorm", "phase": "active",
            "centerX": 0.0, "centerY": 0.0, "radiusCells": 0.0, "intensity": 0.8,
        })];
        env.apply_weather(&active, "here", (0.0, 0.0));
        let w = env.active_weather();
        assert_eq!(w.kind, WeatherKind::DustStorm);
        assert!((w.strength - 0.8).abs() < 1e-5);
    }

    #[test]
    fn radius_falloff_zeroes_far_outside_the_cell() {
        let mut env = Environs::new();
        let events = vec![json!({
            "areaId": "a", "eventType": "rain", "phase": "active",
            "centerX": 100.0, "centerY": 100.0, "radiusCells": 20.0, "intensity": 1.0,
        })];
        env.apply_weather(&events, "a", (100.0, 100.0));
        assert!(env.active_weather().strength > 0.99, "core full strength");
        env.apply_weather(&events, "a", (100.0, 160.0));
        assert_eq!(env.active_weather().strength, 0.0, "outside 1.25r");
    }

    #[test]
    fn dust_pulls_grade_and_fog_toward_sand() {
        let mut env = Environs::new();
        let clear = env.sample(10.0); // effectively snapped
        let mut storm = Environs::new();
        storm.apply_weather(
            &[json!({
                "areaId": "a", "eventType": "duststorm", "phase": "active",
                "centerX": 0.0, "centerY": 0.0, "radiusCells": 0.0, "intensity": 1.0,
            })],
            "a",
            (0.0, 0.0),
        );
        let dusty = storm.sample(10.0);
        assert!(dusty.desaturate > clear.desaturate);
        assert!(dusty.fog != clear.fog);
    }

    #[test]
    fn fog_window_sits_past_the_visible_frame() {
        let env = Environs::new();
        let half_h = 12.5 / 2.0; // 100% zoom
        let (near, far) = env.fog_range(half_h);
        // Visible top edge depth is distance + halfH/tan(pitch); the window
        // must start past it (nearT > 1) and keep far beyond near.
        let top_edge = 96.0 + half_h / 60.0f32.to_radians().tan();
        assert!(near > top_edge);
        assert!(far > near);
    }
}
