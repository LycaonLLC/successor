//! Pawn LOD tier gating — port of `config.pawn.lod` (`render/pawns.ts`): actors
//! within `hiFiRadiusCells` of the camera focus run the full animation mixer
//! (HI-FI); beyond, they drop to SIMULATION tier (still stream/move/pick a gait
//! clip, but skip the per-frame mixer eval). A 4-cell hysteresis stops tier
//! thrash at the boundary.

const HI_FI_RADIUS_CELLS: f32 = 40.0;
const HYSTERESIS_CELLS: f32 = 4.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LodTier {
    /// Full mixer + weapon IK every frame.
    HiFi,
    /// Streamed/positioned but skips the expensive mixer eval.
    Sim,
}

/// Per-actor LOD latch with boundary hysteresis.
#[derive(Clone, Copy, Debug)]
pub struct PawnLod {
    tier: LodTier,
}

impl Default for PawnLod {
    fn default() -> Self {
        PawnLod { tier: LodTier::Sim }
    }
}

impl PawnLod {
    /// Update the tier from the actor's distance (cells) to the camera focus.
    /// Enters HI-FI within the radius; only drops back to SIM past
    /// `radius + hysteresis` so an actor loitering at the edge does not thrash.
    pub fn update(&mut self, distance_cells: f32) -> LodTier {
        match self.tier {
            LodTier::HiFi => {
                if distance_cells > HI_FI_RADIUS_CELLS + HYSTERESIS_CELLS {
                    self.tier = LodTier::Sim;
                }
            }
            LodTier::Sim => {
                if distance_cells <= HI_FI_RADIUS_CELLS {
                    self.tier = LodTier::HiFi;
                }
            }
        }
        self.tier
    }

    pub fn tier(&self) -> LodTier {
        self.tier
    }

    /// Whether the full animation mixer should run this frame.
    pub fn runs_mixer(&self) -> bool {
        self.tier == LodTier::HiFi
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enters_hifi_within_radius() {
        let mut lod = PawnLod::default();
        assert_eq!(lod.update(30.0), LodTier::HiFi);
        assert!(lod.runs_mixer());
    }

    #[test]
    fn hysteresis_holds_tier_at_boundary() {
        let mut lod = PawnLod::default();
        lod.update(20.0); // HiFi
        // Between radius (40) and radius+hysteresis (44): stays HiFi.
        assert_eq!(lod.update(42.0), LodTier::HiFi);
        // Past hysteresis: drops to Sim.
        assert_eq!(lod.update(45.0), LodTier::Sim);
        // Between radius and radius+hysteresis coming back: stays Sim.
        assert_eq!(lod.update(41.0), LodTier::Sim);
        // At/under radius: back to HiFi.
        assert_eq!(lod.update(40.0), LodTier::HiFi);
    }
}
