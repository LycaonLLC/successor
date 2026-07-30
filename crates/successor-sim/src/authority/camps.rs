use super::*;

// ── SCOUT CAMP ────────────────────────────────────────────────────────────────
// A craftable, placeable field camp in the earlier sandbox design Scout/Ranger lineage. Lifecycle,
// mirroring the placed-extractor sibling it lives beside in `SliceAuthorityState`:
//
//   craft  — CAMP KIT is a commodity craft (bone + hide), gated on Novice Scout
//            (`scout-novice`). Field-assembled: no crafting
//            tool/station is required — the whole point of a scout camp is that it
//            goes up in the wild. See `craft_camp_kit`.
//   place  — placing CONSUMES the kit (earlier sandbox design camps were single-use; documented and
//            owner-recommended) and spawns a `PlacedCampState`. One camp per player.
//   shelter— the camp is a weather-shelter EXEMPTION zone. It reuses the existing
//            `AuthorityWeatherShelterBox` primitive — there is no bespoke weather
//            immunity here; `tick_weather_hazards` skips any actor standing inside
//            an active camp's box exactly as it already skips prop-shelter boxes.
//   persist— the camp lives INDEFINITELY while its owner is present (within the
//            presence radius). On leaving — which includes fighting elsewhere, i.e.
//            simply not being within that radius — a generous grace timer starts;
//            returning before it fires resets it. See `tick_placed_camps`.
//   pack-up— the owner can strike the camp on demand (frees the one-per-player
//            slot immediately). The kit was consumed on placement, so pack-up
//            returns nothing (single-use rule).
//
// The camp also carries the FE prop hook: its snapshot is rendered as the
// measured pod-tent GLB at the base shelter footprint through the stable
// `AuthorityPlacedCampSnapshot::render_kind` contract.

// Weather-shelter footprint: a square AABB centered on the camp, sized to the
// existing shelter-house scale box (the open-desert shelter house is 5x4 cells),
// so the exemption zone matches what the FE renders. Half-extent in milli-cells
// (2_500 = 2.5 cells → a 5x5-cell footprint).
const CAMP_SHELTER_HALF_EXTENT_MILLI_CELLS: i32 = 2_500;

// Presence radius: the owner counts as "in the camp" (grace timer paused/reset)
// while within this circle of the camp center. Deliberately a touch larger than
// the shelter box so stepping just outside the tent to harvest or fight off a
// straggler does not begin abandonment.
const CAMP_PRESENCE_RADIUS_MILLI_CELLS: i32 = 6_000;

// Abandonment grace: a basic camp survives until its owner has been away for
// more than ten real-time minutes. Campcraft training can extend that baseline.
// Conversion to ticks keeps the timer deterministic (no wall clock).
const CAMP_ABANDONMENT_GRACE_SECONDS: u64 = 10 * 60;

// Camp-kit commodity recipe (scout campcraft track). Bone frame + hide cover.
const CRAFT_CAMP_KIT_BONE_QTY: u32 = 24;
const CRAFT_CAMP_KIT_HIDE_QTY: u32 = 36;
const CRAFT_CAMP_KIT_BATCH_MS: u64 = 8_000;
const CRAFT_CAMP_KIT_SCOUT_XP: u64 = 90;
// Novice Scout gates both assembling and placing the basic field camp.
const CAMP_NOVICE_SKILL_BOX: &str = "scout-novice";
// FE prop hook: stable render identity the client maps to the pod-tent GLB.
const CAMP_RENDER_KIND: &str = "scout-camp";

impl SliceAuthorityState {
    pub fn placed_camp_snapshots_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityPlacedCampSnapshot> {
        let observer = self.runtime.durable.actors.get(&config.player_actor_id);
        self.runtime
            .durable
            .placed_camps
            .values()
            .filter(|camp| match observer {
                Some(actor) => {
                    self.camp_in_interest(actor, camp, config.area_interest_radius_cells)
                }
                None => true,
            })
            .map(|camp| self.placed_camp_snapshot_from_state(camp, observer))
            .collect()
    }

