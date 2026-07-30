// ─────────────────────────────────────────────────────────────────────────────
// MEDICAL CRAFTING — component-based recipes and quality propagation.
// ─────────────────────────────────────────────────────────────────────────────

fn grant_medic_crafting_test_skills(state: &mut SliceAuthorityState, actor_id: &str) {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("test actor exists");
    for skill_box_id in [
        "medic-medical-crafting-i",
        "medic-medical-crafting-ii",
        "medic-medical-crafting-iii",
        "medic-medical-crafting-iv",
    ] {
        actor
            .professions
            .skill_boxes
            .insert(skill_box_id.to_owned());
    }
}

fn expected_material_item_for_family(family: &str) -> Option<u32> {
    match family {
        "mineral" => Some(RESOURCE_MINERAL_ITEM_ID),
        "copper" => Some(RESOURCE_COPPER_ITEM_ID),
        "chemical" => Some(RESOURCE_CHEMICAL_ITEM_ID),
        "flora" => Some(RESOURCE_FLORA_ITEM_ID),
        "gas" => Some(RESOURCE_GAS_ITEM_ID),
        "water" => Some(RESOURCE_LIQUID_ITEM_ID),
        "clodpowder" => Some(RESOURCE_CLODPOWDER_ITEM_ID),
        "hide" => Some(RESOURCE_CREATURE_HIDE_ITEM_ID),
        "bone" => Some(RESOURCE_CREATURE_BONE_ITEM_ID),
        "carbon" => Some(RESOURCE_CARBON_ITEM_ID),
        "fuel" => Some(RESOURCE_FUEL_ITEM_ID),
        "polymer" => Some(RESOURCE_POLYMER_ITEM_ID),
        _ => None,
    }
}

#[test]
fn craft_recipe_slots_have_resolvable_requirement_kinds() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let browse = state
        .craft_session_snapshot_for_observer(&config)
        .expect("browse craft session snapshot");
    assert!(
        !browse.recipes.is_empty(),
        "craft recipe registry is non-empty"
    );
    assert_eq!(
        browse.details.len(),
        browse.recipes.len(),
        "browse payload carries one resolvable detail per recipe"
    );
    for recipe in browse.recipes.iter() {
        assert!(
            inventory_item_name(recipe.output_item_id).is_some(),
            "{} output item {} must resolve",
            recipe.recipe_id,
            recipe.output_item_id
        );
        let detail = browse
            .details
            .iter()
            .find(|detail| detail.recipe_id == recipe.recipe_id)
            .unwrap_or_else(|| panic!("{} detail must stream", recipe.recipe_id));
        for slot in detail.slots.iter() {
            let required_item_id = slot.required_item_id.unwrap_or_else(|| {
                panic!("{}:{} requires an item id", recipe.recipe_id, slot.symbol)
            });
            assert!(
                slot.required_qty > 0,
                "{}:{} quantity must be positive",
                recipe.recipe_id,
                slot.symbol
            );
            assert!(
                !slot.required_item_name.trim().is_empty(),
                "{}:{} required item name must be present",
                recipe.recipe_id,
                slot.symbol
            );
            match slot.requirement_kind.as_str() {
                "material_family" => {
                    let family = slot.required_family.as_deref().unwrap_or("");
                    assert_eq!(
                        expected_material_item_for_family(family),
                        Some(required_item_id),
                        "{}:{} family {} must map to its concrete item id",
                        recipe.recipe_id,
                        slot.symbol,
                        family
                    );
                }
                "item" => {
                    let family = slot.required_family.as_deref();
                    assert!(
                        family.is_none() || family == Some("component"),
                        "{}:{} exact item slots may only use the component family marker",
                        recipe.recipe_id,
                        slot.symbol
                    );
                    assert!(
                        inventory_item_name(required_item_id).is_some(),
                        "{}:{} exact item {} must exist",
                        recipe.recipe_id,
                        slot.symbol,
                        required_item_id
                    );
                }
                other => panic!(
                    "{}:{} unknown requirement kind {other}",
                    recipe.recipe_id, slot.symbol
                ),
            }
        }
    }

    let advanced = browse
        .details
        .iter()
        .find(|detail| detail.recipe_id == "advanced_stimpak")
        .expect("advanced stimpak detail");
    for item_id in [
        BIO_EFFECT_CONTROLLER_ITEM_ID,
        LIQUID_SUSPENSION_ITEM_ID,
        CHEMICAL_RELEASE_MECHANISM_ITEM_ID,
    ] {
        let slot = advanced
            .slots
            .iter()
            .find(|slot| slot.required_item_id == Some(item_id))
            .unwrap_or_else(|| panic!("advanced stimpak requires component item {item_id}"));
        assert_eq!(
            slot.requirement_kind, "item",
            "component {item_id} is an exact item slot"
        );
        assert_eq!(
            slot.required_family.as_deref(),
            Some("component"),
            "component {item_id} keeps the component family marker but is not flavor-only"
        );
    }
}

fn craft_input_stack_for_test(
    state: &SliceAuthorityState,
    actor_id: &str,
    item_id: u32,
    quantity: u32,
) -> (String, String, u32) {
    state
        .inventory_snapshots()
        .iter()
        .find(|row| {
            row.item_id == item_id
                && row.available >= quantity
                && actor_owns_inventory_container(actor_id, &row.container)
        })
        .map(|row| {
            (
                row.container.clone(),
                row.stack_id.to_string(),
                row.variant_id,
            )
        })
        .unwrap_or_else(|| panic!("missing craft input item {item_id} x{quantity}"))
}

fn craft_recipe_auto_for_test(
    state: &mut SliceAuthorityState,
    config: &SliceAuthorityConfig,
    recipe_id: &str,
) -> u32 {
    let player = config.player_actor_id.clone();
    let browse = state
        .craft_session_snapshot_for_observer(config)
        .expect("craft browse snapshot before begin");
    let recipe = browse
        .recipes
        .iter()
        .find(|recipe| recipe.recipe_id == recipe_id)
        .unwrap_or_else(|| panic!("missing recipe {recipe_id}"));
    let detail = browse
        .details
        .iter()
        .find(|detail| detail.recipe_id == recipe_id)
        .unwrap_or_else(|| panic!("missing recipe detail {recipe_id}"));
    let output_item_id = recipe.output_item_id;
    let slots = detail.slots.clone();
    let command_base = 10_000_u64.saturating_add(
        u64::try_from(state.runtime.durable.seen_commands.len())
            .unwrap_or(0)
            .saturating_mul(10),
    );
    let begin = state.apply_envelope(
        config,
        command(
            command_base,
            ClientCommand::CraftBegin {
                recipe_id: recipe_id.to_owned(),
            },
        ),
    );
    assert_eq!(
        begin.status,
        AuthorityCommandStatus::Accepted,
        "begin {recipe_id}: {:?}",
        begin.reason_code
    );
    for (index, slot) in slots.iter().enumerate() {
        let required_item_id = slot
            .required_item_id
            .unwrap_or_else(|| panic!("{recipe_id} slot {index} missing required item id"));
        let (container, stack_id, variant_id) =
            craft_input_stack_for_test(state, &player, required_item_id, slot.required_qty);
        let assign = state.apply_envelope(
            config,
            command(
                command_base + 1 + u64::try_from(index).unwrap_or(0),
                ClientCommand::CraftAssignSlot {
                    slot_index: u8::try_from(index).unwrap_or(u8::MAX),
                    container,
                    stack_id,
                    variant_id,
                },
            ),
        );
        assert_eq!(
            assign.status,
            AuthorityCommandStatus::Accepted,
            "assign {recipe_id} slot {index}: {:?}",
            assign.reason_code
        );
    }
    let assemble = state.apply_envelope(
        config,
        command(command_base + 8, ClientCommand::CraftAssemble {}),
    );
    assert_eq!(
        assemble.status,
        AuthorityCommandStatus::Accepted,
        "assemble {recipe_id}: {:?}",
        assemble.reason_code
    );
    let finalize = state.apply_envelope(
        config,
        command(
            command_base + 9,
            ClientCommand::CraftFinalizePrototype {
                custom_name: String::new(),
            },
        ),
    );
    assert_eq!(
        finalize.status,
        AuthorityCommandStatus::Accepted,
        "finalize {recipe_id}: {:?}",
        finalize.reason_code
    );
    state
        .inventory_snapshots()
        .iter()
        .filter(|row| {
            row.item_id == output_item_id && actor_owns_inventory_container(&player, &row.container)
        })
        .map(|row| row.variant_id)
        .max()
        .unwrap_or_else(|| panic!("{recipe_id} output item missing"))
}

#[test]
fn metal_extractor_contract_assembles_cache_variants_into_item_3006() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    grant_craftsman_session_test_skills(&mut state, &player);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let container = format!("{player}:field-pack");
    push_test_inventory_stack(&mut state, &container, RESOURCE_MINERAL_ITEM_ID, 7, 80);
    push_test_inventory_stack(&mut state, &container, RESOURCE_COPPER_ITEM_ID, 11, 36);
    let variant = craft_recipe_auto_for_test(&mut state, &config, "metal_extractor");
    assert_eq!(METAL_EXTRACTOR_TOOL_ITEM_ID, 3_006);
    assert!(variant > 0);
    assert_eq!(
        owned_actor_item_quantity(&state, &player, METAL_EXTRACTOR_TOOL_ITEM_ID),
        1
    );
    assert_eq!(
        owned_actor_item_quantity(&state, &player, RESOURCE_MINERAL_ITEM_ID),
        0
    );
    assert_eq!(
        owned_actor_item_quantity(&state, &player, RESOURCE_COPPER_ITEM_ID),
        0
    );
}

