//! Pawn appearance + weapon derivation — port of the presentation rules in
//! `client-3d/src/render/pawns.ts`: skin-tone tint (default `#cc9978`), a subtle
//! faction/relation body tint (lerp 0.3 toward the faction colour), and weapon
//! lane routing from the equipped weapon id. Pure; unit-tested.

use super::animator::WeaponLane;

/// Default skin tone (`pawns.ts` `defaultSkinColor`).
pub const DEFAULT_SKIN: [f32; 3] = [0.8, 0.6, 0.47]; // ~#cc9978

/// Parse `#rrggbb` → linear-ish 0..1 rgb; falls back to default skin.
pub fn parse_hex_rgb(s: &str) -> [f32; 3] {
    let h = s.trim().trim_start_matches('#');
    if h.len() >= 6 {
        let r = u8::from_str_radix(&h[0..2], 16);
        let g = u8::from_str_radix(&h[2..4], 16);
        let b = u8::from_str_radix(&h[4..6], 16);
        if let (Ok(r), Ok(g), Ok(b)) = (r, g, b) {
            return [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0];
        }
    }
    DEFAULT_SKIN
}

/// Body tint from an optional skin-tone hex (validated `#[0-9a-f]{6}`).
pub fn skin_tint(skin_tone: Option<&str>) -> [f32; 4] {
    let rgb = match skin_tone {
        Some(s) if is_hex6(s) => parse_hex_rgb(s),
        _ => DEFAULT_SKIN,
    };
    [rgb[0], rgb[1], rgb[2], 1.0]
}

/// Blend a base body colour 30% toward a faction colour (`pawns.ts` decision:
/// "subtle body tint, lerp 0.3 into the matcap colour").
pub fn faction_tinted(base: [f32; 4], faction: Option<[f32; 3]>) -> [f32; 4] {
    match faction {
        Some(f) => [
            base[0] + (f[0] - base[0]) * 0.3,
            base[1] + (f[1] - base[1]) * 0.3,
            base[2] + (f[2] - base[2]) * 0.3,
            base[3],
        ],
        None => base,
    }
}

/// Route an equipped weapon id to an animation lane. Rifle-class ids
/// (slugthrower / rifle / gun) → Rifle; blade-class (sword / vibro / blade /
/// melee) → Melee; otherwise Unarmed.
pub fn weapon_lane(weapon_id: Option<&str>) -> WeaponLane {
    let Some(id) = weapon_id else { return WeaponLane::Unarmed };
    let id = id.to_ascii_lowercase();
    if id.contains("slug") || id.contains("rifle") || id.contains("gun") || id.contains("scrap_rifle") {
        WeaponLane::Rifle
    } else if id.contains("sword") || id.contains("vibro") || id.contains("blade") || id.contains("melee") {
        WeaponLane::Melee
    } else {
        WeaponLane::Unarmed
    }
}

fn is_hex6(s: &str) -> bool {
    let h = s.trim().trim_start_matches('#');
    h.len() == 6 && h.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_skin_hex() {
        let t = skin_tint(Some("#cc9978"));
        assert!((t[0] - 0.8).abs() < 0.01 && (t[1] - 0.6).abs() < 0.01 && (t[2] - 0.47).abs() < 0.02);
        assert_eq!(t[3], 1.0);
    }

    #[test]
    fn invalid_skin_falls_back() {
        assert_eq!(skin_tint(Some("not-a-color")), [DEFAULT_SKIN[0], DEFAULT_SKIN[1], DEFAULT_SKIN[2], 1.0]);
        assert_eq!(skin_tint(None), [DEFAULT_SKIN[0], DEFAULT_SKIN[1], DEFAULT_SKIN[2], 1.0]);
    }

    #[test]
    fn faction_tint_lerps_30_percent() {
        let out = faction_tinted([0.0, 0.0, 0.0, 1.0], Some([1.0, 1.0, 1.0]));
        assert!((out[0] - 0.3).abs() < 1e-6);
        assert_eq!(faction_tinted([0.5, 0.5, 0.5, 1.0], None), [0.5, 0.5, 0.5, 1.0]);
    }

    #[test]
    fn weapon_lanes() {
        assert_eq!(weapon_lane(Some("slugthrower")), WeaponLane::Rifle);
        assert_eq!(weapon_lane(Some("weapon_scrap_rifle")), WeaponLane::Rifle);
        assert_eq!(weapon_lane(Some("vibrosword")), WeaponLane::Melee);
        assert_eq!(weapon_lane(Some("plasma_blade")), WeaponLane::Melee);
        assert_eq!(weapon_lane(None), WeaponLane::Unarmed);
        assert_eq!(weapon_lane(Some("field_bandage")), WeaponLane::Unarmed);
    }
}