    /// Weather-shelter boxes for every standing camp, grouped with their area.
    /// Any camp shelters — including one in its abandonment grace window — because
    /// the tent is physically still up until it is torn down.
    pub(super) fn active_camp_shelter_boxes(&self) -> Vec<(String, AuthorityWeatherShelterBox)> {
        self.runtime
            .durable
            .placed_camps
            .values()
            .map(|camp| (camp.area_id.clone(), placed_camp_shelter_box(camp)))
            .collect()
    }

    /// Legacy commodity compatibility: bone + hide -> one CAMP KIT, gated on
    /// Novice Scout. New UI flows use the canonical multi-step craft recipe.
    pub(super) fn craft_camp_kit(
        &mut self,
        actor: &ActorAuthorityState,
    ) -> Result<u32, AuthorityRejectReason> {
        if !actor.professions.has_skill_box(CAMP_NOVICE_SKILL_BOX) {
            return Err(AuthorityRejectReason::SkillPrerequisiteMissing);
        }
        self.ensure_actor_economy_action_ready(&actor.id)?;
        if self.actor_inventory_available_quantity(&actor.id, RESOURCE_CREATURE_BONE_ITEM_ID)
            < CRAFT_CAMP_KIT_BONE_QTY
            || self.actor_inventory_available_quantity(&actor.id, RESOURCE_CREATURE_HIDE_ITEM_ID)
                < CRAFT_CAMP_KIT_HIDE_QTY
        {
            return Err(AuthorityRejectReason::IngredientUnavailable);
        }
        self.consume_actor_inventory_quantity(
            &actor.id,
            RESOURCE_CREATURE_BONE_ITEM_ID,
            CRAFT_CAMP_KIT_BONE_QTY,
        )?;
        self.consume_actor_inventory_quantity(
            &actor.id,
            RESOURCE_CREATURE_HIDE_ITEM_ID,
            CRAFT_CAMP_KIT_HIDE_QTY,
        )?;
        let item_name =
            inventory_item_name(CAMP_KIT_ITEM_ID).ok_or(AuthorityRejectReason::UnknownItem)?;
        let added = self.add_actor_inventory_stack(
            &actor.id,
            CAMP_KIT_ITEM_ID,
            0,
            item_name,
            1,
            CAMP_KIT_STACK_CAP,
            "field-supplies",
        );
        self.set_actor_economy_action_cooldown(&actor.id, CRAFT_CAMP_KIT_BATCH_MS)?;
        let total_xp = self.award_profession_tracks_xp(
            &actor.id,
            AuthorityProfessionKind::Scout,
            &["campcraft"],
            CRAFT_CAMP_KIT_SCOUT_XP,
        )?;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} assembled a Camp Kit (+{CRAFT_CAMP_KIT_SCOUT_XP} Scout campcraft XP, total {total_xp})",
                actor.id
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(added)
    }

    pub(super) fn apply_place_camp(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        if actor.posture != AuthorityActorPosture::Standing {
            return Err(AuthorityRejectReason::PostureLocked);
        }
        if !actor.professions.has_skill_box(CAMP_NOVICE_SKILL_BOX) {
            return Err(AuthorityRejectReason::SkillPrerequisiteMissing);
        }
        // One camp per player active.
        if self
            .runtime
            .durable
            .placed_camps
            .values()
            .any(|camp| camp.owner_actor_id == actor.id)
        {
            return Err(AuthorityRejectReason::CampAlreadyPlaced);
        }
        let area = self
            .runtime
            .durable
            .world
            .areas
            .get(&actor.area_id)
            .ok_or(AuthorityRejectReason::UnknownArea)?;
        if !area.contains(actor.cell) {
            return Err(AuthorityRejectReason::OutOfBounds);
        }
        if self
            .runtime
            .durable
            .world
            .blocked_cells
            .contains(&CellKey::new(&actor.area_id, actor.cell.x, actor.cell.y))
        {
            return Err(AuthorityRejectReason::BlockedCell);
        }
        // A camp is not a one-cell decal: the authority shelters a 5x5 box
        // (wider for trained campcraft) and the pod-tent renders inside it.
        // Validate that whole box before spending the single-use kit. This is
        // deliberately authority-owned so a client cannot pitch through a
        // building, over another actor, or into another player's camp merely
        // by standing on one clear lattice cell.
        let shelter_half_extent = CAMP_SHELTER_HALF_EXTENT_MILLI_CELLS.saturating_add(
            actor
                .professions
                .scout_campcraft_shelter_radius_bonus_cells()
                .saturating_mul(MILLI_CELLS_PER_CELL),
        );
        let placement_box = camp_shelter_box(actor.position, shelter_half_extent);
        if !camp_box_fits_area(&placement_box, area) {
            return Err(AuthorityRejectReason::OutOfBounds);
        }
        if self.camp_placement_footprint_blocked(&actor, &placement_box) {
            return Err(AuthorityRejectReason::StructureFootprintBlocked);
        }
        // Kit is consumed on placement (single-use rule; see module header).
        if self.actor_inventory_available_quantity(&actor.id, CAMP_KIT_ITEM_ID) < 1 {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        self.consume_actor_inventory_quantity(&actor.id, CAMP_KIT_ITEM_ID, 1)?;
        let seq = self.runtime.durable.next_camp_id.max(1);
        self.runtime.durable.next_camp_id = seq.saturating_add(1).max(1);
        let camp_id = format!("camp:{}:{seq}", actor.id);
        self.runtime.durable.placed_camps.insert(
            camp_id.clone(),
            PlacedCampState {
                camp_id,
                owner_actor_id: actor.id.clone(),
                area_id: actor.area_id.clone(),
                cell: actor.cell,
                position: actor.position,
                placed_at_tick: self.runtime.durable.tick,
                shelter_half_extent_milli_cells: Some(shelter_half_extent),
                // Owner is standing on it at placement, so it starts persisting
                // indefinitely (no teardown deadline).
                teardown_tick: None,
            },
        );
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} pitched a scout camp", actor.id),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(())
    }

    fn camp_placement_footprint_blocked(
        &self,
        actor: &ActorAuthorityState,
        placement_box: &AuthorityWeatherShelterBox,
    ) -> bool {
        let static_cell_overlap = self
            .runtime
            .durable
            .world
            .blocked_cells
            .iter()
            .filter(|cell| cell.area_id == actor.area_id)
            .any(|cell| {
                camp_box_intersects_bounds(
                    placement_box,
                    cell.x.saturating_mul(MILLI_CELLS_PER_CELL),
                    cell.y.saturating_mul(MILLI_CELLS_PER_CELL),
                    cell.x
                        .saturating_add(1)
                        .saturating_mul(MILLI_CELLS_PER_CELL),
                    cell.y
                        .saturating_add(1)
                        .saturating_mul(MILLI_CELLS_PER_CELL),
                )
            });
        if static_cell_overlap {
            return true;
        }

        let fine_collision_overlap = self
            .runtime
            .durable
            .world
            .fine_collision_bounds
            .iter()
            .filter(|bounds| bounds.area_id == actor.area_id)
            .any(|bounds| {
                camp_box_intersects_bounds(
                    placement_box,
                    bounds.left,
                    bounds.top,
                    bounds.right,
                    bounds.bottom,
                )
            });
        if fine_collision_overlap {
            return true;
        }

        // Doors are dynamic movement blockers, but their doorway is still part
        // of an authored structure. An open panel must not make that building
        // a legal camp site for one frame.
        let door_collision_overlap = self
            .runtime
            .durable
            .door_collision_bounds
            .iter()
            .filter(|bounds| bounds.area_id == actor.area_id)
            .any(|bounds| {
                camp_box_intersects_bounds(
                    placement_box,
                    bounds.left,
                    bounds.top,
                    bounds.right,
                    bounds.bottom,
                )
            });
        if door_collision_overlap {
            return true;
        }

        // The placer necessarily stands inside the new camp, so exclude only
        // that actor. Every other streamed body counts, including protected
        // NPCs, creatures, and corpses that still exist in the world.
        let occupied_actor_overlap = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|other| other.id != actor.id && other.area_id == actor.area_id)
            .any(|other| {
                let body = actor_hit_box_for_position(
                    other.position,
                    other.scale,
                    is_creature_body_actor(other),
                );
                camp_box_intersects_bounds(
                    placement_box,
                    body.left,
                    body.top,
                    body.right,
                    body.bottom,
                )
            });
        if occupied_actor_overlap {
            return true;
        }

        self.runtime
            .durable
            .placed_camps
            .values()
            .filter(|camp| camp.area_id == actor.area_id)
            .any(|camp| {
                let existing_box = placed_camp_shelter_box(camp);
                camp_boxes_intersect(placement_box, &existing_box)
            })
    }

    pub(super) fn apply_pack_up_camp(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        let camp = self
            .runtime
            .durable
            .placed_camps
            .values()
            .find(|camp| camp.owner_actor_id == actor.id)
            .cloned()
            .ok_or(AuthorityRejectReason::NoPlacedCamp)?;
        // Ownership is guaranteed by the find. Pack-up follows the rendered
        // 5x5 tent footprint centered on the streamed cell, not the unrelated
        // extractor point-blank radius or the unstreamed fine placement point.
        if !actor_inside_placed_camp_interaction_footprint(&actor, &camp) {
            return Err(AuthorityRejectReason::NotAtCamp);
        }
        self.runtime.durable.placed_camps.remove(&camp.camp_id);
        // single-use rule: the kit was consumed on placement, so pack-up returns
        // nothing — it strikes the camp and frees the one-per-player slot.
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} struck their scout camp", actor.id),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(())
    }

    pub(super) fn tick_placed_camps(&mut self) {
        if self.runtime.durable.placed_camps.is_empty() {
            return;
        }
        let tick = self.runtime.durable.tick;
        let grace_ticks = CAMP_ABANDONMENT_GRACE_SECONDS
            .saturating_mul(u64::from(self.runtime.durable.world.tick_rate_hz.max(1)));
        let camp_ids = self
            .runtime
            .durable
            .placed_camps
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut expired = Vec::new();
        for camp_id in &camp_ids {
            let (present, grace_bonus_ticks) = {
                let Some(camp) = self.runtime.durable.placed_camps.get(camp_id) else {
                    continue;
                };
                (
                    self.owner_present_at_camp(camp),
                    // Campcraft grace bonus (owner's) stacks on the base at arm-time, folded
                    // INTO teardown_tick (the existing hashed field) — no new hashed field.
                    self.camp_owner_campcraft_grace_bonus_seconds(camp)
                        .saturating_mul(u64::from(self.runtime.durable.world.tick_rate_hz.max(1))),
                )
            };
            let Some(camp) = self.runtime.durable.placed_camps.get_mut(camp_id) else {
                continue;
            };
            if present {
                // Returning (or never leaving) resets the timer: persists forever.
                camp.teardown_tick = None;
            } else {
                match camp.teardown_tick {
                    // First absent tick arms the grace deadline from now (base + campcraft).
                    None => {
                        camp.teardown_tick =
                            Some(tick.saturating_add(grace_ticks.saturating_add(grace_bonus_ticks)))
                    }
                    // More than the grace period while still absent -> tear down.
                    Some(deadline) if tick > deadline => expired.push(camp_id.clone()),
                    // Counting down; leave the armed deadline untouched.
                    Some(_) => {}
                }
            }
        }
        for camp_id in expired {
            if let Some(removed) = self.runtime.durable.placed_camps.remove(&camp_id) {
                self.record_timeline_event(TimelineEventSnapshot {
                    tick,
                    label: format!(
                        "{}'s scout camp collapsed (abandoned)",
                        removed.owner_actor_id
                    ),
                    cell: Some(CellSnapshot::new(removed.cell.x, removed.cell.y)),
                });
            }
        }
    }

    /// Owner's scout campcraft grace bonus (seconds), added to the 10-min base at arm-time.
    /// 0 for a non-scout / non-campcraft owner, so the base floor stays EXACT (invariant 1).
    fn camp_owner_campcraft_grace_bonus_seconds(&self, camp: &PlacedCampState) -> u64 {
        self.runtime
            .durable
            .actors
            .get(&camp.owner_actor_id)
            .map(|owner| owner.professions.scout_campcraft_grace_bonus_seconds())
            .unwrap_or(0)
    }

    /// Field Rest: each camp OWNER present in their OWN camp maps to their health/action
    /// regen multiplier (>1000). Owners with no campcraft bonus (mult <= 1000) are omitted
    /// so `tick_passive_regen` leaves everyone else at the neutral x1.0. Rest requires
    /// physically occupying the camp's placement-validated shelter footprint; the wider
    /// abandonment-presence radius remains a distinct lifecycle rule.
    pub(super) fn field_rest_mult_by_owner_in_camp(&self) -> BTreeMap<String, i32> {
        let mut out: BTreeMap<String, i32> = BTreeMap::new();
        for camp in self.runtime.durable.placed_camps.values() {
            let Some(owner) = self.runtime.durable.actors.get(&camp.owner_actor_id) else {
                continue;
            };
            let mult = owner.professions.scout_campcraft_field_rest_mult_milli();
            if mult <= 1_000 {
                continue;
            }
            // The owner always benefits at their own camp.
            record_field_rest_if_in_camp(&mut out, owner, camp, mult);
            // Master Scout capstone: the camp becomes GROUP-SHARED rest — groupmates present
            // in the camp gain the same Field Rest multiplier (the social capstone aura).
            if owner.professions.is_master(AuthorityProfessionKind::Scout) {
                if let Some(group_id) = self.actor_group_id(&owner.id) {
                    if let Some(group) = self.runtime.durable.groups.get(&group_id) {
                        for member_id in &group.member_actor_ids {
                            if member_id == &owner.id {
                                continue;
                            }
                            if let Some(member) = self.runtime.durable.actors.get(member_id) {
                                record_field_rest_if_in_camp(&mut out, member, camp, mult);
                            }
                        }
                    }
                }
            }
        }
        out
    }

    fn owner_present_at_camp(&self, camp: &PlacedCampState) -> bool {
        let Some(owner) = self.runtime.durable.actors.get(&camp.owner_actor_id) else {
            return false;
        };
        owner.area_id == camp.area_id
            && position_distance_milli(owner.position, camp.position)
                <= CAMP_PRESENCE_RADIUS_MILLI_CELLS
    }

    fn camp_in_interest(
        &self,
        observer: &ActorAuthorityState,
        camp: &PlacedCampState,
        radius_cells: i32,
    ) -> bool {
        if observer.area_id != camp.area_id {
            return false;
        }
        if camp.owner_actor_id == observer.id {
            return true;
        }
        let radius_milli = radius_cells.max(0).saturating_mul(MILLI_CELLS_PER_CELL);
        position_distance_milli(observer.position, camp.position) <= radius_milli
    }

    fn placed_camp_snapshot_from_state(
        &self,
        camp: &PlacedCampState,
        observer: Option<&ActorAuthorityState>,
    ) -> AuthorityPlacedCampSnapshot {
        let is_owner = observer.is_some_and(|actor| actor.id == camp.owner_actor_id);
        // Armed-teardown countdown, computed for ANY observer: the live shard
        // exports tick snapshots under a synthetic observer (never the owner),
        // so owner-gating HERE would starve the wire permanently. The owner-only
        // contract holds at the SHARD boundary instead (placedCampsForArea
        // redacts it for non-owning sessions, mirroring the ownerActorId strip).
        let abandon_seconds_remaining = camp.teardown_tick.map(|deadline| {
            deadline.saturating_sub(self.runtime.durable.tick)
                / u64::from(self.runtime.durable.world.tick_rate_hz.max(1))
        });
        AuthorityPlacedCampSnapshot {
            camp_id: camp.camp_id.clone(),
            owner_actor_id: camp.owner_actor_id.clone(),
            area_id: camp.area_id.clone(),
            cell_x: camp.cell.x,
            cell_y: camp.cell.y,
            is_owner,
            render_kind: CAMP_RENDER_KIND.to_owned(),
            abandon_seconds_remaining,
        }
    }
}