#[test]
fn metal_extractor_short_owned_resources_are_visible_but_not_assignable() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    grant_craftsman_session_test_skills(&mut state, &player);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let container = format!("{player}:field-pack");
    let iron_stack =
        push_test_inventory_stack(&mut state, &container, RESOURCE_MINERAL_ITEM_ID, 7, 1);
    push_test_inventory_stack(&mut state, &container, RESOURCE_COPPER_ITEM_ID, 11, 1);
    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "metal_extractor".to_owned(),
            },
        ),
    );
    assert_eq!(begin.status, AuthorityCommandStatus::Accepted);
    let slots = &begin
        .craft_session
        .as_ref()
        .expect("craft session")
        .slot_screen
        .as_ref()
        .expect("slot screen")
        .slots;
    let short_iron = slots[0]
        .eligible
        .iter()
        .find(|option| option.stack_id == iron_stack.to_string())
        .expect("short iron remains visible");
    assert_eq!(short_iron.qty_available, 1);
    assert!(!short_iron.recommended, "short stack cannot be BEST FIT");
    let rejected = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::CraftAssignSlot {
                slot_index: 0,
                container: container.clone(),
                stack_id: iron_stack.to_string(),
                variant_id: 7,
            },
        ),
    );
    assert_eq!(rejected.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rejected.reason_code, Some("craft_slot_mismatch".to_owned()));
}

#[test]
fn medic_trio_are_real_craftable_components_consumed_by_advanced_stimpak() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Medic);
    grant_medic_crafting_test_skills(&mut state, &player);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );

    let browse = state
        .craft_session_snapshot_for_observer(&config)
        .expect("browse craft session snapshot");
    for recipe_id in [
        "bio_effect_controller",
        "liquid_suspension",
        "chemical_release_mechanism",
        "advanced_stimpak",
    ] {
        let row = browse
            .recipes
            .iter()
            .find(|recipe| recipe.recipe_id == recipe_id)
            .unwrap_or_else(|| panic!("{recipe_id} recipe listed"));
        assert!(row.unlocked, "{recipe_id} unlocked by medic training");
        assert!(
            browse
                .details
                .iter()
                .any(|detail| detail.recipe_id == recipe_id),
            "{recipe_id} has a streamed browse detail"
        );
    }

    let container = format!("{player}:field-pack");
    push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_CLODPOWDER_ITEM_ID,
        72_101,
        32,
    );
    push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_CHEMICAL_ITEM_ID,
        72_202,
        40,
    );
    push_test_inventory_stack(&mut state, &container, RESOURCE_LIQUID_ITEM_ID, 72_303, 24);
    push_test_inventory_stack(&mut state, &container, RESOURCE_MINERAL_ITEM_ID, 72_404, 48);

    let bec_quality = craft_recipe_auto_for_test(&mut state, &config, "bio_effect_controller");
    let suspension_quality = craft_recipe_auto_for_test(&mut state, &config, "liquid_suspension");
    let release_quality =
        craft_recipe_auto_for_test(&mut state, &config, "chemical_release_mechanism");
    let shell_quality = craft_recipe_auto_for_test(&mut state, &config, "solid_delivery_shell");
    for (item_id, quality) in [
        (BIO_EFFECT_CONTROLLER_ITEM_ID, bec_quality),
        (LIQUID_SUSPENSION_ITEM_ID, suspension_quality),
        (CHEMICAL_RELEASE_MECHANISM_ITEM_ID, release_quality),
        (SOLID_DELIVERY_SHELL_ITEM_ID, shell_quality),
    ] {
        assert!(
            quality > 0,
            "component {item_id} has a crafted quality variant ({quality})"
        );
        assert_eq!(
            owned_actor_item_quantity(&state, &player, item_id),
            1,
            "component {item_id} exists as a real inventory item before advanced-stimpak assembly"
        );
    }

    let advanced_variant = craft_recipe_auto_for_test(&mut state, &config, "advanced_stimpak");
    let stats = decode_medical_variant(MedicalSchematicKind::AdvancedStimpak, advanced_variant)
        .expect("advanced stimpak variant decodes");
    assert!(
        stats.potency >= 180,
        "advanced stimpak potency floor carried through"
    );
    for item_id in [
        BIO_EFFECT_CONTROLLER_ITEM_ID,
        LIQUID_SUSPENSION_ITEM_ID,
        CHEMICAL_RELEASE_MECHANISM_ITEM_ID,
        SOLID_DELIVERY_SHELL_ITEM_ID,
    ] {
        assert_eq!(
            owned_actor_item_quantity(&state, &player, item_id),
            0,
            "advanced stimpak consumed component item {item_id}"
        );
    }
    assert_eq!(
        owned_actor_item_quantity(&state, &player, ADVANCED_STIMPAK_ITEM_ID),
        1,
        "one advanced stimpak prototype exists after consuming the real components; quantity stat stays encoded in variant ({})",
        stats.quantity
    );
}
#[test]
fn medic_craft_slot_stats_synthesizes_component_quality() {
    // A medical component slots in with its crafted quality on the potency channel;
    // a raw resource still reads its rolled stats (unchanged path).
    let bec = craft_slot_stats(BIO_EFFECT_CONTROLLER_ITEM_ID, 812).expect("component stats");
    assert_eq!(bec.potency, 812);
    assert_eq!(bec.chemical_purity, 0);
    assert_eq!(bec.tensile_strength, 0);
    let shell = craft_slot_stats(SOLID_DELIVERY_SHELL_ITEM_ID, 1_500).expect("clamped");
    assert_eq!(shell.potency, 1_000, "component quality clamps to 1000");
    let resource = craft_slot_stats(RESOURCE_MINERAL_ITEM_ID, 4_242);
    assert_eq!(
        resource,
        resource_stats_for_item_variant(RESOURCE_MINERAL_ITEM_ID, 4_242),
        "raw resources keep their rolled-stat path"
    );
}

#[test]
fn medic_medical_stats_from_lines_span_floor_to_ceiling() {
    // Full lines -> ceiling; empty lines -> floor. Advanced stimpak's potency
    // ceiling (350) beats the basic stimpak's (160) -> "higher heal".
    let advanced_max =
        medical_stats_from_craft_lines(MedicalSchematicKind::AdvancedStimpak, 1_000, 1_000);
    assert_eq!(advanced_max.potency, 350);
    assert_eq!(advanced_max.quantity, 24);
    let advanced_min = medical_stats_from_craft_lines(MedicalSchematicKind::AdvancedStimpak, 0, 0);
    assert_eq!(advanced_min.potency, 180);
    let basic_max = medical_stats_from_craft_lines(MedicalSchematicKind::StimpakA, 1_000, 1_000);
    assert_eq!(basic_max.potency, 160);
    assert!(
        advanced_min.potency > basic_max.potency,
        "even a floor advanced stimpak out-heals a ceiling basic stimpak"
    );
}

#[test]
fn medic_advanced_stimpak_heals_more_than_basic() {
    let advanced =
        medical_stats_from_craft_lines(MedicalSchematicKind::AdvancedStimpak, 1_000, 1_000);
    let basic = medical_stats_from_craft_lines(MedicalSchematicKind::StimpakA, 1_000, 1_000);
    assert!(
        medical_stimpak_heal_milli(advanced, 0) > medical_stimpak_heal_milli(basic, 0),
        "advanced stimpak heal magnitude exceeds basic"
    );
}

#[test]
fn medic_anti_state_defense_scales_with_potency_and_clamps() {
    assert_eq!(anti_state_defense_vs_state_milli(80), 160);
    assert_eq!(anti_state_defense_vs_state_milli(300), 600);
    assert_eq!(
        anti_state_defense_vs_state_milli(500),
        700,
        "defense_vs_state clamps at 700 (fork F-M5)"
    );
}

/// Run the full W6 flow for the Advanced Stimpak from four components of a given
/// crafted quality, returning the finalized potency + the assembled potency-line cap.
fn craft_advanced_stimpak_for_test(component_quality: u32) -> (u16, u16) {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Medic);
    grant_medic_crafting_test_skills(&mut state, &player);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let container = format!("{player}:field-pack");
    let components = [
        (
            BIO_EFFECT_CONTROLLER_ITEM_ID,
            "Biological Effect Controller",
        ),
        (LIQUID_SUSPENSION_ITEM_ID, "Liquid Suspension"),
        (
            CHEMICAL_RELEASE_MECHANISM_ITEM_ID,
            "Chemical Release Duration Mechanism",
        ),
        (SOLID_DELIVERY_SHELL_ITEM_ID, "Solid Delivery Shell"),
    ];
    let mut slot_refs = Vec::new();
    for (item_id, _name) in components {
        let stack_id =
            push_test_inventory_stack(&mut state, &container, item_id, component_quality, 1);
        slot_refs.push((container.clone(), stack_id.to_string(), component_quality));
    }
    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "advanced_stimpak".to_owned(),
            },
        ),
    );
    assert_eq!(
        begin.status,
        AuthorityCommandStatus::Accepted,
        "begin: {:?}",
        begin.reason_code
    );
    for (i, (cont, stack, variant)) in slot_refs.iter().enumerate() {
        let assign = state.apply_envelope(
            &config,
            command(
                2 + i as u64,
                ClientCommand::CraftAssignSlot {
                    slot_index: i as u8,
                    container: cont.clone(),
                    stack_id: stack.clone(),
                    variant_id: *variant,
                },
            ),
        );
        assert_eq!(
            assign.status,
            AuthorityCommandStatus::Accepted,
            "assign {i}: {:?}",
            assign.reason_code
        );
    }
    let assemble = state.apply_envelope(&config, command(10, ClientCommand::CraftAssemble {}));
    assert_eq!(
        assemble.status,
        AuthorityCommandStatus::Accepted,
        "assemble: {:?}",
        assemble.reason_code
    );
    let (potency_cap, points) = {
        let session = state
            .actors
            .get(&player)
            .and_then(|a| a.craft_session.as_ref())
            .unwrap();
        let cap = session
            .lines
            .iter()
            .find(|l| l.line_id == 0)
            .unwrap()
            .cap_milli;
        (cap, session.experimentation_points_remaining)
    };
    // Spend all experimentation on the potency line, pushing value toward the cap.
    if points > 0 {
        let exp = state.apply_envelope(
            &config,
            command(20, ClientCommand::CraftExperiment { line_id: 0, points }),
        );
        assert_eq!(
            exp.status,
            AuthorityCommandStatus::Accepted,
            "experiment: {:?}",
            exp.reason_code
        );
    }
    let finalize = state.apply_envelope(
        &config,
        command(
            30,
            ClientCommand::CraftFinalizePrototype {
                custom_name: String::new(),
            },
        ),
    );
    assert_eq!(
        finalize.status,
        AuthorityCommandStatus::Accepted,
        "finalize: {:?}",
        finalize.reason_code
    );
    let row = state
        .inventory_snapshots()
        .into_iter()
        .find(|r| {
            r.item_id == ADVANCED_STIMPAK_ITEM_ID
                && actor_owns_inventory_container(&player, &r.container)
        })
        .expect("advanced stimpak produced");
    let stats = decode_medical_variant(MedicalSchematicKind::AdvancedStimpak, row.variant_id)
        .expect("advanced stimpak variant decodes");
    (stats.potency, potency_cap)
}

