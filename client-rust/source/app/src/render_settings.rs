//! Versioned render tuning loaded from `assets/render/settings.json`.
//!
//! The app owns JSON and filesystem policy; the no_std renderer receives only
//! validated, copyable runtime values through `RendererSettings`.

use serde::{Deserialize, Serialize};
use std::sync::{OnceLock, RwLock};
use successor_engine_render::renderer::{
    AaSettings as EngineAaSettings, ColorGradeSettings as EngineColorGradeSettings,
    PaletteSettings as EnginePaletteSettings, RenderQuality, RendererSettings,
    ShadowSettings as EngineShadowSettings, SunSettings as EngineSunSettings,
};

pub const SETTINGS_SCHEMA: &str = "successor.render-settings.v1";
pub const SETTINGS_VERSION: u32 = 1;
#[cfg(any(target_arch = "wasm32", test))]
const EMBEDDED_DEFAULT: &str = include_str!("../../../assets/render/settings.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QualityPreset {
    Low,
    Medium,
    High,
}

impl QualityPreset {
    pub const ALL: [Self; 3] = [Self::Low, Self::Medium, Self::High];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Low => "LOW",
            Self::Medium => "MEDIUM",
            Self::High => "HIGH",
        }
    }

    pub const fn render_quality(self) -> RenderQuality {
        match self {
            Self::Low => RenderQuality::Low,
            Self::Medium => RenderQuality::Medium,
            Self::High => RenderQuality::High,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderSettingsDocument {
    pub schema: String,
    pub version: u32,
    pub selected_preset: QualityPreset,
    pub presets: QualityPresets,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualityPresets {
    pub low: PresetSettings,
    pub medium: PresetSettings,
    pub high: PresetSettings,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PresetSettings {
    pub ambient_intensity: f32,
    pub emissive_scalar: f32,
    pub exposure: f32,
    pub bloom: BloomSettings,
    pub sun: SunSettings,
    pub aa: AaSettings,
    pub ao: AoSettings,
    pub shadows: ShadowSettings,
    pub color_grading: ColorGradeSettings,
    pub palette: PaletteSettings,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BloomSettings {
    pub threshold: f32,
    pub intensity: f32,
    pub radius: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SunSettings {
    pub azimuth_degrees: f32,
    pub elevation_degrees: f32,
    pub color: [f32; 3],
    pub intensity: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AaSettings {
    pub enabled: bool,
    pub edge_threshold_min: f32,
    pub edge_threshold: f32,
    pub subpixel_blend: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AoSettings {
    pub intensity: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShadowSettings {
    pub map_size: u32,
    pub world_radius: f32,
    pub depth_bias: f32,
    pub normal_bias: f32,
    pub penumbra: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColorGradeSettings {
    pub saturation: f32,
    pub contrast: f32,
    pub gamma: f32,
    pub temperature: f32,
    pub tint: f32,
    pub lift: [f32; 3],
    pub color_gamma: [f32; 3],
    pub gain: [f32; 3],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaletteSettings {
    pub enabled: bool,
    pub levels: u32,
    pub strength: f32,
    pub dither: f32,
}

impl RenderSettingsDocument {
    pub fn builtin() -> Self {
        Self {
            schema: SETTINGS_SCHEMA.to_string(),
            version: SETTINGS_VERSION,
            selected_preset: QualityPreset::Medium,
            presets: QualityPresets {
                low: PresetSettings::low(),
                medium: PresetSettings::medium(),
                high: PresetSettings::high(),
            },
        }
    }

    pub fn parse(source: &str) -> Result<Self, String> {
        let parsed: Self = serde_json::from_str(source)
            .map_err(|error| format!("parse render settings: {error}"))?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema != SETTINGS_SCHEMA {
            return Err(format!(
                "unsupported render settings schema: {}",
                self.schema
            ));
        }
        if self.version != SETTINGS_VERSION {
            return Err(format!(
                "unsupported render settings version: {}",
                self.version
            ));
        }
        self.presets.low.validate("low")?;
        self.presets.medium.validate("medium")?;
        self.presets.high.validate("high")?;
        Ok(())
    }

    pub fn preset(&self, preset: QualityPreset) -> &PresetSettings {
        match preset {
            QualityPreset::Low => &self.presets.low,
            QualityPreset::Medium => &self.presets.medium,
            QualityPreset::High => &self.presets.high,
        }
    }

    pub fn selected(&self) -> &PresetSettings {
        self.preset(self.selected_preset)
    }

    pub fn selected_mut(&mut self) -> &mut PresetSettings {
        match self.selected_preset {
            QualityPreset::Low => &mut self.presets.low,
            QualityPreset::Medium => &mut self.presets.medium,
            QualityPreset::High => &mut self.presets.high,
        }
    }

    pub fn select(&mut self, preset: QualityPreset) {
        self.selected_preset = preset;
    }

    pub fn reset_selected(&mut self) {
        *self.selected_mut() = match self.selected_preset {
            QualityPreset::Low => PresetSettings::low(),
            QualityPreset::Medium => PresetSettings::medium(),
            QualityPreset::High => PresetSettings::high(),
        };
    }

    pub fn to_pretty_json(&self) -> Result<String, String> {
        self.validate()?;
        let mut json = serde_json::to_string_pretty(self)
            .map_err(|error| format!("serialize render settings: {error}"))?;
        json.push('\n');
        Ok(json)
    }
}

impl PresetSettings {
    fn base() -> Self {
        Self {
            ambient_intensity: 0.5,
            emissive_scalar: 1.0,
            exposure: 1.0,
            bloom: BloomSettings {
                threshold: 1.0,
                intensity: 0.55,
                radius: 1.0,
            },
            sun: SunSettings {
                azimuth_degrees: -45.0,
                elevation_degrees: 55.0,
                color: [1.0, 0.97, 0.9],
                intensity: 1.0,
            },
            aa: AaSettings {
                enabled: true,
                edge_threshold_min: 0.0312,
                edge_threshold: 0.125,
                subpixel_blend: 0.75,
            },
            ao: AoSettings { intensity: 1.0 },
            shadows: ShadowSettings {
                map_size: 2048,
                world_radius: 48.0,
                depth_bias: 0.0015,
                normal_bias: 1.5,
                penumbra: 40.0,
            },
            color_grading: ColorGradeSettings {
                saturation: 1.0,
                contrast: 1.0,
                gamma: 1.0,
                temperature: 0.0,
                tint: 0.0,
                lift: [0.0; 3],
                color_gamma: [1.0; 3],
                gain: [1.0; 3],
            },
            palette: PaletteSettings {
                enabled: false,
                levels: 16,
                strength: 0.0,
                dither: 0.0,
            },
        }
    }

    pub fn low() -> Self {
        let mut value = Self::base();
        value.bloom.intensity = 0.25;
        value.bloom.radius = 0.75;
        value.shadows.map_size = 1024;
        value.shadows.penumbra = 24.0;
        value.aa.subpixel_blend = 0.5;
        value
    }

    pub fn medium() -> Self {
        Self::base()
    }

    pub fn high() -> Self {
        let mut value = Self::base();
        value.bloom.intensity = 0.7;
        value.bloom.radius = 1.35;
        value.shadows.map_size = 4096;
        value.shadows.penumbra = 55.0;
        value.aa.edge_threshold_min = 0.02;
        value.aa.edge_threshold = 0.09;
        value.aa.subpixel_blend = 0.85;
        value
    }

    pub fn validate(&self, name: &str) -> Result<(), String> {
        finite_range(name, "ambient_intensity", self.ambient_intensity, 0.0, 2.0)?;
        finite_range(name, "emissive_scalar", self.emissive_scalar, 0.0, 8.0)?;
        finite_range(name, "exposure", self.exposure, 0.1, 4.0)?;
        finite_range(name, "bloom.threshold", self.bloom.threshold, 0.0, 8.0)?;
        finite_range(name, "bloom.intensity", self.bloom.intensity, 0.0, 4.0)?;
        finite_range(name, "bloom.radius", self.bloom.radius, 0.25, 4.0)?;
        finite_range(
            name,
            "sun.azimuth_degrees",
            self.sun.azimuth_degrees,
            -180.0,
            180.0,
        )?;
        finite_range(
            name,
            "sun.elevation_degrees",
            self.sun.elevation_degrees,
            5.0,
            89.0,
        )?;
        finite_vec(name, "sun.color", self.sun.color, 0.0, 4.0)?;
        finite_range(name, "sun.intensity", self.sun.intensity, 0.0, 8.0)?;
        finite_range(
            name,
            "aa.edge_threshold_min",
            self.aa.edge_threshold_min,
            0.001,
            0.5,
        )?;
        finite_range(name, "aa.edge_threshold", self.aa.edge_threshold, 0.01, 0.5)?;
        finite_range(name, "aa.subpixel_blend", self.aa.subpixel_blend, 0.0, 1.0)?;
        finite_range(name, "ao.intensity", self.ao.intensity, 0.0, 4.0)?;
        if !matches!(self.shadows.map_size, 512 | 1024 | 2048 | 4096) {
            return Err(format!(
                "{name}.shadows.map_size must be 512, 1024, 2048, or 4096"
            ));
        }
        finite_range(
            name,
            "shadows.world_radius",
            self.shadows.world_radius,
            8.0,
            256.0,
        )?;
        finite_range(
            name,
            "shadows.depth_bias",
            self.shadows.depth_bias,
            0.0,
            0.05,
        )?;
        finite_range(
            name,
            "shadows.normal_bias",
            self.shadows.normal_bias,
            0.0,
            8.0,
        )?;
        finite_range(name, "shadows.penumbra", self.shadows.penumbra, 0.0, 100.0)?;
        let grade = &self.color_grading;
        finite_range(name, "color_grading.saturation", grade.saturation, 0.0, 2.0)?;
        finite_range(name, "color_grading.contrast", grade.contrast, 0.0, 2.0)?;
        finite_range(name, "color_grading.gamma", grade.gamma, 0.5, 2.5)?;
        finite_range(
            name,
            "color_grading.temperature",
            grade.temperature,
            -1.0,
            1.0,
        )?;
        finite_range(name, "color_grading.tint", grade.tint, -1.0, 1.0)?;
        finite_vec(name, "color_grading.lift", grade.lift, -1.0, 1.0)?;
        finite_vec(
            name,
            "color_grading.color_gamma",
            grade.color_gamma,
            0.1,
            4.0,
        )?;
        finite_vec(name, "color_grading.gain", grade.gain, 0.0, 4.0)?;
        if !(2..=64).contains(&self.palette.levels) {
            return Err(format!("{name}.palette.levels must be between 2 and 64"));
        }
        finite_range(name, "palette.strength", self.palette.strength, 0.0, 1.0)?;
        finite_range(name, "palette.dither", self.palette.dither, 0.0, 1.0)?;
        Ok(())
    }

    pub fn renderer_settings(&self) -> RendererSettings {
        RendererSettings {
            ambient_intensity: self.ambient_intensity,
            emissive_scalar: self.emissive_scalar,
            exposure: self.exposure,
            ao_intensity: self.ao.intensity,
            bloom_threshold: self.bloom.threshold,
            bloom_intensity: self.bloom.intensity,
            bloom_radius: self.bloom.radius,
            sun: EngineSunSettings {
                azimuth_degrees: self.sun.azimuth_degrees,
                elevation_degrees: self.sun.elevation_degrees,
                color: self.sun.color,
                intensity: self.sun.intensity,
            },
            aa: EngineAaSettings {
                enabled: self.aa.enabled,
                edge_threshold_min: self.aa.edge_threshold_min,
                edge_threshold: self.aa.edge_threshold,
                subpixel_blend: self.aa.subpixel_blend,
            },
            shadows: EngineShadowSettings {
                map_size: self.shadows.map_size,
                world_radius: self.shadows.world_radius,
                depth_bias: self.shadows.depth_bias,
                normal_bias: self.shadows.normal_bias,
                penumbra: self.shadows.penumbra,
            },
            color_grade: EngineColorGradeSettings {
                saturation: self.color_grading.saturation,
                contrast: self.color_grading.contrast,
                gamma: self.color_grading.gamma,
                temperature: self.color_grading.temperature,
                tint: self.color_grading.tint,
                lift: self.color_grading.lift,
                color_gamma: self.color_grading.color_gamma,
                gain: self.color_grading.gain,
            },
            palette: EnginePaletteSettings {
                enabled: self.palette.enabled,
                levels: self.palette.levels,
                strength: self.palette.strength,
                dither: self.palette.dither,
            },
        }
    }
}

fn finite_range(scope: &str, field: &str, value: f32, min: f32, max: f32) -> Result<(), String> {
    if value.is_finite() && value >= min && value <= max {
        Ok(())
    } else {
        Err(format!(
            "{scope}.{field} must be finite and in [{min}, {max}]"
        ))
    }
}

fn finite_vec(scope: &str, field: &str, value: [f32; 3], min: f32, max: f32) -> Result<(), String> {
    for channel in value {
        finite_range(scope, field, channel, min, max)?;
    }
    Ok(())
}

static SETTINGS: OnceLock<RwLock<RenderSettingsDocument>> = OnceLock::new();
static SETTINGS_PATH: OnceLock<String> = OnceLock::new();

pub fn initialize() {
    if SETTINGS.get().is_some() {
        return;
    }
    let (document, path) = match load_document() {
        Ok(loaded) => loaded,
        Err(error) => {
            eprintln!("render settings: {error}; using built-in defaults");
            (RenderSettingsDocument::builtin(), default_path())
        }
    };
    let _ = SETTINGS_PATH.set(path);
    let _ = SETTINGS.set(RwLock::new(document));
}

pub fn document() -> RenderSettingsDocument {
    initialize();
    SETTINGS
        .get()
        .expect("render settings initialized")
        .read()
        .expect("render settings lock poisoned")
        .clone()
}

pub fn replace(document: RenderSettingsDocument) -> Result<(), String> {
    document.validate()?;
    initialize();
    *SETTINGS
        .get()
        .expect("render settings initialized")
        .write()
        .map_err(|_| "render settings lock poisoned".to_string())? = document;
    Ok(())
}

pub fn selected() -> PresetSettings {
    document().selected().clone()
}

pub fn selected_preset() -> QualityPreset {
    document().selected_preset
}

pub fn reload() -> Result<RenderSettingsDocument, String> {
    let (document, _) = load_document()?;
    replace(document.clone())?;
    Ok(document)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn save(document: &RenderSettingsDocument) -> Result<(), String> {
    let json = document.to_pretty_json()?;
    initialize();
    let path = SETTINGS_PATH.get().cloned().unwrap_or_else(default_path);
    successor_platform::fs_write_atomic(&path, json.as_bytes())?;
    replace(document.clone())
}

#[cfg(target_arch = "wasm32")]
pub fn save(_document: &RenderSettingsDocument) -> Result<(), String> {
    Err("render settings are read-only in the browser build".to_string())
}

fn load_document() -> Result<(RenderSettingsDocument, String), String> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let path = discover_path();
        let bytes = successor_platform::fs_read(&path)?;
        let source = std::str::from_utf8(&bytes)
            .map_err(|error| format!("render settings are not UTF-8: {error}"))?;
        Ok((RenderSettingsDocument::parse(source)?, path))
    }
    #[cfg(target_arch = "wasm32")]
    {
        Ok((
            RenderSettingsDocument::parse(EMBEDDED_DEFAULT)?,
            default_path(),
        ))
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn discover_path() -> String {
    for candidate in [
        "assets/render/settings.json",
        "client-rust/assets/render/settings.json",
    ] {
        if successor_platform::fs_exists(candidate) {
            return candidate.to_string();
        }
    }
    default_path()
}

fn default_path() -> String {
    #[cfg(not(target_arch = "wasm32"))]
    if successor_platform::fs_exists("client-rust") {
        return "client-rust/assets/render/settings.json".to_string();
    }
    "assets/render/settings.json".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_settings_match_builtin_contract() {
        let parsed = RenderSettingsDocument::parse(EMBEDDED_DEFAULT).expect("embedded settings");
        assert_eq!(parsed.schema, SETTINGS_SCHEMA);
        assert_eq!(parsed.version, SETTINGS_VERSION);
        assert_eq!(parsed.selected_preset, QualityPreset::Medium);
        assert_eq!(parsed.presets.low.shadows.map_size, 1024);
        assert_eq!(parsed.presets.medium.shadows.map_size, 2048);
        assert_eq!(parsed.presets.high.shadows.map_size, 4096);
    }

    #[test]
    fn rejects_invalid_shadow_option_and_unknown_schema() {
        let mut doc = RenderSettingsDocument::builtin();
        doc.presets.medium.shadows.map_size = 3000;
        assert!(doc.validate().is_err());
        doc = RenderSettingsDocument::builtin();
        doc.schema = "other".to_string();
        assert!(doc.validate().is_err());
    }

    #[test]
    fn json_round_trip_preserves_every_preset() {
        let doc = RenderSettingsDocument::builtin();
        let json = doc.to_pretty_json().expect("serialize");
        let parsed = RenderSettingsDocument::parse(&json).expect("parse");
        assert_eq!(
            parsed.presets.high.palette.levels,
            doc.presets.high.palette.levels
        );
        assert_eq!(
            parsed.presets.low.bloom.radius,
            doc.presets.low.bloom.radius
        );
    }
}