/// Record `mult` for `actor` if they occupy `camp`'s placement-validated shelter footprint,
/// keeping the strongest multiplier if two camps overlap. Shared by the owner and (for a
/// Master Scout) their groupmates.
fn record_field_rest_if_in_camp(
    out: &mut BTreeMap<String, i32>,
    actor: &ActorAuthorityState,
    camp: &PlacedCampState,
    mult: i32,
) {
    if actor_inside_placed_camp_shelter(actor, camp) {
        out.entry(actor.id.clone())
            .and_modify(|existing| *existing = (*existing).max(mult))
            .or_insert(mult);
    }
}

/// Resolve the immutable footprint captured at placement. Old checkpoints did
/// not persist it, so their safest deterministic compatibility behavior is the
/// base 5x5 footprint, never the owner's mutable current training.
fn placed_camp_shelter_half_extent_milli_cells(camp: &PlacedCampState) -> i32 {
    camp.shelter_half_extent_milli_cells
        .unwrap_or(CAMP_SHELTER_HALF_EXTENT_MILLI_CELLS)
}

fn placed_camp_shelter_box(camp: &PlacedCampState) -> AuthorityWeatherShelterBox {
    camp_shelter_box(
        camp.position,
        placed_camp_shelter_half_extent_milli_cells(camp),
    )
}