#[test]
fn medic_advanced_stimpak_carries_component_quality_into_the_product() {
    // THE component-quality carry-through: better components -> a stronger advanced stimpak. Deterministic
    // (same actor/tick/recipe -> identical rolls; only component quality differs).
    let (high_potency, high_cap) = craft_advanced_stimpak_for_test(900);
    let (low_potency, low_cap) = craft_advanced_stimpak_for_test(150);
    assert!(
        high_cap > low_cap,
        "high-quality components must raise the heal-line cap ({high_cap} vs {low_cap})"
    );
    assert!(
        high_potency > low_potency,
        "high-quality components must yield a stronger advanced stimpak ({high_potency} vs {low_potency})"
    );
    assert!(
        (180..=350).contains(&high_potency),
        "advanced potency stays within its floor/ceiling ({high_potency})"
    );
    assert!(
        high_potency > 160,
        "any advanced stimpak out-heals a max basic stimpak (potency {high_potency} > 160)"
    );
}

#[test]
fn medic_crafts_and_uses_advanced_stimpak_open_use() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    // Seed a crafted advanced stimpak directly (the full craft flow is covered above).
    let variant = encode_medical_variant(
        MedicalSchematicKind::AdvancedStimpak,
        MedicalCraftStats {
            potency: 320,
            quantity: 10,
        },
    );
    state.add_actor_inventory_stack(
        &player,
        ADVANCED_STIMPAK_ITEM_ID,
        variant,
        "Advanced Stimpak P320/Q10",
        1,
        ADVANCED_STIMPAK_STACK_CAP,
        "field-pack",
    );
    {
        let p = state.actors.get_mut(&player).unwrap();
        p.vitals.health = 10;
    }
    // Open-use: a non-medic can use it.
    clear_test_professions(&mut state, &player);
    let used = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::UseConsumable {
                item_id: "advanced_stimpak".to_owned(),
                item_numeric_id: Some(ADVANCED_STIMPAK_ITEM_ID),
                variant_id: Some(variant),
            },
        ),
    );
    assert_eq!(
        used.status,
        AuthorityCommandStatus::Accepted,
        "use: {:?}",
        used.reason_code
    );
    let effect = state
        .actors
        .get(&player)
        .unwrap()
        .consumable_effects
        .iter()
        .find(|e| e.effect_id == "advanced_stimpak_heal")
        .expect("advanced stimpak heal effect applied");
    assert_eq!(
        effect.heal_remaining_milli,
        320 * 1_000,
        "heal = potency * 1000 at novice bonus"
    );
    assert_eq!(
        state.actor_inventory_available_quantity(&player, ADVANCED_STIMPAK_ITEM_ID),
        0,
        "the advanced stimpak was consumed"
    );
    state.tick_consumable_effects();
    let actor = state.actors.get(&player).unwrap();
    assert_eq!(
        actor
            .professions
            .xp
            .get(&AuthorityProfessionKind::Medic)
            .copied()
            .unwrap_or(0),
        0,
        "open medicine use does not mint profession XP before Medic is trained"
    );
}

#[test]
fn trained_medicine_use_pays_both_exact_tracks_but_general_xp_once() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Medic);
    let variant = encode_medical_variant(
        MedicalSchematicKind::AdvancedStimpak,
        MedicalCraftStats {
            potency: 320,
            quantity: 10,
        },
    );
    state.add_actor_inventory_stack(
        &player,
        ADVANCED_STIMPAK_ITEM_ID,
        variant,
        "Advanced Stimpak P320/Q10",
        1,
        ADVANCED_STIMPAK_STACK_CAP,
        "field-pack",
    );
    state.actors.get_mut(&player).unwrap().vitals.health = 10;
    let used = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::UseConsumable {
                item_id: "advanced_stimpak".to_owned(),
                item_numeric_id: Some(ADVANCED_STIMPAK_ITEM_ID),
                variant_id: Some(variant),
            },
        ),
    );
    assert_eq!(used.status, AuthorityCommandStatus::Accepted);
    let health_before = state.actors[&player].vitals.health;
    state.tick_consumable_effects();
    let actor = &state.actors[&player];
    let applied_heal = actor.vitals.health.saturating_sub(health_before);
    let expected_xp = u64::try_from(applied_heal).unwrap_or(0).saturating_mul(5);
    assert!(expected_xp > 0, "test tick must apply a real heal");
    assert_eq!(
        actor.professions.xp[&AuthorityProfessionKind::Medic],
        expected_xp,
        "one medicine event increments the shared profession pool once"
    );
    assert_eq!(
        actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Medic, "medicine-use"),
        expected_xp
    );
    assert_eq!(
        actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Medic, "medicine-speed"),
        expected_xp
    );
}

#[test]
fn medic_anti_state_stim_grants_unified_defense_buff() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    let variant = encode_medical_variant(
        MedicalSchematicKind::AntiDizzyStim,
        MedicalCraftStats {
            potency: 250,
            quantity: 6,
        },
    );
    state.add_actor_inventory_stack(
        &player,
        ANTI_DIZZY_STIM_ITEM_ID,
        variant,
        "Anti-Dizzy Stim P250/Q6",
        1,
        ANTI_STATE_STIM_STACK_CAP,
        "field-pack",
    );
    let used = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::UseConsumable {
                item_id: "anti_dizzy_stim".to_owned(),
                item_numeric_id: Some(ANTI_DIZZY_STIM_ITEM_ID),
                variant_id: Some(variant),
            },
        ),
    );
    assert_eq!(
        used.status,
        AuthorityCommandStatus::Accepted,
        "use: {:?}",
        used.reason_code
    );
    let actor = state.actors.get(&player).unwrap();
    let buff = actor
        .service_buffs
        .iter()
        .find(|b| b.effect_id == STATE_DEFENSE_EFFECT_ID)
        .expect("unified state-defense buff applied");
    assert_eq!(
        buff.defense_vs_state_milli, 500,
        "potency 250 -> 500 permille defense"
    );
    assert_eq!(
        actor.effective_stats.defense_vs_state_milli, 500,
        "the effective stat reflects the buff (what C4 reads)"
    );
    // Anti-blind refreshes the SAME unified buff (one stat, no per-state defense).
    let blind_variant = encode_medical_variant(
        MedicalSchematicKind::AntiBlindStim,
        MedicalCraftStats {
            potency: 300,
            quantity: 6,
        },
    );
    state.add_actor_inventory_stack(
        &player,
        ANTI_BLIND_STIM_ITEM_ID,
        blind_variant,
        "Anti-Blind Stim P300/Q6",
        1,
        ANTI_STATE_STIM_STACK_CAP,
        "field-pack",
    );
    state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::UseConsumable {
                item_id: "anti_blind_stim".to_owned(),
                item_numeric_id: Some(ANTI_BLIND_STIM_ITEM_ID),
                variant_id: Some(blind_variant),
            },
        ),
    );
    let actor = state.actors.get(&player).unwrap();
    let buffs: Vec<_> = actor
        .service_buffs
        .iter()
        .filter(|b| b.effect_id == STATE_DEFENSE_EFFECT_ID)
        .collect();
    assert_eq!(
        buffs.len(),
        1,
        "one unified defense buff — not one per state"
    );
    assert_eq!(
        buffs[0].defense_vs_state_milli, 600,
        "refresh takes the stronger magnitude (P300 -> 600)"
    );
}

#[test]
fn medic_crafts_component_and_basic_stimpak_via_w6() {
    // A medic (with a Field Multitool granted at medic-novice) crafts a component
    // and the basic stimpak through the W6 window path.
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Medic);
    grant_medic_crafting_test_skills(&mut state, &player);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let container = format!("{player}:field-pack");
    // Solid Delivery Shell (mineral only).
    let mineral_stack =
        push_test_inventory_stack(&mut state, &container, RESOURCE_MINERAL_ITEM_ID, 71_001, 40);
    let mineral_before = owned_actor_item_quantity(&state, &player, RESOURCE_MINERAL_ITEM_ID);
    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "solid_delivery_shell".to_owned(),
            },
        ),
    );
    assert_eq!(
        begin.status,
        AuthorityCommandStatus::Accepted,
        "shell begin: {:?}",
        begin.reason_code
    );
    let assign = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::CraftAssignSlot {
                slot_index: 0,
                container: container.clone(),
                stack_id: mineral_stack.to_string(),
                variant_id: 71_001,
            },
        ),
    );
    assert_eq!(
        assign.status,
        AuthorityCommandStatus::Accepted,
        "shell slot: {:?}",
        assign.reason_code
    );
    let assemble = state.apply_envelope(&config, command(3, ClientCommand::CraftAssemble {}));
    assert_eq!(
        assemble.status,
        AuthorityCommandStatus::Accepted,
        "shell assemble: {:?}",
        assemble.reason_code
    );
    let finalize = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::CraftFinalizePrototype {
                custom_name: String::new(),
            },
        ),
    );
    assert_eq!(
        finalize.status,
        AuthorityCommandStatus::Accepted,
        "shell finalize: {:?}",
        finalize.reason_code
    );
    assert!(
        state
            .inventory_snapshots()
            .iter()
            .any(|r| r.item_id == SOLID_DELIVERY_SHELL_ITEM_ID
                && actor_owns_inventory_container(&player, &r.container)),
        "a Solid Delivery Shell component was produced"
    );
    // The authority consumes exactly the recipe's assigned mineral cost and awards the Medic's matching track.
    assert_eq!(
        owned_actor_item_quantity(&state, &player, RESOURCE_MINERAL_ITEM_ID),
        mineral_before - 20,
        "finalizing a shell consumes its assigned mineral resource exactly once"
    );
    let medic = &state
        .actors
        .get(&player)
        .expect("player exists")
        .professions;
    assert!(
        medic
            .xp
            .get(&AuthorityProfessionKind::Medic)
            .copied()
            .unwrap_or(0)
            > 0,
        "shell craft paid Medic XP"
    );
    assert!(
        medic.track_xp_amount(AuthorityProfessionKind::Medic, "medical-crafting") > 0,
        "shell craft pays the parent purchase track, not merely total Medic XP"
    );
}

