//! Connected-mode projection: rebuild the live [`WindowModel`] player-scoped
//! sections from the accepted [`AuthorityStore`] after each snapshot/delta.
//!
//! Rebuilds are wholesale (fresh vectors decoded from the wire-shaped store
//! values), so a present-but-empty wire section clears the prior rows instead
//! of merging into them, and an absent player actor clears the player
//! summaries. No sample data and no inferred quantities: every field either
//! decodes from the store, comes from the explicit [`ProjectContext`] the
//! world layer resolves (terminal reach, selection, loot target), or stays at
//! its typed `Default` — a missing context keeps the matching gate closed.

use serde::Deserialize;
use serde_json::Value;
use successor_client_proto::packets::GameActorSnapshot;

use crate::game::authority::AuthorityStore;
use crate::hud::{clean_actor_name, sanitize_text, weapon_display_name};

use super::model::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressionSpec {
    professions: std::collections::HashMap<String, String>,
    skill_nodes: Vec<ProgressionNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressionNode {
    id: String,
    profession: String,
    label: String,
    #[serde(default)]
    row: u8,
    #[serde(default)]
    column: u8,
    #[serde(default)]
    xp_cost: i64,
    #[serde(default)]
    skill_point_cost: i64,
    #[serde(default)]
    credit_cost: i64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    grants: Vec<String>,
    #[serde(default)]
    prerequisites: Vec<String>,
}

static PROGRESSION_SPEC: std::sync::LazyLock<ProgressionSpec> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../../client/src/slice-core/specs/progression.v1.json"
    ))
    .expect("checked-in progression spec validates")
});

fn progression_spec() -> &'static ProgressionSpec {
    &PROGRESSION_SPEC
}

fn same_skill_id(left: &str, right: &str) -> bool {
    left.replace('_', "-") == right.replace('_', "-")
}

/// Decode every wire row in `values` as `T`. A row that does not decode is
/// skipped so one malformed value never poisons the rest of the projection.
fn decode_rows<T: serde::de::DeserializeOwned>(values: &[Value]) -> Vec<T> {
    values
        .iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect()
}