fn actor_inside_placed_camp_shelter(actor: &ActorAuthorityState, camp: &PlacedCampState) -> bool {
    if actor.area_id != camp.area_id {
        return false;
    }
    let shelter = placed_camp_shelter_box(camp);
    actor.position.x >= shelter.min_x_milli
        && actor.position.x <= shelter.max_x_milli
        && actor.position.y >= shelter.min_y_milli
        && actor.position.y <= shelter.max_y_milli
}

/// Pack-up uses the same cell-centered 5x5 AABB the client renders and can
/// derive from the placed-camp snapshot. Weather shelter remains centered on
/// the exact placement position; this helper is intentionally interaction-only.
fn actor_inside_placed_camp_interaction_footprint(
    actor: &ActorAuthorityState,
    camp: &PlacedCampState,
) -> bool {
    if actor.area_id != camp.area_id {
        return false;
    }
    let center = AuthorityPosition {
        x: camp
            .cell
            .x
            .saturating_mul(MILLI_CELLS_PER_CELL)
            .saturating_add(MILLI_CELLS_PER_CELL / 2),
        y: camp
            .cell
            .y
            .saturating_mul(MILLI_CELLS_PER_CELL)
            .saturating_add(MILLI_CELLS_PER_CELL / 2),
    };
    let footprint = camp_shelter_box(center, CAMP_SHELTER_HALF_EXTENT_MILLI_CELLS);
    actor.position.x >= footprint.min_x_milli
        && actor.position.x <= footprint.max_x_milli
        && actor.position.y >= footprint.min_y_milli
        && actor.position.y <= footprint.max_y_milli
}