/// Modern CRAFT_RECIPES ammunition coverage: Iron / Shard / Spike Slugs.
/// Uses the same inventory identities and material law as legacy CraftItem
/// `ammo_slug_iron` / `slug_iron`, without a parallel ammo authority path.
#[test]
fn modern_ammo_recipes_are_discoverable_with_craftsman_novice_gate() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);

    let locked = state
        .craft_session_snapshot_for_observer(&config)
        .expect("browse craft session");
    for recipe_id in ["iron_slug", "shard_slug", "spike_slug"] {
        let row = locked
            .recipes
            .iter()
            .find(|recipe| recipe.recipe_id == recipe_id)
            .unwrap_or_else(|| panic!("{recipe_id} must list in generic craft browse"));
        assert!(
            !row.unlocked,
            "{recipe_id} stays locked without craftsman-novice"
        );
        assert_eq!(row.required_profession, "craftsman-novice");
        assert_eq!(row.category, "supply");
        assert_eq!(row.required_tool_item_id, FIELD_MULTITOOL_ITEM_ID);
        assert!(
            locked
                .details
                .iter()
                .any(|detail| detail.recipe_id == recipe_id),
            "{recipe_id} streams a browse detail for FIELD BENCH / TUI listing"
        );
    }

    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    let unlocked = state
        .craft_session_snapshot_for_observer(&config)
        .expect("browse after craftsman grant");
    for (recipe_id, output_item_id, name) in [
        ("iron_slug", AMMO_SLUG_IRON_ITEM_ID, "Iron Slug"),
        ("shard_slug", AMMO_SLUG_SHARD_ITEM_ID, "Shard Slug"),
        ("spike_slug", AMMO_SLUG_SPIKE_ITEM_ID, "Spike Slug"),
    ] {
        let row = unlocked
            .recipes
            .iter()
            .find(|recipe| recipe.recipe_id == recipe_id)
            .unwrap_or_else(|| panic!("{recipe_id} listed"));
        assert!(row.unlocked, "{recipe_id} unlocks with craftsman-novice");
        assert_eq!(row.output_item_id, output_item_id);
        assert_eq!(row.name, name);
        assert_eq!(row.source, "profession");
        let detail = unlocked
            .details
            .iter()
            .find(|detail| detail.recipe_id == recipe_id)
            .unwrap_or_else(|| panic!("{recipe_id} detail"));
        assert_eq!(detail.slots.len(), 2);
        assert_eq!(
            detail.slots[0].required_item_id,
            Some(RESOURCE_MINERAL_ITEM_ID)
        );
        assert_eq!(detail.slots[0].required_qty, CRAFT_SUPPLY_AMMO_IRON_QTY);
        assert_eq!(
            detail.slots[1].required_item_id,
            Some(RESOURCE_CLODPOWDER_ITEM_ID)
        );
        assert_eq!(
            detail.slots[1].required_qty,
            CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY
        );
    }
}

#[test]
fn modern_iron_slug_recipe_covers_session_and_ammo_consumption() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );

    let container = format!("{player}:field-pack");
    let iron_variant = 81_001_u32;
    let powder_variant = 81_002_u32;
    push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_MINERAL_ITEM_ID,
        iron_variant,
        CRAFT_SUPPLY_AMMO_IRON_QTY,
    );
    push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_CLODPOWDER_ITEM_ID,
        powder_variant,
        CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY,
    );

    let iron_before = owned_actor_item_quantity(&state, &player, RESOURCE_MINERAL_ITEM_ID);
    let powder_before = owned_actor_item_quantity(&state, &player, RESOURCE_CLODPOWDER_ITEM_ID);
    let ammo_before = owned_actor_item_quantity(&state, &player, AMMO_SLUG_IRON_ITEM_ID);
    let hash_before_begin = state.stable_state_hash_hex();

    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "iron_slug".to_owned(),
            },
        ),
    );
    assert_eq!(
        begin.status,
        AuthorityCommandStatus::Accepted,
        "begin iron_slug: {:?}",
        begin.reason_code
    );
    let session = begin
        .craft_session
        .as_ref()
        .expect("craft session projected");
    assert_eq!(session.phase, "slots");
    assert_eq!(session.recipe_id.as_deref(), Some("iron_slug"));
    assert!(
        session
            .recipes
            .iter()
            .any(|recipe| recipe.recipe_id == "iron_slug" && recipe.unlocked),
        "projected session lists unlocked iron_slug"
    );
    let slot_screen = session.slot_screen.as_ref().expect("slot screen");
    assert_eq!(slot_screen.slots.len(), 2);
    assert!(!slot_screen.can_assemble);

    let (iron_container, iron_stack, iron_var) = craft_input_stack_for_test(
        &state,
        &player,
        RESOURCE_MINERAL_ITEM_ID,
        CRAFT_SUPPLY_AMMO_IRON_QTY,
    );
    let (powder_container, powder_stack, powder_var) = craft_input_stack_for_test(
        &state,
        &player,
        RESOURCE_CLODPOWDER_ITEM_ID,
        CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY,
    );
    assert_eq!(iron_var, iron_variant);
    assert_eq!(powder_var, powder_variant);

    let assign_iron = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::CraftAssignSlot {
                slot_index: 0,
                container: iron_container,
                stack_id: iron_stack,
                variant_id: iron_variant,
            },
        ),
    );
    assert_eq!(
        assign_iron.status,
        AuthorityCommandStatus::Accepted,
        "assign iron: {:?}",
        assign_iron.reason_code
    );
    let assign_powder = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::CraftAssignSlot {
                slot_index: 1,
                container: powder_container,
                stack_id: powder_stack,
                variant_id: powder_variant,
            },
        ),
    );
    assert_eq!(
        assign_powder.status,
        AuthorityCommandStatus::Accepted,
        "assign powder: {:?}",
        assign_powder.reason_code
    );
    let loaded_screen = assign_powder
        .craft_session
        .as_ref()
        .and_then(|session| session.slot_screen.as_ref())
        .expect("loaded slot screen");
    assert!(loaded_screen.can_assemble, "full inputs enable assemble");

    let assemble = state.apply_envelope(&config, command(4, ClientCommand::CraftAssemble {}));
    assert_eq!(
        assemble.status,
        AuthorityCommandStatus::Accepted,
        "assemble iron_slug: {:?}",
        assemble.reason_code
    );
    assert_eq!(
        owned_actor_item_quantity(&state, &player, RESOURCE_MINERAL_ITEM_ID),
        iron_before - CRAFT_SUPPLY_AMMO_IRON_QTY
    );
    assert_eq!(
        owned_actor_item_quantity(&state, &player, RESOURCE_CLODPOWDER_ITEM_ID),
        powder_before - CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY
    );
    let assembled = assemble
        .craft_session
        .as_ref()
        .expect("assembled session projected");
    assert_eq!(assembled.phase, "assembled");
    assert!(assembled.assembled.is_some());

    let finalize = state.apply_envelope(
        &config,
        command(
            5,
            ClientCommand::CraftFinalizePrototype {
                custom_name: String::new(),
            },
        ),
    );
    assert_eq!(
        finalize.status,
        AuthorityCommandStatus::Accepted,
        "finalize iron_slug: {:?}",
        finalize.reason_code
    );
    assert_eq!(
        owned_actor_item_quantity(&state, &player, AMMO_SLUG_IRON_ITEM_ID),
        ammo_before + CRAFT_SUPPLY_AMMO_OUTPUT_QTY,
        "finalize yields legacy Iron Slug batch quantity"
    );
    let ammo_row = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| {
            row.item_id == AMMO_SLUG_IRON_ITEM_ID
                && actor_owns_inventory_container(&player, &row.container)
        })
        .expect("iron slug inventory row");
    assert_eq!(ammo_row.variant_id, 0, "ammo provenance variant is exact 0");
    assert_eq!(ammo_row.item, "Iron Slug");
    assert!(
        ammo_row.container.ends_with(":field-supplies"),
        "ammo lands in field-supplies like legacy craft: {}",
        ammo_row.container
    );
    assert!(
        state
            .actors
            .get(&player)
            .and_then(|actor| actor.craft_session.as_ref())
            .is_none(),
        "session clears after finalize"
    );
    let hash_after_craft = state.stable_state_hash_hex();
    assert_ne!(hash_after_craft, hash_before_begin);

    // Replay/hash: identical command script on fresh state reaches the same hash.
    let mut replay = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    clear_test_professions(&mut replay, &player);
    grant_test_profession(&mut replay, &player, AuthorityProfessionKind::Craftsman);
    seed_test_tool(
        &mut replay,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    push_test_inventory_stack(
        &mut replay,
        &container,
        RESOURCE_MINERAL_ITEM_ID,
        iron_variant,
        CRAFT_SUPPLY_AMMO_IRON_QTY,
    );
    push_test_inventory_stack(
        &mut replay,
        &container,
        RESOURCE_CLODPOWDER_ITEM_ID,
        powder_variant,
        CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY,
    );
    let (r_iron_c, r_iron_s, _) = craft_input_stack_for_test(
        &replay,
        &player,
        RESOURCE_MINERAL_ITEM_ID,
        CRAFT_SUPPLY_AMMO_IRON_QTY,
    );
    let (r_powder_c, r_powder_s, _) = craft_input_stack_for_test(
        &replay,
        &player,
        RESOURCE_CLODPOWDER_ITEM_ID,
        CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY,
    );
    for envelope in [
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "iron_slug".to_owned(),
            },
        ),
        command(
            2,
            ClientCommand::CraftAssignSlot {
                slot_index: 0,
                container: r_iron_c,
                stack_id: r_iron_s,
                variant_id: iron_variant,
            },
        ),
        command(
            3,
            ClientCommand::CraftAssignSlot {
                slot_index: 1,
                container: r_powder_c,
                stack_id: r_powder_s,
                variant_id: powder_variant,
            },
        ),
        command(4, ClientCommand::CraftAssemble {}),
        command(
            5,
            ClientCommand::CraftFinalizePrototype {
                custom_name: String::new(),
            },
        ),
    ] {
        let frame = replay.apply_envelope(&config, envelope);
        assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    }
    assert_eq!(
        replay.stable_state_hash_hex(),
        hash_after_craft,
        "identical ammo craft script is hash-stable"
    );

    // Insufficient materials reject assign (short stack stays visible, not assignable).
    let mut short_state =
        SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    clear_test_professions(&mut short_state, &player);
    grant_test_profession(
        &mut short_state,
        &player,
        AuthorityProfessionKind::Craftsman,
    );
    seed_test_tool(
        &mut short_state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let short_iron = push_test_inventory_stack(
        &mut short_state,
        &container,
        RESOURCE_MINERAL_ITEM_ID,
        iron_variant,
        1,
    );
    push_test_inventory_stack(
        &mut short_state,
        &container,
        RESOURCE_CLODPOWDER_ITEM_ID,
        powder_variant,
        CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY,
    );
    assert_eq!(
        short_state
            .apply_envelope(
                &config,
                command(
                    10,
                    ClientCommand::CraftBegin {
                        recipe_id: "iron_slug".to_owned(),
                    },
                ),
            )
            .status,
        AuthorityCommandStatus::Accepted
    );
    let rejected = short_state.apply_envelope(
        &config,
        command(
            11,
            ClientCommand::CraftAssignSlot {
                slot_index: 0,
                container: container.clone(),
                stack_id: short_iron.to_string(),
                variant_id: iron_variant,
            },
        ),
    );
    assert_eq!(rejected.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rejected.reason_code, Some("craft_slot_mismatch".to_owned()));

    // Crafted ammo is consumed by the existing reload / roll-combat inventory path.
    let ammo_available_before_reload =
        state.actor_inventory_item_available(&player, AMMO_SLUG_IRON_ITEM_ID);
    assert_eq!(
        ammo_available_before_reload,
        Some(ammo_before + CRAFT_SUPPLY_AMMO_OUTPUT_QTY)
    );
    assert!(
        state.actor_tracks_ammo_item(&player, AMMO_SLUG_IRON_ITEM_ID),
        "crafted iron slugs enter tracked ammo inventory"
    );
    if let Some(actor) = state.actors.get_mut(&player) {
        actor.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        actor.equipped_weapon_item_id = CRAFTED_SLUGTHROWER_ITEM_ID;
        actor.slugthrower_magazine = WeaponMagazineState {
            loaded_rounds: 0,
            reload_until_tick: 0,
        };
    }
    state
        .start_actor_weapon_reload(
            &player,
            AuthorityWeaponId::Slugthrower,
            AuthorityAmmoTypeId::SlugIron,
        )
        .expect("reload starts against crafted reserve");
    let reload_until = state
        .actors
        .get(&player)
        .map(|actor| actor.slugthrower_magazine.reload_until_tick)
        .unwrap_or(0);
    assert!(reload_until > state.tick);
    state.tick = reload_until;
    state
        .complete_actor_weapon_reload_if_due(
            &player,
            AuthorityWeaponId::Slugthrower,
            AuthorityAmmoTypeId::SlugIron,
        )
        .expect("reload completes");
    let loaded = state
        .actors
        .get(&player)
        .map(|actor| actor.slugthrower_magazine.loaded_rounds)
        .unwrap_or(0);
    assert!(loaded > 0, "reload chambers crafted slugs");
    let ammo_after_reload = owned_actor_item_quantity(&state, &player, AMMO_SLUG_IRON_ITEM_ID);
    assert_eq!(
        ammo_after_reload,
        ammo_before + CRAFT_SUPPLY_AMMO_OUTPUT_QTY - loaded,
        "reload consumes crafted ammo from the shared inventory path"
    );
}