/// Decode an optional wire section; `None`/null/malformed all project `None`.
fn decode_opt<T: serde::de::DeserializeOwned>(value: Option<&Value>) -> Option<T> {
    value.and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// World-layer context the store cannot know: terminal/kiosk reach, the
/// current selection, loot target, checked-in catalog joins, and the host
/// command queue's pending envelopes. Everything defaults to "absent" — a
/// default context projects honest closed gates, never a fake open one.
#[derive(Clone, Debug, Default)]
pub struct ProjectContext {
    /// Planet the active shard hosts (launch/session scope).
    pub planet_id: String,
    /// Selected actor id (trade proposal, group invite, duel, examine).
    pub selected_actor_id: Option<String>,
    /// Player corpse the world layer opened for looting.
    pub loot_corpse_id: Option<String>,
    /// Examined prop `(prop id, label)`.
    pub examine_prop: Option<(String, String)>,
    /// Terminal/kiosk gates resolved from world prop reach.
    pub bank_gate: Gate,
    pub clone_gate: Gate,
    pub factory_gate: Gate,
    pub guild_gate: Gate,
    pub travel_gate: Gate,
    /// Origin terminal `(planet id, city id)` when a travel terminal is linked.
    pub travel_origin: Option<(String, String)>,
    /// Checked-in travel chart (world/asset join, not authority state).
    pub travel_planets: Vec<TravelPlanet>,
    /// In-range trainer NPC (skills / converse / starter tool).
    pub trainer: Option<TrainerView>,
    /// Trainer-offered career goals `(goal id, label)` from checked-in scripts.
    pub career_goals: Vec<(String, String)>,
    /// Checked-in build catalog + world-computed ghost preview.
    pub build_catalog: Vec<BuildCatalogItem>,
    pub build_ghost: Option<BuildGhost>,
    /// Host queue pending envelopes `(command id, kind)` for receipt joins.
    pub pending: Vec<(u64, String)>,
    /// Monotonic UI clock (ms) stamping newly observed receipts.
    pub now_ms: f64,
}

/// A closed gate with no note carries the shared reference copy.
fn gate_or(gate: &Gate, closed_note: &str) -> Gate {
    if !gate.available && gate.note.is_empty() {
        Gate::closed(closed_note)
    } else {
        gate.clone()
    }
}

fn actor_label(a: &GameActorSnapshot) -> String {
    clean_actor_name(&a.display_name, &a.label, &a.id).to_uppercase()
}

fn is_player_actor(a: &GameActorSnapshot) -> bool {
    a.role.as_deref() == Some("player")
}

fn upper(row: &InventoryRow) -> String {
    row.item.to_ascii_uppercase()
}

fn key_of(row: &InventoryRow) -> &str {
    row.item_key.as_deref().unwrap_or("")
}

/// Rebuild the store-derived `WindowModel` sections. Call after applying a
/// network packet (NOT per frame). `player_id` is the launch fallback used
/// when the snapshot's `player_actor_id` has not resolved yet.
pub fn project(
    store: &AuthorityStore,
    player_id: &str,
    ctx: &ProjectContext,
    model: &mut WindowModel,
) {
    model.connected = true;
    model.tick = store.tick;

    let player = store
        .actors
        .get(&store.player_actor_id)
        .or_else(|| store.actors.get(player_id));
    let player_pos = player.map(|a| (a.x, a.y)).unwrap_or((0.0, 0.0));

    // Inventory: wholesale rebuild — a present-empty wire section projects to
    // zero rows, and player-scoped scalars clear when the actor is absent.
    model.inventory = InventoryModel {
        rows: decode_rows(&store.inventory),
        reservations: decode_rows(&store.reservations),
        credits: player.and_then(|a| a.credits).unwrap_or(0),
        weapon_label: player
            .and_then(|a| a.weapon.as_ref())
            .and_then(|w| w.weapon_id.as_deref())
            .map(weapon_display_name),
    };

    // Character sheet: absent player ⇒ cleared summary.
    let summary = player.map(player_summary).unwrap_or_default();
    model.character = CharacterModel {
        area_id: player
            .map(|a| sanitize_text(&a.area_id, 32).to_uppercase())
            .unwrap_or_default(),
        player: summary.clone(),
        // Spec-labelled earned titles join with the checked-in progression
        // spec in the skills slice; the active server title is always offered
        // so SELECT/CLEAR routes to `SetProfessionTitle` without invention.
        title_options: summary.active_title.iter().cloned().collect(),
        career_goal_label: summary.career_goal_id.clone(),
    };

    // Bank: owner-scoped snapshot + world-resolved kiosk gate.
    let bank_snapshot: Option<BankSnapshot> = decode_opt(store.bank.as_ref());
    model.bank = BankModel {
        gate: gate_or(&ctx.bank_gate, "AT BANK TERMINAL ONLY"),
        bank: bank_snapshot.clone(),
    };

    // Clone terminal: backup lives on the bank snapshot; life state is live.
    model.clone = CloneModel {
        gate: gate_or(&ctx.clone_gate, "AT CLONE TERMINAL ONLY"),
        backup_present: bank_snapshot
            .as_ref()
            .map(|b| b.backup_present)
            .unwrap_or(false),
        backup_saved_tick: bank_snapshot.as_ref().and_then(|b| b.backup_saved_tick),
        backup_skill_count: bank_snapshot
            .as_ref()
            .map(|b| b.backup_skill_count)
            .unwrap_or(0),
        backup_cost: bank_snapshot.as_ref().map(|b| b.backup_cost).unwrap_or(0),
        vault_credits: bank_snapshot.as_ref().map(|b| b.credits).unwrap_or(0),
        wallet_credits: summary.credits,
        dead: matches!(
            summary.life_state.as_str(),
            "dead" | "downed" | "incapacitated"
        ),
        clone_sickness_remaining_ms: summary.clone_sickness_remaining_ms,
    };

    // Loot: only the world-opened corpse projects; rows are the inventory
    // rows streamed for that corpse's container.
    model.loot = ctx.loot_corpse_id.as_deref().and_then(|cid| {
        let corpse = decode_rows::<PlayerCorpse>(&store.player_corpses)
            .into_iter()
            .find(|c| c.id == cid)?;
        let dx = corpse.x - player_pos.0;
        let dy = corpse.y - player_pos.1;
        let rows: Vec<InventoryRow> = model
            .inventory
            .rows
            .iter()
            .filter(|r| r.container == corpse.container)
            .cloned()
            .collect();
        Some(LootModel {
            kind: LootTargetKind::Corpse,
            target_id: corpse.id.clone(),
            container: corpse.container.clone(),
            label: format!(
                "CORPSE OF {}",
                sanitize_text(&corpse.owner_label, 32).to_uppercase()
            ),
            rows,
            credits_present: corpse.credits_present,
            credits_count: corpse.credits_count,
            in_reach: (dx * dx + dy * dy).sqrt() <= EXTRACTOR_REACH_CELLS,
            rights_mine: corpse.is_owner,
            harvest_actor_id: None,
        })
    });

    // Trade: streamed session + live offerable stacks + selected propose target.
    let trade_session: Option<TradeSession> = decode_opt(store.trade_session.as_ref());
    let partner_label = trade_session
        .as_ref()
        .map(|s| {
            store
                .actors
                .get(&s.partner_actor_id)
                .map(actor_label)
                .unwrap_or_else(|| sanitize_text(&s.partner_actor_id, 32).to_uppercase())
        })
        .unwrap_or_default();
    model.trade = TradeModel {
        session: trade_session,
        partner_label,
        offerable: model
            .inventory
            .rows
            .iter()
            .filter(|r| !r.in_exchange() && r.available > 0)
            .cloned()
            .collect(),
        propose_target: ctx
            .selected_actor_id
            .as_deref()
            .filter(|id| *id != summary.actor_id)
            .and_then(|id| store.actors.get(id))
            .filter(|a| is_player_actor(a) && a.life_state == "alive")
            .map(|a| (a.id.clone(), actor_label(a))),
    };

    // Craft: streamed session + drafted schematics + world gates.
    model.craft = CraftModel {
        session: decode_opt(store.craft_session.as_ref()),
        drafts: decode_rows(&store.drafted_schematics),
        factory: gate_or(&ctx.factory_gate, "AT FACTORY TERMINAL ONLY"),
        trainer_actor_id: ctx
            .trainer
            .as_ref()
            .filter(|t| t.in_range)
            .map(|t| t.actor_id.clone()),
    };

    // Survey / extraction / camps.
    let spawns: Vec<ResourceSpawn> = decode_rows(&store.resource_spawns);
    let mut families: Vec<SurveyFamilyOption> = Vec::new();
    for s in &spawns {
        if !families.iter().any(|f| f.family == s.family) {
            families.push(SurveyFamilyOption {
                family: s.family.clone(),
                label: sanitize_text(
                    if s.name.is_empty() {
                        &s.family
                    } else {
                        &s.name
                    },
                    28,
                )
                .to_uppercase(),
            });
        }
    }
    let extractors: Vec<ExtractorView> = decode_rows::<PlacedExtractor>(&store.placed_extractors)
        .into_iter()
        .map(|vm| {
            let dx = vm.cell_x as f32 - player_pos.0;
            let dy = vm.cell_y as f32 - player_pos.1;
            let distance = (dx * dx + dy * dy).sqrt();
            ExtractorView {
                distance,
                in_reach: distance <= EXTRACTOR_REACH_CELLS,
                vm,
            }
        })
        .collect();
    let camps: Vec<CampView> = decode_rows::<PlacedCamp>(&store.placed_camps)
        .into_iter()
        .map(|vm| {
            let dx = vm.cell_x as f32 - player_pos.0;
            let dy = vm.cell_y as f32 - player_pos.1;
            let distance = (dx * dx + dy * dy).sqrt();
            CampView {
                distance,
                in_footprint: distance <= CAMP_FOOTPRINT_CELLS,
                vm,
            }
        })
        .collect();
    model.survey = SurveyModel {
        families,
        results: decode_rows(&store.survey_results),
        sample_cooldown_ticks: (summary.next_sample_tick - store.tick as i64).max(0),
        spawns,
        own_camp_placed: camps.iter().any(|c| c.vm.is_owner),
        extractors,
        camps,
        batteries: model
            .inventory
            .rows
            .iter()
            .filter(|r| key_of(r).starts_with("battery") || upper(r).contains("BATTERY"))
            .cloned()
            .collect(),
    };

    // Skills: join the complete checked-in tree with live profession, budget,
    // trained-box, wallet, and in-range trainer state.
    let spec = progression_spec();
    let trainer_ready = ctx.trainer.as_ref().is_some_and(|trainer| trainer.in_range);
    let mut earned_titles = Vec::new();
    let professions = summary
        .professions
        .iter()
        .map(|profession| {
            let trained = |id: &str| {
                profession
                    .skill_boxes
                    .iter()
                    .any(|owned| same_skill_id(owned, id))
            };
            let mut boxes: Vec<SkillBoxView> = spec
                .skill_nodes
                .iter()
                .filter(|node| node.profession == profession.id)
                .map(|node| {
                    let is_trained = trained(&node.id);
                    if is_trained {
                        if let Some(title) = &node.title {
                            earned_titles.push(ProfessionTitle {
                                id: node.id.clone(),
                                label: title.clone(),
                                skill_box_id: node.id.clone(),
                            });
                        }
                    }
                    let prereqs_met = node.prerequisites.iter().all(|id| trained(id));
                    let enough_xp = profession.xp >= node.xp_cost;
                    let enough_points = summary.skill_points_used + node.skill_point_cost
                        <= summary.skill_points_cap;
                    let enough_credits = summary.credits >= node.credit_cost;
                    let trainer_matches = ctx.trainer.as_ref().is_some_and(|trainer| {
                        trainer.in_range
                            && (trainer.profession_id.is_empty()
                                || trainer.profession_id == profession.id)
                    });
                    let available = !is_trained
                        && prereqs_met
                        && enough_xp
                        && enough_points
                        && enough_credits
                        && trainer_matches;
                    let deny_reason = if is_trained || available {
                        String::new()
                    } else if !trainer_ready {
                        DENY_RANGE.into()
                    } else if !prereqs_met {
                        "PREREQUISITES NOT MET".into()
                    } else if !enough_xp {
                        "INSUFFICIENT PROFESSION XP".into()
                    } else if !enough_points {
                        "SKILL POINT CAP".into()
                    } else if !enough_credits {
                        "INSUFFICIENT CREDITS".into()
                    } else {
                        "WRONG PROFESSION TRAINER".into()
                    };
                    SkillBoxView {
                        id: node.id.clone(),
                        label: node.label.clone(),
                        row: node.row,
                        column: node.column,
                        xp_cost: node.xp_cost,
                        skill_point_cost: node.skill_point_cost,
                        credit_cost: node.credit_cost,
                        title: node.title.clone(),
                        grants: node.grants.clone(),
                        prerequisites: node.prerequisites.clone(),
                        trained: is_trained,
                        available,
                        deny_reason,
                    }
                })
                .collect();
            if boxes.is_empty() {
                boxes.extend(
                    profession
                        .skill_boxes
                        .iter()
                        .enumerate()
                        .map(|(index, id)| SkillBoxView {
                            id: id.clone(),
                            label: sanitize_text(id, 40)
                                .replace(['_', '-'], " ")
                                .to_uppercase(),
                            row: index as u8,
                            trained: true,
                            ..SkillBoxView::default()
                        }),
                );
            }
            ProfessionTreeView {
                id: profession.id.clone(),
                label: spec
                    .professions
                    .get(&profession.id)
                    .cloned()
                    .unwrap_or_else(|| profession.label.clone()),
                xp: profession.xp,
                boxes,
            }
        })
        .collect();
    if let Some(active) = &summary.active_title {
        if !earned_titles.iter().any(|title| title.id == active.id) {
            earned_titles.push(active.clone());
        }
    }
    model.character.title_options = earned_titles;
    model.skills = SkillsModel {
        professions,
        skill_points_used: summary.skill_points_used,
        skill_points_cap: summary.skill_points_cap,
        credits: summary.credits,
        trainer: ctx.trainer.clone(),
    };

    // Converse: streamed dialogue deliveries (bounded) + trainer context.
    let mut deliveries: Vec<DialogueDelivery> = decode_rows(&store.dialogue_deliveries);
    if deliveries.len() > 32 {
        let cut = deliveries.len() - 32;
        deliveries.drain(..cut);
    }
    model.converse = ConverseModel {
        npc: ctx.trainer.clone(),
        deliveries,
        career_goals: ctx.career_goals.clone(),
        teachable: model
            .skills
            .professions
            .iter()
            .flat_map(|profession| profession.boxes.iter())
            .filter(|skill| skill.available && !skill.trained)
            .cloned()
            .collect(),
        career_goal_id: summary.career_goal_id.clone(),
    };

    // Travel: held tickets are live inventory rows; chart/gate come from the
    // world layer (checked-in chart + origin terminal reach).
    model.travel = TravelModel {
        gate: gate_or(&ctx.travel_gate, "AT TRAVEL TERMINAL ONLY"),
        origin: ctx.travel_origin.clone(),
        planets: ctx.travel_planets.clone(),
        tickets: model
            .inventory
            .rows
            .iter()
            .filter(|r| r.is_travel_ticket())
            .cloned()
            .collect(),
        wallet_credits: summary.credits,
    };

    // Player association (guild).
    model.pa = PaModel {
        gate: gate_or(&ctx.guild_gate, "AT PA TERMINAL ONLY"),
        view: decode_opt(store.guilds.as_ref()).unwrap_or_default(),
        my_actor_id: summary.actor_id.clone(),
        wallet_credits: summary.credits,
        target: ctx
            .selected_actor_id
            .as_deref()
            .filter(|id| *id != summary.actor_id)
            .and_then(|id| store.actors.get(id))
            .filter(|actor| is_player_actor(actor))
            .map(|actor| (actor.id.clone(), actor_label(actor))),
    };

    // Groups / duels.
    let duel: DuelView = decode_opt(store.duels.as_ref()).unwrap_or_default();
    model.group = GroupModel {
        my_actor_id: summary.actor_id.clone(),
        group: decode_opt(store.groups.as_ref()).unwrap_or_default(),
        deathblow_target: duel
            .active_duel
            .as_ref()
            .and_then(|d| store.actors.get(&d.opponent_actor_id))
            .filter(|a| matches!(a.life_state.as_str(), "downed" | "incapacitated"))
            .map(|a| (a.id.clone(), actor_label(a))),
        duel,
        outcomes: decode_rows(&store.duel_outcomes),
        target: ctx
            .selected_actor_id
            .as_deref()
            .filter(|id| *id != summary.actor_id)
            .and_then(|id| store.actors.get(id))
            .map(|a| (a.id.clone(), actor_label(a), is_player_actor(a))),
    };

    // Farming: parcels/plots stream whole; seed/fertilizer/structure stacks
    // are live inventory candidates (authority re-validates every verb).
    model.farm = FarmModel {
        parcels: decode_rows(&store.placed_parcels),
        plots: decode_rows(&store.farm_plots),
        seeds: model
            .inventory
            .rows
            .iter()
            .filter(|r| key_of(r).starts_with("seed") || upper(r).contains("SEED"))
            .cloned()
            .collect(),
        fertilizers: model
            .inventory
            .rows
            .iter()
            .filter(|r| {
                key_of(r).contains("fertilizer")
                    || upper(r).contains("FERTILIZER")
                    || upper(r).contains("COMPOST")
            })
            .cloned()
            .collect(),
        structures: model
            .inventory
            .rows
            .iter()
            .filter(|r| {
                key_of(r).starts_with("farm_")
                    || upper(r).contains("SPRINKLER")
                    || upper(r).contains("SCARECROW")
            })
            .cloned()
            .collect(),
        player_cell: (player_pos.0.floor() as i64, player_pos.1.floor() as i64),
        area_id: player.map(|a| a.area_id.clone()).unwrap_or_default(),
        planet_id: ctx.planet_id.clone(),
    };

    // Construction: live components + owned-parcel gate; the catalog and the
    // ghost preview are world-layer joins.
    let building: BuildingProjection = decode_opt(store.building.as_ref()).unwrap_or_default();
    let player_cell = model.farm.player_cell;
    let mut materials: Vec<(String, i64)> = Vec::new();
    for r in model
        .inventory
        .rows
        .iter()
        .filter(|r| r.resource_stats.is_some())
    {
        let id = r
            .item_key
            .clone()
            .unwrap_or_else(|| r.item.to_ascii_lowercase());
        match materials.iter_mut().find(|(m, _)| *m == id) {
            Some((_, n)) => *n += r.available,
            None => materials.push((id, r.available)),
        }
    }
    let mut components = building.components;
    components.sort_by(|a, b| {
        let da = (a.cell_x - player_cell.0).pow(2) + (a.cell_y - player_cell.1).pow(2);
        let db = (b.cell_x - player_cell.0).pow(2) + (b.cell_y - player_cell.1).pow(2);
        da.cmp(&db)
    });
    model.build = BuildModel {
        parcel: model
            .farm
            .parcels
            .iter()
            .find(|p| {
                p.is_owner
                    && player_cell.0 >= p.rect.x
                    && player_cell.0 < p.rect.x + p.rect.w
                    && player_cell.1 >= p.rect.y
                    && player_cell.1 < p.rect.y + p.rect.h
            })
            .cloned(),
        catalog: ctx.build_catalog.clone(),
        materials,
        ghost: ctx.build_ghost.clone(),
        components,
    };

    // Bioengineering: streamed session/scans + live genome-bearing stacks.
    model.splice = SpliceModel {
        session: decode_opt(store.splice_session.as_ref()),
        scans: decode_rows(&store.genome_scans),
        samples: model
            .inventory
            .rows
            .iter()
            .filter(|r| {
                r.metadata
                    .as_ref()
                    .map(|m| m.get("genome").is_some())
                    .unwrap_or(false)
            })
            .cloned()
            .collect(),
        sample_target: None,
    };

    // Examine: current selection joined against the live actor set.
    model.examine = ExamineModel {
        actor: ctx
            .selected_actor_id
            .as_deref()
            .and_then(|id| store.actors.get(id))
            .map(|a| ExamineActor {
                actor_id: a.id.clone(),
                name: actor_label(a),
                descriptor: a
                    .descriptor
                    .as_deref()
                    .map(|d| sanitize_text(d, 96))
                    .unwrap_or_default(),
                life_state: a.life_state.clone(),
                faction_id: a.faction_id.clone(),
                pvp_status: a.pvp_status.clone().unwrap_or_default(),
                organization_tag: a.player_organization_tag.clone(),
                health: a.vitals.health,
                health_max: a.max_vitals.health,
            }),
        item: None,
        prop: ctx.examine_prop.clone(),
    };

    // Receipts: pending kinds from the host queue; the last receipt keeps its
    // first-observed timestamp so the reference status flash can expire.
    let prev = model.receipts.last.clone();
    model.receipts = ReceiptsModel {
        pending_kinds: ctx.pending.iter().map(|(_, k)| k.clone()).collect(),
        last: store.last_receipt.as_ref().map(|r| {
            let carried = prev.as_ref().filter(|p| p.command_id == r.command_id);
            ReceiptView {
                command_id: r.command_id,
                kind: ctx
                    .pending
                    .iter()
                    .find(|(id, _)| *id == r.command_id)
                    .map(|(_, k)| k.clone())
                    .or_else(|| carried.map(|p| p.kind.clone()))
                    .unwrap_or_default(),
                accepted: r.accepted,
                reason_code: r.reason_code.clone(),
                at_ms: carried.map(|p| p.at_ms).unwrap_or(ctx.now_ms),
            }
        }),
    };

    model.player = summary;
}

/// Decode the typed player actor into the window-facing summary. Fields the
/// typed snapshot does not carry stay `Default` — joined in by their owning
/// slices, not guessed.
fn player_summary(a: &GameActorSnapshot) -> PlayerSummary {
    PlayerSummary {
        actor_id: a.id.clone(),
        name: clean_actor_name(&a.display_name, &a.label, &a.id).to_uppercase(),
        health: a.vitals.health,
        health_max: a.max_vitals.health,
        action: a.vitals.action,
        action_max: a.max_vitals.action,
        life_state: a.life_state.clone(),
        posture: a.posture.clone().unwrap_or_default(),
        credits: a.credits.unwrap_or(0),
        faction_id: a.faction_id.clone(),
        pvp_status: a.pvp_status.clone().unwrap_or_default(),
        professions: decode_rows(&a.professions),
        active_title: a
            .active_title
            .as_ref()
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
        career_goal_id: a.career_goal_id.clone(),
        skill_points_used: a.skill_points_used.unwrap_or(0),
        skill_points_cap: a.skill_points_cap.unwrap_or(0),
        weapon: a.weapon.as_ref().map(|w| WeaponState {
            weapon_id: w.weapon_id.clone().unwrap_or_default(),
            reload_remaining_ticks: w.reload_remaining_ticks.unwrap_or(0),
            ..WeaponState::default()
        }),
        shield: a
            .personal_shield
            .as_ref()
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
        statuses: decode_rows(&a.statuses),
        in_combat: a.in_combat.unwrap_or(false),
        clone_sickness_remaining_ms: a.clone_sickness_remaining_ms.unwrap_or(0),
        next_sample_tick: a.next_sample_tick.unwrap_or(0),
        worn: a.worn.iter().filter_map(|w| w.item_id.clone()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use successor_client_proto::packets::{
        GameActorVitals, GameActorWeapon, GameShardDelta, GameShardSnapshot,
    };

    fn live_snapshot() -> GameShardSnapshot {
        let mut s = GameShardSnapshot {
            tick: 41,
            player_actor_id: "actor-1".into(),
            ..Default::default()
        };
        s.actors.insert(
            "actor-1".into(),
            GameActorSnapshot {
                id: "actor-1".into(),
                display_name: "Vett Marr".into(),
                area_id: "open-desert".into(),
                life_state: "alive".into(),
                lifecycle_seq: 1,
                x: 10.0,
                y: 10.0,
                vitals: GameActorVitals {
                    health: 80.0,
                    action: 55.0,
                    spirit: 10.0,
                },
                max_vitals: GameActorVitals {
                    health: 100.0,
                    action: 100.0,
                    spirit: 100.0,
                },
                credits: Some(1250),
                weapon: Some(GameActorWeapon {
                    weapon_id: Some("weapon_slugthrower_mk2".into()),
                    reload_remaining_ticks: Some(0),
                }),
                professions: vec![json!({
                    "id": "prospector",
                    "label": "PROSPECTOR",
                    "xp": 320,
                    "skillBoxes": ["prospector_novice"]
                })],
                ..Default::default()
            },
        );
        // Exact wire shape (`GameInventoryRow`: numeric stackId, camelCase).
        s.inventory = vec![
            json!({
                "container": "actor-1",
                "stackId": 7,
                "item": "Slug Rounds",
                "itemId": 12,
                "variantId": 0,
                "quantity": 40,
                "reserved": 0,
                "available": 40
            }),
            json!({
                "container": "actor-1",
                "stackId": 8,
                "item": "Field Medkit",
                "itemId": 31,
                "variantId": 0,
                "quantity": 2,
                "reserved": 1,
                "available": 1
            }),
        ];
        s.reservations = vec![json!({
            "id": 3,
            "actor": "actor-1",
            "purpose": "craft",
            "from": "actor-1",
            "item": "Field Medkit",
            "quantity": 1
        })];
        s
    }

    fn project_default(store: &AuthorityStore, model: &mut WindowModel) {
        project(store, "actor-1", &ProjectContext::default(), model);
    }

    #[test]
    fn snapshot_projects_live_inventory_and_character() {
        let mut store = AuthorityStore::new();
        store.apply_snapshot(&live_snapshot());
        let mut model = WindowModel::default();
        project_default(&store, &mut model);

        assert!(model.connected);
        assert_eq!(model.tick, 41);
        assert_eq!(model.inventory.rows.len(), 2);
        assert_eq!(model.inventory.rows[0].stack_id, "7");
        assert_eq!(model.inventory.rows[0].item, "Slug Rounds");
        assert_eq!(model.inventory.rows[0].quantity, 40);
        assert_eq!(model.inventory.reservations.len(), 1);
        assert_eq!(model.inventory.credits, 1250);
        assert_eq!(
            model.inventory.weapon_label.as_deref(),
            Some("SLUGTHROWER MK2")
        );

        assert_eq!(model.character.player.name, "VETT MARR");
        assert_eq!(model.character.player.credits, 1250);
        assert_eq!(model.character.player.health, 80.0);
        assert_eq!(model.character.player.health_max, 100.0);
        assert_eq!(model.character.area_id, "OPEN-DESERT");
        assert_eq!(model.character.player.professions.len(), 1);
        assert_eq!(model.character.player.professions[0].label, "PROSPECTOR");
        assert_eq!(model.player.actor_id, "actor-1");
        // Trained skill boxes surface without a spec join.
        assert_eq!(model.skills.professions.len(), 1);
        assert!(model.skills.professions[0].boxes[0].trained);
    }

    #[test]
    fn present_empty_inventory_clears_rows() {
        let mut store = AuthorityStore::new();
        store.apply_snapshot(&live_snapshot());
        let mut model = WindowModel::default();
        project_default(&store, &mut model);
        assert_eq!(model.inventory.rows.len(), 2);

        // Present-but-empty delta sections mean "clear", not "unchanged".
        let d = GameShardDelta {
            tick: 42,
            inventory: Some(Vec::new()),
            reservations: Some(Vec::new()),
            ..Default::default()
        };
        store.apply_delta(&d);
        project_default(&store, &mut model);
        assert!(model.inventory.rows.is_empty());
        assert!(model.inventory.reservations.is_empty());
        // Player still live: scalars persist.
        assert_eq!(model.inventory.credits, 1250);
    }

    #[test]
    fn absent_player_clears_summaries() {
        let mut store = AuthorityStore::new();
        store.apply_snapshot(&live_snapshot());
        let mut model = WindowModel::default();
        project_default(&store, &mut model);

        let mut d = GameShardDelta {
            tick: 43,
            ..Default::default()
        };
        d.actor_removals.push("actor-1".into());
        store.apply_delta(&d);
        project_default(&store, &mut model);

        assert_eq!(model.inventory.credits, 0);
        assert!(model.inventory.weapon_label.is_none());
        assert!(model.character.player.name.is_empty());
        assert!(model.character.area_id.is_empty());
        assert!(model.skills.professions.is_empty());
    }

    #[test]
    fn malformed_row_is_skipped_not_poisoning() {
        let mut store = AuthorityStore::new();
        let mut s = live_snapshot();
        s.inventory.push(json!("not-a-row"));
        store.apply_snapshot(&s);
        let mut model = WindowModel::default();
        project_default(&store, &mut model);
        assert_eq!(model.inventory.rows.len(), 2);
    }

    #[test]
    fn sections_project_and_clear_from_live_store() {
        let mut store = AuthorityStore::new();
        let mut s = live_snapshot();
        s.bank = Some(json!({
            "credits": 5000,
            "items": [],
            "backupPresent": true,
            "backupSavedTick": 12,
            "backupSkillCount": 4,
            "backupCost": 250
        }));
        // Trade sessions arrive as targeted room messages, not snapshot fields.
        let trade_payload = json!({
            "proposalId": 9,
            "partnerActorId": "actor-2",
            "mine": { "actorId": "actor-1", "items": [], "coin": 0, "locked": false, "confirmed": false },
            "theirs": { "actorId": "actor-2", "items": [], "coin": 50, "locked": false, "confirmed": false },
            "bothLocked": false,
            "stage": "negotiating",
            "tick": 41
        });
        s.guilds = Some(json!({
            "guild": { "id": "g1", "name": "Dust Legion", "tag": "DL", "leaderActorId": "actor-1", "memberCount": 2, "wars": [] },
            "roster": [
                { "actorId": "actor-1", "name": "Vett", "role": "leader", "permissions": [], "online": true }
            ],
            "pendingInvites": [],
            "directory": []
        }));
        s.groups = Some(json!({
            "group": { "groupId": 3, "leaderActorId": "actor-1", "memberActorIds": ["actor-1"] },
            "members": [],
            "pendingInvite": null
        }));
        s.duels = Some(
            json!({ "activeDuel": null, "incomingChallenge": null, "outgoingChallenge": null }),
        );
        s.placed_parcels = vec![json!({
            "parcelId": "parcel:1",
            "planetId": "korvath",
            "areaId": "open-desert",
            "name": "HOMESTEAD",
            "rect": { "x": 8, "y": 8, "w": 8, "h": 8 },
            "tier": "basic",
            "isOwner": true,
            "tilledTiles": 1,
            "plantedTiles": 0
        })];
        s.building = Some(json!({
            "schema": "successor.authority-building.v1",
            "tick": 41,
            "components": [{
                "componentId": "b1",
                "ownerActorId": "actor-1",
                "parcelId": "parcel:1",
                "catalogId": "wall_basic",
                "kind": "wall",
                "cellX": 9,
                "cellY": 9,
                "rotationQuarters": 0,
                "doorOpen": false
            }]
        }));
        let splice_payload = json!({
            "phase": "slots",
            "speciesId": 2,
            "speciesName": "Dune Creeper",
            "slots": [],
            "lines": [],
            "assemblyQualityMilli": 0,
            "pointsTotal": 4,
            "pointsRemaining": 4,
            "canAssemble": false,
            "tick": 41
        });
        s.placed_extractors = vec![json!({
            "extractorId": "ex1",
            "areaId": "open-desert",
            "cellX": 10,
            "cellY": 11,
            "mode": "manual",
            "biome": "desert",
            "hopperPct": 40.0,
            "collectableUnits": 4,
            "batteryPct": 0.0,
            "isOwner": true,
            "familyLabel": "FERROUS"
        })];
        store.apply_snapshot(&s);
        store.apply_room_message("tradeSession", &trade_payload);
        store.apply_room_message("spliceSession", &splice_payload);

        let mut model = WindowModel::default();
        project_default(&store, &mut model);

        let bank = model.bank.bank.as_ref().expect("bank snapshot");
        assert_eq!(bank.credits, 5000);
        assert!(bank.backup_present);
        // A default context keeps world gates honestly closed with a reason.
        assert!(!model.bank.gate.available);
        assert!(!model.bank.gate.note.is_empty());
        assert!(model.clone.backup_present);
        assert_eq!(model.clone.vault_credits, 5000);

        let trade = model.trade.session.as_ref().expect("trade session");
        assert_eq!(trade.proposal_id, 9);
        assert_eq!(trade.theirs.coin, 50);
        assert_eq!(model.trade.offerable.len(), 2);

        assert_eq!(model.pa.view.guild.as_ref().unwrap().tag, "DL");
        assert_eq!(model.pa.my_actor_id, "actor-1");
        assert!(model.group.group.group.is_some());
        assert!(model.group.is_leader());

        assert_eq!(model.farm.parcels.len(), 1);
        assert_eq!(model.build.components.len(), 1);
        assert!(
            model.build.parcel.is_some(),
            "player stands in owned parcel"
        );

        assert_eq!(
            model.splice.session.as_ref().unwrap().species_name,
            "Dune Creeper"
        );
        assert_eq!(model.survey.extractors.len(), 1);
        assert!(
            model.survey.extractors[0].in_reach,
            "extractor one cell away is in point-blank reach"
        );

        // A null targeted session payload clears the projected session.
        store.apply_room_message("tradeSession", &Value::Null);
        project_default(&store, &mut model);
        assert!(model.trade.session.is_none(), "present-null clears session");
    }

    #[test]
    fn receipts_join_pending_kinds_and_keep_first_timestamp() {
        let mut store = AuthorityStore::new();
        store.apply_snapshot(&live_snapshot());
        store.last_receipt = Some(successor_client_proto::packets::GameCommandReceipt {
            command_id: 77,
            accepted: false,
            tick: 41,
            reason_code: Some("insufficient_funds".into()),
        });

        let mut model = WindowModel::default();
        let ctx = ProjectContext {
            pending: vec![(77, "BankWithdrawCredits".into())],
            now_ms: 1000.0,
            ..Default::default()
        };
        project(&store, "actor-1", &ctx, &mut model);
        let last = model.receipts.last.clone().expect("receipt view");
        assert_eq!(last.kind, "BankWithdrawCredits");
        assert_eq!(last.at_ms, 1000.0);
        assert_eq!(last.denied_copy(), "DENIED · INSUFFICIENT FUNDS");

        // Re-projection keeps the first-observed stamp and resolved kind even
        // after the envelope left the queue.
        let ctx2 = ProjectContext {
            now_ms: 2000.0,
            ..Default::default()
        };
        project(&store, "actor-1", &ctx2, &mut model);
        let last = model.receipts.last.expect("receipt view");
        assert_eq!(last.at_ms, 1000.0);
        assert_eq!(last.kind, "BankWithdrawCredits");
    }
}