/// Square shelter AABB centered on the camp position, shelter-house scale.
pub(super) fn camp_shelter_box(
    position: AuthorityPosition,
    half_extent_milli: i32,
) -> AuthorityWeatherShelterBox {
    AuthorityWeatherShelterBox {
        min_x_milli: position.x.saturating_sub(half_extent_milli),
        min_y_milli: position.y.saturating_sub(half_extent_milli),
        max_x_milli: position.x.saturating_add(half_extent_milli),
        max_y_milli: position.y.saturating_add(half_extent_milli),
    }
}

fn camp_box_fits_area(camp: &AuthorityWeatherShelterBox, area: &AreaAuthorityState) -> bool {
    let max_x = i32::try_from(area.width)
        .unwrap_or(i32::MAX / MILLI_CELLS_PER_CELL)
        .saturating_mul(MILLI_CELLS_PER_CELL);
    let max_y = i32::try_from(area.height)
        .unwrap_or(i32::MAX / MILLI_CELLS_PER_CELL)
        .saturating_mul(MILLI_CELLS_PER_CELL);
    camp.min_x_milli >= 0
        && camp.min_y_milli >= 0
        && camp.max_x_milli <= max_x
        && camp.max_y_milli <= max_y
}

fn camp_box_intersects_bounds(
    camp: &AuthorityWeatherShelterBox,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
) -> bool {
    camp.min_x_milli < right
        && camp.max_x_milli > left
        && camp.min_y_milli < bottom
        && camp.max_y_milli > top
}