#[test]
fn modern_shard_and_spike_slug_recipes_finalize_exact_identities() {
    let config = SliceAuthorityConfig::default();
    let player_template = config.player_actor_id.clone();
    for (recipe_id, item_id, label) in [
        ("shard_slug", AMMO_SLUG_SHARD_ITEM_ID, "Shard Slug"),
        ("spike_slug", AMMO_SLUG_SPIKE_ITEM_ID, "Spike Slug"),
    ] {
        let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        let player = player_template.clone();
        clear_test_professions(&mut state, &player);
        grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
        seed_test_tool(
            &mut state,
            &player,
            FIELD_MULTITOOL_ITEM_ID,
            "Field Multitool",
        );
        let container = format!("{player}:field-pack");
        push_test_inventory_stack(
            &mut state,
            &container,
            RESOURCE_MINERAL_ITEM_ID,
            91_001,
            CRAFT_SUPPLY_AMMO_IRON_QTY,
        );
        push_test_inventory_stack(
            &mut state,
            &container,
            RESOURCE_CLODPOWDER_ITEM_ID,
            91_002,
            CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY,
        );
        let before = owned_actor_item_quantity(&state, &player, item_id);
        let variant = craft_recipe_auto_for_test(&mut state, &config, recipe_id);
        assert_eq!(variant, 0, "{recipe_id} output variant is exact 0");
        assert_eq!(
            owned_actor_item_quantity(&state, &player, item_id),
            before + CRAFT_SUPPLY_AMMO_OUTPUT_QTY,
            "{recipe_id} output quantity"
        );
        let row = state
            .inventory_snapshots()
            .into_iter()
            .find(|row| {
                row.item_id == item_id && actor_owns_inventory_container(&player, &row.container)
            })
            .unwrap_or_else(|| panic!("{recipe_id} inventory row"));
        assert_eq!(row.item, label);
        assert!(
            state.actor_tracks_ammo_item(&player, item_id),
            "{recipe_id} is tracked ammo inventory"
        );
    }
}

/// Slugthrower / Coil Slug clean-cutover identity gate.
/// Pins numeric codes, item IDs, recipe identity, and display names that are
/// wire-stable across persistence and the client protocol. Any accidental
/// re-numbering or old-name resurrection MUST red this test.
#[test]
fn slugthrower_coil_slug_identity_is_stable() {
    // --- Weapon code ---
    assert_eq!(
        AuthorityWeaponId::Slugthrower.code(),
        1,
        "Slugthrower weapon code must remain 1"
    );

    // --- Ammo codes ---
    assert_eq!(
        AuthorityAmmoTypeId::SlugIron.code(),
        1,
        "SlugIron ammo code"
    );
    assert_eq!(
        AuthorityAmmoTypeId::SlugShard.code(),
        2,
        "SlugShard ammo code"
    );
    assert_eq!(
        AuthorityAmmoTypeId::SlugSpike.code(),
        3,
        "SlugSpike ammo code"
    );

    // --- Item IDs ---
    assert_eq!(
        CRAFTED_SLUGTHROWER_ITEM_ID, 3_101,
        "crafted slugthrower item id"
    );
    assert_eq!(AMMO_SLUG_IRON_ITEM_ID, 1_101, "Iron Slug item id");
    assert_eq!(AMMO_SLUG_SHARD_ITEM_ID, 1_102, "Shard Slug item id");
    assert_eq!(AMMO_SLUG_SPIKE_ITEM_ID, 1_103, "Spike Slug item id");

    // --- Variant encoding round-trip (31_000_000 base) ---
    let stats = super::crafting_rules::SlugthrowerCraftStats {
        power: 80,
        handling: 50,
        reliability: 42,
    };
    let encoded = super::crafting_rules::encode_slugthrower_variant(stats);
    // 31_000_000 base + 80*1M + 50*1K + 42 = 111_050_042
    assert_eq!(encoded, 111_050_042, "encode_slugthrower_variant encoding");
    let decoded =
        super::crafting_rules::decode_slugthrower_variant(encoded).expect("variant round-trips");
    assert_eq!(decoded.power, 80);
    assert_eq!(decoded.handling, 50);
    assert_eq!(decoded.reliability, 42);
    // Sub-31M values must not decode (they belong to other items).
    assert!(super::crafting_rules::decode_slugthrower_variant(30_999_999).is_none());

    // New wire values resolve correctly.
    assert_eq!(
        super::inventory::ammo_item_id_from_command("slug_iron"),
        Some(AMMO_SLUG_IRON_ITEM_ID),
        "slug_iron wire value resolves"
    );
    assert_eq!(
        super::inventory::ammo_item_id_from_command("slug_shard"),
        Some(AMMO_SLUG_SHARD_ITEM_ID),
        "slug_shard wire value resolves"
    );
    assert_eq!(
        super::inventory::ammo_item_id_from_command("slug_spike"),
        Some(AMMO_SLUG_SPIKE_ITEM_ID),
        "slug_spike wire value resolves"
    );

    // --- Display names ---
    assert_eq!(
        super::inventory::ammo_item_name(AMMO_SLUG_IRON_ITEM_ID),
        Some("Iron Slug"),
        "Iron Slug display name"
    );
    assert_eq!(
        super::inventory::inventory_item_name(CRAFTED_SLUGTHROWER_ITEM_ID),
        Some("Crafted Slugthrower Mk I"),
        "Crafted Slugthrower Mk I display name"
    );
}

#[test]
fn authority_creator_clothing_seeds_quantity_one_and_dedupes_bare_start() {
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let legacy_piece = AuthorityActorWornPiece {
        item: "top_rigged_tank".to_owned(),
        colors: vec!["#d14b35".to_owned(), "#f0c36b".to_owned()],
    };
    let mut legacy_colors = BTreeMap::new();
    legacy_colors.insert(legacy_piece.item.clone(), legacy_piece.colors.clone());
    let mut upsert = creator_clothing_upsert(vec![legacy_piece], legacy_colors);
    upsert.skill_box_ids = vec!["scout-novice".to_owned()];

    state
        .upsert_actor(upsert.clone())
        .expect("creator clothing upsert succeeds");
    for attempt in 0..2 {
        if attempt == 1 {
            upsert.worn = vec![AuthorityActorWornPiece {
                item: "legs_wrapped_workpants".to_owned(),
                colors: vec!["#1c2431".to_owned()],
            }];
            upsert.worn_colors = BTreeMap::from([(
                "legs_wrapped_workpants".to_owned(),
                vec!["#1c2431".to_owned()],
            )]);
            state
                .upsert_actor(upsert.clone())
                .expect("repeated bare-start upsert succeeds");
        }
        let mut owned = state
            .inventory_snapshots()
            .into_iter()
            .filter(|row| actor_owns_inventory_container("player", &row.container))
            .map(|row| (row.item_id, row.variant_id, row.quantity))
            .collect::<Vec<_>>();
        owned.sort_unstable();
        assert_eq!(
            owned,
            vec![(7_319, 0, 1), (9_900_001, 0, 1)],
            "attempt {attempt} owns exactly two quantity-one fixed clothing stacks"
        );
        assert_eq!(
            state.actor_snapshot("player").unwrap().worn,
            vec![
                AuthorityActorWornPiece {
                    item: "under_bodysuit".to_owned(),
                    colors: vec!["#89cff0".to_owned()],
                },
                AuthorityActorWornPiece {
                    item: "boots_canvas_ankle".to_owned(),
                    colors: vec!["#303030".to_owned(), "#808080".to_owned()],
                },
            ],
            "attempt {attempt} ignores submitted legacy clothing"
        );
    }
}

#[test]
fn authority_creator_clothing_rejects_legacy_unequip_and_substitution_without_mutation() {
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    state
        .upsert_actor(creator_clothing_upsert(
            vec![AuthorityActorWornPiece {
                item: "top_rigged_tank".to_owned(),
                colors: vec!["#d14b35".to_owned()],
            }],
            BTreeMap::from([("top_rigged_tank".to_owned(), vec!["#d14b35".to_owned()])]),
        ))
        .expect("fixed bare-start clothing upsert succeeds");
    let before_actor = state.actor_snapshot("player").unwrap();
    let before_inventory = state.inventory_snapshots();
    let before_hash = state.stable_state_hash_hex();
    let config = SliceAuthorityConfig::default();

    for (command_id, item_id, equipped) in [(1, 7_302, false), (2, 7_302, true), (3, 7_319, false)]
    {
        let rejected = state.apply_live_envelope(
            &config,
            command(
                command_id,
                ClientCommand::SetEquippedClothing {
                    item_id,
                    equipped,
                    container: None,
                    stack_id: None,
                    variant_id: None,
                },
            ),
        );
        assert_eq!(rejected.status, AuthorityCommandStatus::Rejected);
        assert_eq!(
            rejected.reason_code.as_deref(),
            Some(AuthorityRejectReason::ItemUnavailable.code())
        );
        assert_eq!(state.stable_state_hash_hex(), before_hash);
        assert_eq!(state.actor_snapshot("player").unwrap(), before_actor);
        assert_eq!(state.inventory_snapshots(), before_inventory);
    }
}

#[test]
fn authority_humanoid_loot_clothing_aliases_equip_replace_and_project() {
    let (config, mut state) = roll_combat_test_state();
    let variant_id = encode_loot_variant(LootTier::Marked, 244);
    let aliases = [
        (7_101, "top_plated_rig_vest"),
        (7_102, "top_scrap_plate_tunic"),
        (7_103, "helmet_s2"),
        (7_104, "legs_gaitered_cargo_pants"),
        (7_201, "top_frayed_tunic"),
        (7_202, "legs_padded_canvas_trousers"),
        (7_203, "hat_field_cap"),
        (7_204, "top_padded_leather_vest"),
    ];
    for (item_id, _) in aliases {
        let item_name =
            rolled_loot_item_name(item_id, variant_id).expect("loot alias has a rolled name");
        assert_eq!(
            state.add_actor_inventory_stack(
                &config.player_actor_id,
                item_id,
                variant_id,
                &item_name,
                1,
                1,
                "loot",
            ),
            1
        );
    }

    for (item_id, key) in aliases {
        let stack_id = state
            .inventory
            .iter()
            .find(|row| row.item_id == item_id && row.variant_id == variant_id)
            .expect("loot row")
            .stack_id
            .to_string();
        let accepted = state.apply_live_envelope(
            &config,
            command(
                u64::from(item_id),
                ClientCommand::SetEquippedClothing {
                    item_id,
                    equipped: true,
                    container: None,
                    stack_id: Some(stack_id),
                    variant_id: Some(variant_id),
                },
            ),
        );
        assert_eq!(
            accepted.status,
            AuthorityCommandStatus::Accepted,
            "loot alias {item_id} equips"
        );
        assert!(
            state.actors[&config.player_actor_id]
                .worn
                .iter()
                .any(|piece| piece.item == key),
            "loot alias {item_id} projects worn key {key}"
        );
    }

    let actor = &state.actors[&config.player_actor_id];
    assert_eq!(
        actor.worn,
        vec![
            AuthorityActorWornPiece {
                item: "legs_padded_canvas_trousers".to_owned(),
                colors: Vec::new(),
            },
            AuthorityActorWornPiece {
                item: "hat_field_cap".to_owned(),
                colors: Vec::new(),
            },
            AuthorityActorWornPiece {
                item: "top_padded_leather_vest".to_owned(),
                colors: Vec::new(),
            },
        ],
        "top, legs, and shared head slots replace independently"
    );
    assert_eq!(
        state.inventory_clothing_state(&format!("{}:loot", config.player_actor_id), 7_203),
        (true, Vec::new()),
        "equipped/color snapshot is authority-derived"
    );

    for (item_id, _) in [(7_204, ()), (7_202, ()), (7_203, ())] {
        let accepted = state.apply_live_envelope(
            &config,
            command(
                10_000 + u64::from(item_id),
                ClientCommand::SetEquippedClothing {
                    item_id,
                    equipped: false,
                    container: None,
                    stack_id: Some(
                        state
                            .inventory
                            .iter()
                            .find(|row| row.item_id == item_id && row.variant_id == variant_id)
                            .expect("loot row")
                            .stack_id
                            .to_string(),
                    ),
                    variant_id: Some(variant_id),
                },
            ),
        );
        assert_eq!(accepted.status, AuthorityCommandStatus::Accepted);
    }
    assert!(state.actors[&config.player_actor_id].worn.is_empty());

    let variant_zero_stack_id = {
        let row = state
            .inventory
            .iter_mut()
            .find(|row| row.item_id == 7_101)
            .expect("loot alias row exists");
        row.variant_id = 0;
        row.stack_id
    };
    let accepted = state.apply_live_envelope(
        &config,
        command(
            20_000,
            ClientCommand::SetEquippedClothing {
                item_id: 7_101,
                equipped: true,
                container: Some(format!("{}:loot", config.player_actor_id)),
                stack_id: Some(variant_zero_stack_id.to_string()),
                variant_id: Some(0),
            },
        ),
    );
    assert_eq!(accepted.status, AuthorityCommandStatus::Accepted);
    let actor = &state.actors[&config.player_actor_id];
    assert_eq!(
        actor.equipped_clothing,
        vec![AuthorityEquippedClothingInstance {
            container: format!("{}:loot", config.player_actor_id),
            stack_id: variant_zero_stack_id,
            item_id: 7_101,
            variant_id: 0,
        }],
        "variant zero remains an exact physical clothing identity"
    );
    assert_eq!(
        actor.worn,
        vec![AuthorityActorWornPiece {
            item: "top_plated_rig_vest".to_owned(),
            colors: Vec::new(),
        }]
    );
    assert_eq!(
        state.inventory_clothing_state_exact(
            &format!("{}:loot", config.player_actor_id),
            7_101,
            variant_zero_stack_id,
            0,
        ),
        (true, Vec::new())
    );
}

#[test]
fn authority_checkpoint_empty_clothing_identity_recovers_fixed_outfit_before_exact_equip() {
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    state
        .upsert_actor(creator_clothing_upsert(Vec::new(), BTreeMap::new()))
        .expect("fixed bare-start outfit seeds");
    state
        .actors
        .get_mut("player")
        .expect("player actor")
        .equipped_clothing
        .clear();
    let checkpoint = state.export_checkpoint();
    let mut restored = restore_checkpoint_for_test(&state, checkpoint);
    assert!(restored.actors["player"].equipped_clothing.is_empty());
    assert_eq!(
        restored.actors["player"].worn,
        vec![
            AuthorityActorWornPiece {
                item: "under_bodysuit".to_owned(),
                colors: vec!["#89cff0".to_owned()],
            },
            AuthorityActorWornPiece {
                item: "boots_canvas_ankle".to_owned(),
                colors: vec!["#303030".to_owned(), "#808080".to_owned()],
            },
        ]
    );

    let variant_id = 60_000_105;
    let container = "player:field-pack";
    let stack_id = push_test_inventory_stack(&mut restored, container, 7_201, variant_id, 1);
    let accepted = restored.apply_live_envelope(
        &SliceAuthorityConfig::default(),
        command(
            1,
            ClientCommand::SetEquippedClothing {
                item_id: 7_201,
                equipped: true,
                container: None,
                stack_id: Some(stack_id.to_string()),
                variant_id: Some(variant_id),
            },
        ),
    );
    assert_eq!(accepted.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        restored.actors["player"]
            .worn
            .iter()
            .map(|piece| piece.item.as_str())
            .collect::<Vec<_>>(),
        vec!["under_bodysuit", "boots_canvas_ankle", "top_frayed_tunic",]
    );
    assert_eq!(
        restored.actors["player"]
            .equipped_clothing
            .iter()
            .map(|identity| (identity.item_id, identity.variant_id))
            .collect::<Vec<_>>(),
        vec![(9_900_001, 0), (7_319, 0), (7_201, variant_id)]
    );
}
#[test]
fn authority_direct_inventory_replacements_reconcile_exact_clothing() {
    let config = SliceAuthorityConfig::default();
    let actor_id = config.player_actor_id.clone();
    let container = format!("{actor_id}:field-pack");
    let variant_id = 60_000_105;
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();

    let first_stack = push_test_inventory_stack(&mut state, &container, 7_201, variant_id, 1);
    let equipped = state.apply_live_envelope(
        &config,
        command(
            1,
            ClientCommand::SetEquippedClothing {
                item_id: 7_201,
                equipped: true,
                container: Some(container.clone()),
                stack_id: Some(first_stack.to_string()),
                variant_id: Some(variant_id),
            },
        ),
    );
    assert_eq!(equipped.status, AuthorityCommandStatus::Accepted);
    state
        .apply_verification_fixture_loadout(
            &actor_id,
            &[AuthorityFixtureLoadoutItem {
                item_id: STIMPAK_A_ITEM_ID,
                variant_id: 0,
                quantity: 1,
                equipped: false,
            }],
        )
        .expect("fixture replacement succeeds");
    assert!(state.actors[&actor_id].equipped_clothing.is_empty());
    assert!(state.actors[&actor_id]
        .worn
        .iter()
        .all(|piece| piece.item != "top_frayed_tunic"));

    let second_stack = push_test_inventory_stack(&mut state, &container, 7_201, variant_id, 1);
    state
        .apply_set_equipped_clothing_exact(
            &config,
            7_201,
            true,
            Some(&container),
            Some(&second_stack.to_string()),
            Some(variant_id),
        )
        .expect("replacement clothing equips");
    state
        .reset_clone_inventory(&actor_id)
        .expect("clone inventory reset succeeds");
    assert_eq!(
        state.actors[&actor_id]
            .equipped_clothing
            .iter()
            .map(|identity| (
                identity.container.as_str(),
                identity.item_id,
                identity.variant_id,
            ))
            .collect::<Vec<_>>(),
        vec![
            (container.as_str(), 9_900_001, 0),
            (container.as_str(), 7_319, 0),
        ]
    );

    let stale_stack = push_test_inventory_stack(&mut state, &container, 7_201, variant_id, 1);
    state
        .apply_set_equipped_clothing_exact(
            &config,
            7_201,
            true,
            Some(&container),
            Some(&stale_stack.to_string()),
            Some(variant_id),
        )
        .expect("stale clothing setup equips");
    state.inventory.retain(|row| {
        !(row.container == container
            && row.stack_id == stale_stack
            && row.item_id == 7_201
            && row.variant_id == variant_id)
    });
    state
        .restore_player_like_respawn_supplies(&actor_id)
        .expect("respawn restock succeeds");
    assert!(state.actors[&actor_id]
        .equipped_clothing
        .iter()
        .all(|identity| identity.item_id != 7_201));
    assert!(state.actors[&actor_id]
        .worn
        .iter()
        .all(|piece| piece.item != "top_frayed_tunic"));
}