fn camp_boxes_intersect(
    left: &AuthorityWeatherShelterBox,
    right: &AuthorityWeatherShelterBox,
) -> bool {
    camp_box_intersects_bounds(
        left,
        right.min_x_milli,
        right.min_y_milli,
        right.max_x_milli,
        right.max_y_milli,
    )
}

/// Weather exemption: is the actor standing inside one of its area's camp boxes?
/// Reuses the `AuthorityWeatherShelterBox` geometry so camps and prop shelters
/// exempt identically.
pub(super) fn actor_inside_camp_shelter(
    actor: &ActorAuthorityState,
    camp_shelters: &[(String, AuthorityWeatherShelterBox)],
) -> bool {
    camp_shelters.iter().any(|(area_id, shelter)| {
        *area_id == actor.area_id
            && actor.position.x >= shelter.min_x_milli
            && actor.position.x <= shelter.max_x_milli
            && actor.position.y >= shelter.min_y_milli
            && actor.position.y <= shelter.max_y_milli
    })
}

// Scout camp: placeable field shelter (earlier sandbox design scout/ranger lineage). Sibling of
// PlacedExtractorState; logic lives in authority/camps.rs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlacedCampState {
    pub(super) camp_id: String,
    pub(super) owner_actor_id: String,
    pub(super) area_id: String,
    pub(super) cell: AuthorityCell,
    pub(super) position: AuthorityPosition,
    pub(super) placed_at_tick: u64,
    /// The shelter footprint that passed placement validation. Legacy v1
    /// checkpoints predate this field; `None` materializes as the base camp
    /// footprint rather than re-reading the owner's current skill boxes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) shelter_half_extent_milli_cells: Option<i32>,
    #[serde(default)]
    pub(super) teardown_tick: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityPlacedCampSnapshot {
    pub camp_id: String,
    pub owner_actor_id: String,
    pub area_id: String,
    pub cell_x: i32,
    pub cell_y: i32,
    pub is_owner: bool,
    pub render_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abandon_seconds_remaining: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityPlacedCampsDeltaPayload {
    pub schema: String,
    pub tick: u64,
    pub placed_camps: Vec<AuthorityPlacedCampSnapshot>,
}