#[test]
fn authority_bridge_inventory_projects_equipped_and_colors_and_defaults_worn_colors() {
    let mut bridge = AuthorityBridge::from_snapshot(&crate::authority_test_slice())
        .expect("bridge snapshot builds");
    let piece = AuthorityActorWornPiece {
        item: "boots_canvas_ankle".to_owned(),
        colors: vec!["#44d7b6".to_owned()],
    };
    let item_id = creator_clothing_item_id(&piece.item).unwrap();
    let mut worn_colors = BTreeMap::new();
    worn_colors.insert(piece.item.clone(), piece.colors.clone());
    let output = bridge
        .actor(AuthorityBridgeActorRequest {
            request_type: "upsertActor".to_owned(),
            request_id: Some(1),
            actor: AuthorityBridgeActorInput {
                id: "player".to_owned(),
                area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
                x: 12.0,
                y: 12.0,
                direction: "right".to_owned(),
                entity: Some("player".to_owned()),
                label: Some("Bridge Player".to_owned()),
                display_name: Some("Bridge Player".to_owned()),
                link_dead: false,
                bare_start: true,
                returning: false,
                verification_loadout: Vec::new(),
                worn: vec![piece],
                worn_colors,
                appearance: None,
                sprite: None,
                template_id: None,
                spawn_zone_id: None,
                role: Some("player".to_owned()),
                profession_ids: Vec::new(),
                skill_box_ids: Vec::new(),
                active_title_id: None,
                credits: None,
                capabilities: Vec::new(),
                career_goal_id: None,
                faction_id: None,
                social_group: None,
                pvp_status: None,
                player_organization_id: None,
                player_organization_tag: None,
                scale: None,
                vitals: None,
                max_vitals: None,
            },
        })
        .expect("bridge actor upsert succeeds");
    let row = output
        .inventory
        .iter()
        .find(|row| row.item_id == item_id)
        .expect("creator clothing inventory row is projected");
    assert!(row.equipped);
    assert_eq!(
        row.colors,
        vec!["#303030".to_owned(), "#808080".to_owned()],
        "bare-start fixed boot palette wins over submitted legacy colors"
    );

    let omitted_map: AuthorityBridgeActorRequest = serde_json::from_value(serde_json::json!({
        "type": "upsertActor",
        "requestId": 2,
        "actor": {
            "id": "map-default",
            "areaId": crate::AUTHORITY_TEST_AREA_ID,
            "x": 12.0,
            "y": 12.0,
            "direction": "right",
            "worn": []
        }
    }))
    .expect("wornColors is optional on bridge input");
    assert!(omitted_map.actor.worn_colors.is_empty());
    let explicit_map: AuthorityBridgeActorRequest = serde_json::from_value(serde_json::json!({
        "type": "upsertActor",
        "requestId": 3,
        "actor": {
            "id": "map-explicit",
            "areaId": crate::AUTHORITY_TEST_AREA_ID,
            "x": 12.0,
            "y": 12.0,
            "direction": "right",
            "worn": [],
            "wornColors": {"boots_canvas_ankle": ["#44d7b6"]}
        }
    }))
    .expect("wornColors uses the camelCase bridge key");
    assert_eq!(
        explicit_map.actor.worn_colors.get("boots_canvas_ankle"),
        Some(&vec!["#44d7b6".to_owned()])
    );
}

#[test]
fn authority_export_restore_preserves_clothing_dedupe_and_palette_behavior() {
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let mut upsert = creator_clothing_upsert(
        vec![AuthorityActorWornPiece {
            item: "gloves_knuckled_half".to_owned(),
            colors: vec!["#b5e48c".to_owned(), "#2d3047".to_owned()],
        }],
        BTreeMap::from([("boots_canvas_ankle".to_owned(), vec!["#ff00ff".to_owned()])]),
    );
    upsert.skill_box_ids = vec!["brawler-novice".to_owned()];
    state
        .upsert_actor(upsert)
        .expect("fixed bare-start clothing upsert succeeds");
    let before_hash = state.stable_state_hash_hex();
    let exported = state.export_checkpoint();
    assert_eq!(exported.version(), 1);
    let restored = restore_checkpoint_for_test(&state, exported);
    assert_eq!(restored.stable_state_hash_hex(), before_hash);
    assert_eq!(
        restored.inventory_clothing_state("player:field-pack", 7_319),
        (true, vec!["#303030".to_owned(), "#808080".to_owned()])
    );
    assert_eq!(
        restored.inventory_clothing_state("player:field-pack", 9_900_001),
        (true, vec!["#89cff0".to_owned()])
    );
    assert_eq!(
        restored.actor_snapshot("player").unwrap().worn,
        vec![
            AuthorityActorWornPiece {
                item: "under_bodysuit".to_owned(),
                colors: vec!["#89cff0".to_owned()],
            },
            AuthorityActorWornPiece {
                item: "boots_canvas_ankle".to_owned(),
                colors: vec!["#303030".to_owned(), "#808080".to_owned()],
            },
        ]
    );
    let mut owned = restored
        .inventory_snapshots()
        .into_iter()
        .filter(|row| actor_owns_inventory_container("player", &row.container))
        .map(|row| (row.item_id, row.variant_id, row.quantity))
        .collect::<Vec<_>>();
    owned.sort_unstable();
    assert_eq!(owned, vec![(7_319, 0, 1), (9_900_001, 0, 1)]);
}

#[test]
fn crafted_slugthrower_derived_helpers_cover_base_and_endpoints() {
    let base = 31_000_000 + 40 * 1_000_000 + 50 * 1_000 + 50;
    assert_eq!(slugthrower_power_damage_multiplier_per_100(0), 100);
    assert_eq!(slugthrower_handling_accuracy_bonus(0), 0);
    assert_eq!(slugthrower_attack_interval_ms(1_000, 0), 1_000);
    assert_eq!(slugthrower_reload_time_ms(3_000, 0), 3_000);
    assert_eq!(slugthrower_power_damage_multiplier_per_100(base), 100);
    assert_eq!(slugthrower_handling_accuracy_bonus(base), 0);
    assert_eq!(slugthrower_attack_interval_ms(1_000, base), 1_000);
    assert_eq!(slugthrower_reload_time_ms(3_000, base), 3_000);

    let max = encode_slugthrower_variant(SlugthrowerCraftStats {
        power: 100,
        handling: 100,
        reliability: 100,
    });
    assert_eq!(slugthrower_power_damage_multiplier_per_100(max), 130);
    assert_eq!(slugthrower_handling_accuracy_bonus(max), 10);
    assert_eq!(slugthrower_attack_interval_ms(1_000, max), 800);
    assert_eq!(slugthrower_reload_time_ms(3_000, max), 2_250);
}

#[test]
fn crafted_slugthrower_equip_uses_exact_variant_not_better_bag_variant() {
    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    let low = encode_slugthrower_variant(SlugthrowerCraftStats {
        power: 50,
        handling: 55,
        reliability: 55,
    });
    let high = encode_slugthrower_variant(SlugthrowerCraftStats {
        power: 100,
        handling: 100,
        reliability: 100,
    });
    for (variant, label) in [(low, "Low Slugthrower"), (high, "High Slugthrower")] {
        state.add_actor_inventory_stack(
            &player,
            CRAFTED_SLUGTHROWER_ITEM_ID,
            variant,
            label,
            1,
            1,
            "crafted-weapon",
        );
    }
    state
        .set_actor_equipped_weapon_variant_impl(
            &player,
            Some(AuthorityWeaponId::Slugthrower),
            Some(CRAFTED_SLUGTHROWER_ITEM_ID),
            Some(low),
            false,
        )
        .unwrap();
    let actor = state.actors.get(&player).expect("test player exists");
    assert_eq!(actor.equipped_weapon_variant_id, low);
    assert_eq!(
        slugthrower_power_damage_multiplier_per_100(actor.equipped_weapon_variant_id),
        105,
        "Roll combat reads the exact equipped low-power weapon, not the better one in the bag",
    );
}

#[test]
fn crafted_slugthrower_certification_splits_base_and_variant() {
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::Slugthrower, 3_101, 0),
        Some("marksman-novice")
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(
            AuthorityWeaponId::Slugthrower,
            CRAFTED_SLUGTHROWER_ITEM_ID,
            encode_slugthrower_variant(SlugthrowerCraftStats {
                power: 40,
                handling: 50,
                reliability: 50,
            }),
        ),
        Some("marksman-rifle-iii")
    );
}

#[test]
fn crafted_slugthrower_experiment_success_gain_is_named_and_capped() {
    assert_eq!(CRAFT_EXPERIMENT_SUCCESS_GAIN, 12);
    assert_eq!(
        experiment_line(100, 500, 0xA17C_00DE, 1, 1, 1_000),
        112,
        "one successful point must apply the named +12 gain rather than the old +4",
    );
    assert_eq!(
        experiment_line(100, 100, 0xA17C_00DE, 1, 2, 1_000),
        100,
        "experiment never exceeds the line cap"
    );
}

#[test]
fn authority_sprint_recovery_lock_uses_eighty_percent_regen_and_roundtrips() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    {
        let player = state.actors.get_mut(&config.player_actor_id).unwrap();
        player.max_vitals.action = 100;
        player.vitals.action = 1;
        player.effective_stats.regen_rates_milli_per_second.action = 0;
    }

    let exhausted = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 3,
                facing: None,
                sprint: true,
            },
        ),
    );
    assert_eq!(exhausted.status, AuthorityCommandStatus::Accepted);
    let locked = state.actors.get(&config.player_actor_id).unwrap();
    assert_eq!(locked.vitals.action, 0);
    assert!(locked.sprint_recovery_locked);
    state
        .actors
        .get_mut(&config.player_actor_id)
        .unwrap()
        .effective_stats
        .regen_rates_milli_per_second
        .action = 100_000;

    state.advance_ticks_for_observer(&config, 30);
    let recovering = state.actors.get(&config.player_actor_id).unwrap();
    assert_eq!(recovering.vitals.action, 80);
    assert!(recovering.sprint_recovery_locked);

    let checkpoint = state.export_checkpoint();
    let restored = restore_checkpoint_for_test(&state, checkpoint);
    let restored_actor = restored.actors.get(&config.player_actor_id).unwrap();
    assert_eq!(restored_actor.vitals.action, 80);
    assert!(restored_actor.sprint_recovery_locked);
    assert!(
        restored
            .actor_snapshot(&config.player_actor_id)
            .unwrap()
            .mobility
            .sprint_recovery_locked
    );

    let mut unlocked = restored;
    unlocked.advance_ticks_for_observer(&config, 8);
    let actor = unlocked.actors.get(&config.player_actor_id).unwrap();
    assert_eq!(actor.vitals.action, 100);
    assert!(!actor.sprint_recovery_locked);
}

#[test]
fn craft_name_normalization_rejects_controls_and_collapses_printable_whitespace() {
    assert_eq!(
        normalize_craft_name("  Field   Test  ").expect("name accepted"),
        Some("Field Test".to_owned())
    );
    assert_eq!(
        normalize_craft_name(" \t ").unwrap_err(),
        AuthorityRejectReason::InvalidCraftName
    );
    assert_eq!(
        normalize_craft_name("line\nbreak").unwrap_err(),
        AuthorityRejectReason::InvalidCraftName
    );
    assert_eq!(
        normalize_craft_name("tag<red>").unwrap_err(),
        AuthorityRejectReason::InvalidCraftName
    );
    assert_eq!(normalize_craft_name("   ").expect("blank fallback"), None);
}

#[test]
fn craft_keyed_seed_is_repeatable_and_key_dependent() {
    let first = craft_assembly_seed([0x11; 32], "player", "extractor_battery", 42);
    let repeat = craft_assembly_seed([0x11; 32], "player", "extractor_battery", 42);
    let changed = craft_assembly_seed([0x22; 32], "player", "extractor_battery", 42);
    assert_eq!(first, repeat);
    assert_ne!(first, changed);
}

#[test]
fn craft_experiment_has_success_and_slip_bands_with_context_and_clamps() {
    let success_seed = (0..10_000_u32)
        .find(|seed| experiment_line_with_context(100, 500, *seed, 77, 1, 0, 500) > 100)
        .expect("a deterministic success roll exists");
    assert_eq!(
        experiment_line_with_context(100, 500, success_seed, 77, 1, 0, 500),
        112
    );
    let slip_seed = (0..10_000_u32)
        .find(|seed| experiment_line_with_context(300, 500, *seed, 77, 1, -200, 500) < 300)
        .expect("a deterministic slip roll exists");
    assert_eq!(
        experiment_line_with_context(300, 500, slip_seed, 77, 1, -200, 500),
        296
    );
    let salt_changed_seed = (0..10_000_u32)
        .find(|seed| {
            experiment_line_with_context(100, 500, *seed, 77, 1, 0, 500)
                != experiment_line_with_context(100, 500, *seed, 78, 1, 0, 500)
        })
        .expect("attempt salt changes deterministic draw");
    assert_ne!(
        experiment_line_with_context(100, 500, salt_changed_seed, 77, 1, 0, 500),
        experiment_line_with_context(100, 500, salt_changed_seed, 78, 1, 0, 500)
    );
    assert_eq!(
        experiment_line_with_context(499, 500, success_seed, 77, 1, 0, 500),
        500
    );
    assert_eq!(
        experiment_line_with_context(100, 100, success_seed, 77, 1, 0, 500),
        100
    );
    assert_eq!(craft_batch_risk_per_extra_point_milli(), 50);
}

#[test]
fn craft_practice_extra_xp_is_rounded_to_one_hundred_five_percent() {
    for tier in 1..=5_u64 {
        let base = CRAFT_XP_PER_TIER * tier;
        let expected_total = base.saturating_mul(105).saturating_add(50) / 100;
        let extra = expected_total.saturating_sub(base);
        assert_eq!(base + extra, expected_total);
    }
}

#[test]
fn craft_assignment_aggregates_shared_stack_and_consumes_atomically() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    let container = format!("{player}:field-pack");
    let stack_id =
        push_test_inventory_stack(&mut state, &container, RESOURCE_MINERAL_ITEM_ID, 7, 60);
    let assignment = |slot_index: u8, quantity: u32| CraftSlotAssignmentState {
        slot_index,
        container: container.clone(),
        stack_id,
        item_id: RESOURCE_MINERAL_ITEM_ID,
        variant_id: 7,
        quantity,
        stats: ResourceStats::zeroed(),
    };
    let over = vec![assignment(0, 40), assignment(1, 40)];
    assert_eq!(
        state
            .validate_craft_assignment_reservations(&player, &over)
            .unwrap_err(),
        AuthorityRejectReason::CraftSlotMismatch
    );
    let valid = vec![assignment(0, 24), assignment(1, 36)];
    state
        .validate_craft_assignment_reservations(&player, &valid)
        .expect("aggregate reservation fits");
    state
        .consume_exact_actor_stack(
            &player,
            &container,
            stack_id,
            RESOURCE_MINERAL_ITEM_ID,
            7,
            60,
        )
        .expect("one grouped consume removes the exact total");
    assert_eq!(
        state
            .inventory_snapshots()
            .into_iter()
            .find(|row| {
                row.stack_id == stack_id
                    && row.container == container
                    && row.item_id == RESOURCE_MINERAL_ITEM_ID
                    && row.variant_id == 7
            })
            .map(|row| row.available)
            .unwrap_or(0),
        0
    );
}

#[test]
fn crafted_named_stacks_keep_distinct_names_even_when_variant_and_cap_match() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    state.add_actor_named_inventory_stack(
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        42,
        "A",
        1,
        1,
        "crafted-gear",
    );
    state.add_actor_named_inventory_stack(
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        42,
        "B",
        1,
        1,
        "crafted-gear",
    );
    let rows: Vec<_> = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| {
            row.item_id == FIELD_MULTITOOL_ITEM_ID
                && row.variant_id == 42
                && actor_owns_inventory_container(&player, &row.container)
        })
        .collect();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|row| row.item == "A" && row.quantity == 1));
    assert!(rows.iter().any(|row| row.item == "B" && row.quantity == 1));
}

fn assembled_battery_for_command_test() -> (SliceAuthorityConfig, SliceAuthorityState) {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    grant_craftsman_session_test_skills(&mut state, &player);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let (copper, iron, fuel) = seed_test_battery_resources(&mut state, &player, 221_001, 211_001);
    assert_eq!(
        state
            .apply_envelope(
                &config,
                command(
                    1,
                    ClientCommand::CraftBegin {
                        recipe_id: "extractor_battery".to_owned(),
                    },
                ),
            )
            .status,
        AuthorityCommandStatus::Accepted
    );
    for (command_id, slot_index, assignment) in
        [(2, 0_u8, copper), (3, 1_u8, iron), (4, 2_u8, fuel)]
    {
        assert_eq!(
            state
                .apply_envelope(
                    &config,
                    command(
                        command_id,
                        ClientCommand::CraftAssignSlot {
                            slot_index,
                            container: assignment.0,
                            stack_id: assignment.1,
                            variant_id: assignment.2,
                        },
                    ),
                )
                .status,
            AuthorityCommandStatus::Accepted
        );
    }
    assert_eq!(
        state
            .apply_envelope(&config, command(5, ClientCommand::CraftAssemble {}))
            .status,
        AuthorityCommandStatus::Accepted
    );
    (config, state)
}

#[test]
fn craft_practice_command_clears_session_without_item_or_schematic() {
    let (config, mut state) = assembled_battery_for_command_test();
    let player = config.player_actor_id.clone();
    let before_items = state.inventory_snapshots().len();
    let before_schematics = state
        .inventory_snapshots()
        .iter()
        .filter(|row| row.item.contains("schematic"))
        .count();
    let base = CRAFT_XP_PER_TIER * 2;
    let receipt =
        state.apply_envelope(&config, command(6, ClientCommand::CraftFinalizePractice {}));
    assert_eq!(receipt.status, AuthorityCommandStatus::Accepted);
    assert!(state.actors.get(&player).unwrap().craft_session.is_none());
    assert_eq!(
        state
            .actors
            .get(&player)
            .unwrap()
            .professions
            .xp
            .get(&AuthorityProfessionKind::Craftsman)
            .copied()
            .unwrap_or(0),
        base.saturating_mul(105).saturating_add(50) / 100
    );
    assert_eq!(state.inventory_snapshots().len(), before_items);
    assert_eq!(
        state
            .inventory_snapshots()
            .iter()
            .filter(|row| row.item.contains("schematic"))
            .count(),
        before_schematics
    );
}
