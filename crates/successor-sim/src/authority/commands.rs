use super::*;

fn consumable_duration_ticks_for_speed(base_ticks: u16, speed_milli: i32) -> u16 {
    let speed_milli = u32::try_from(speed_milli.max(1)).unwrap_or(1);
    let scaled = u32::from(base_ticks)
        .saturating_mul(1_000)
        .saturating_add(speed_milli.saturating_sub(1))
        / speed_milli;
    u16::try_from(scaled.max(1)).unwrap_or(u16::MAX)
}

impl SliceAuthorityState {
    pub fn apply_envelope(
        &mut self,
        config: &SliceAuthorityConfig,
        envelope: ClientCommandEnvelope,
    ) -> AuthorityCommandFrame {
        let previous_state_hash = self.stable_state_hash_hex();
        let baseline_tick = self.runtime.durable.tick;
        self.runtime.durable.tick = self.runtime.durable.tick.saturating_add(1);
        let combat_events = self.advance_authority_tick();
        let command_hash = envelope.stable_hash_hex();
        let command_id = envelope.command_id;
        let player = envelope.player;
        self.runtime.pending_survey_result = None;
        self.runtime.pending_craft_session = None;
        self.runtime.pending_splice_session = None;
        self.runtime.pending_genome_scan = None;
        self.runtime.pending_harvest = None;
        self.runtime.pending_factory_receipt = None;
        self.runtime.pending_parcel_claim = None;
        let reject_reason = self.validate_envelope(config, &envelope).err();
        let result = if let Some(reason) = reject_reason {
            Err(reason)
        } else {
            self.apply_command(config, &envelope)
        };
        if result.is_ok() {
            self.reconcile_all_actor_clothing();
        }
        let target_state_hash = self.stable_state_hash_hex();
        let bundle = self.delta_bundle(
            config,
            baseline_tick,
            &previous_state_hash,
            &target_state_hash,
            &combat_events,
        );
        let bundle_hash = bundle.stable_hash_hex();
        let mut frame = ServerTickDeliveryFrame::from_bundle(
            config.session,
            TickIndex(self.runtime.durable.tick),
            &bundle,
        );

        let (status, reason_code) = match result {
            Ok(()) => {
                frame.accepted.push(ServerCommandReceipt {
                    command_id,
                    player,
                    accepted_at_tick: self.runtime.durable.tick,
                    command_hash: command_hash.clone(),
                    resulting_state_hash: target_state_hash.clone(),
                });
                (AuthorityCommandStatus::Accepted, None)
            }
            Err(reason) => {
                let code = reason.code().to_owned();
                frame.rejected.push(ServerRejectedCommandReceipt {
                    command_id,
                    player,
                    rejected_at_tick: self.runtime.durable.tick,
                    command_hash: command_hash.clone(),
                    reason_code: code.clone(),
                });
                (AuthorityCommandStatus::Rejected, Some(code))
            }
        };
        let survey_result = self.runtime.pending_survey_result.take();
        let craft_session = self.runtime.pending_craft_session.take();
        let splice_session = self.runtime.pending_splice_session.take();
        let genome_scan = self.runtime.pending_genome_scan.take();
        let harvest = self.runtime.pending_harvest.take();
        let factory_receipt = self.runtime.pending_factory_receipt.take();
        let parcel_claim = self.runtime.pending_parcel_claim.take();
        let trade_session_deliveries =
            std::mem::take(&mut self.runtime.pending_trade_session_deliveries);
        let dialogue_deliveries = std::mem::take(&mut self.runtime.pending_dialogue_deliveries);
        let duel_outcomes = self.take_duel_outcomes();
        let ability_queue_events = self.take_ability_queue_events_for_observer(config);
        let frame_hash = frame.stable_hash_hex();
        AuthorityCommandFrame {
            command_id,
            status,
            reason_code,
            tick: self.runtime.durable.tick,
            command_hash,
            previous_state_hash,
            target_state_hash,
            bundle_hash,
            frame_hash,
            bundle,
            craft_session,
            splice_session,
            genome_scan,
            harvest,
            factory_receipt,
            parcel_claim,
            trade_session_deliveries,
            dialogue_deliveries,
            duel_outcomes,
            frame,
            actor: self.actor_snapshot(&config.player_actor_id),
            combat_events,
            ability_queue_events,
            survey_result,
        }
    }

    pub fn apply_live_envelope(
        &mut self,
        config: &SliceAuthorityConfig,
        envelope: ClientCommandEnvelope,
    ) -> AuthorityLiveCommandFrame {
        let command_id = envelope.command_id;
        self.runtime.pending_survey_result = None;
        self.runtime.pending_craft_session = None;
        self.runtime.pending_splice_session = None;
        self.runtime.pending_genome_scan = None;
        self.runtime.pending_harvest = None;
        self.runtime.pending_factory_receipt = None;
        self.runtime.pending_parcel_claim = None;
        let reject_reason = self.validate_envelope(config, &envelope).err();
        let result = if let Some(reason) = reject_reason {
            Err(reason)
        } else {
            self.apply_command(config, &envelope)
        };
        if result.is_ok() {
            self.reconcile_all_actor_clothing();
        }
        let combat_events = Vec::new();
        let (status, reason_code) = match result {
            Ok(()) => (AuthorityCommandStatus::Accepted, None),
            Err(reason) => (
                AuthorityCommandStatus::Rejected,
                Some(reason.code().to_owned()),
            ),
        };
        let survey_result = self.runtime.pending_survey_result.take();
        let craft_session = self.runtime.pending_craft_session.take();
        let splice_session = self.runtime.pending_splice_session.take();
        let genome_scan = self.runtime.pending_genome_scan.take();
        let harvest = self.runtime.pending_harvest.take();
        let factory_receipt = self.runtime.pending_factory_receipt.take();
        let parcel_claim = self.runtime.pending_parcel_claim.take();
        let trade_session_deliveries =
            std::mem::take(&mut self.runtime.pending_trade_session_deliveries);
        let dialogue_deliveries = std::mem::take(&mut self.runtime.pending_dialogue_deliveries);
        let duel_outcomes = self.take_duel_outcomes();
        let ability_queue_events = self.take_ability_queue_events_for_observer(config);
        AuthorityLiveCommandFrame {
            command_id,
            status,
            reason_code,
            tick: self.runtime.durable.tick,
            actor: self.actor_snapshot(&config.player_actor_id),
            combat_events,
            ability_queue_events,
            survey_result,
            craft_session,
            splice_session,
            genome_scan,
            harvest,
            factory_receipt,
            parcel_claim,
            trade_session_deliveries,
            dialogue_deliveries,
            duel_outcomes,
        }
    }

    pub fn apply_script(
        &mut self,
        config: &SliceAuthorityConfig,
        commands: Vec<ClientCommandEnvelope>,
    ) -> AuthorityReplay {
        let initial_state_hash = self.stable_state_hash_hex();
        let mut frames = Vec::with_capacity(commands.len());
        for command in commands {
            frames.push(self.apply_envelope(config, command));
        }
        let final_state_hash = self.stable_state_hash_hex();
        let replay_hash = stable_replay_hash(&initial_state_hash, &final_state_hash, &frames);
        AuthorityReplay {
            schema: AUTHORITY_SCHEMA.to_owned(),
            initial_state_hash,
            final_state_hash,
            replay_hash,
            metrics: self.metrics(),
            frames,
        }
    }

    pub(super) fn validate_envelope(
        &mut self,
        config: &SliceAuthorityConfig,
        envelope: &ClientCommandEnvelope,
    ) -> Result<(), AuthorityRejectReason> {
        if envelope.session != config.session {
            return Err(AuthorityRejectReason::WrongSession);
        }
        if envelope.player != config.player {
            return Err(AuthorityRejectReason::WrongPlayer);
        }
        let command_key = (envelope.session.0, envelope.player.0, envelope.command_id);
        if !self.runtime.durable.seen_commands.insert(command_key) {
            return Err(AuthorityRejectReason::DuplicateCommand);
        }
        if !self
            .runtime
            .durable
            .actors
            .contains_key(&config.player_actor_id)
        {
            return Err(AuthorityRejectReason::UnknownActor);
        }
        Ok(())
    }

    pub(super) fn apply_command(
        &mut self,
        config: &SliceAuthorityConfig,
        envelope: &ClientCommandEnvelope,
    ) -> Result<(), AuthorityRejectReason> {
        match &envelope.command {
            ClientCommand::Move {
                dx,
                dy,
                duration_ticks,
                facing,
                sprint,
            } => self.apply_move(
                config,
                envelope.issued_at_tick,
                *dx,
                *dy,
                *duration_ticks,
                *facing,
                *sprint,
            ),
            ClientCommand::SetMoveIntent {
                dx,
                dy,
                facing,
                sprint,
            } => self.apply_set_move_intent(config, *dx, *dy, *facing, *sprint),
            ClientCommand::QueueCombatAction {
                action_id,
                target_actor_id,
            } => combat_roll::queue_combat_action(
                self,
                &config.player_actor_id,
                action_id,
                target_actor_id,
            ),
            ClientCommand::Peace {} => combat_roll::request_peace(self, &config.player_actor_id),
            ClientCommand::CancelAbilityQueue {
                queue_entry_id,
                scope,
            } => combat_roll::cancel_ability_queue(
                self,
                &config.player_actor_id,
                queue_entry_id.as_deref(),
                scope.as_deref(),
            ),
            ClientCommand::ReloadWeapon {
                weapon_id,
                ammo_type,
            } => self.apply_reload(config, *weapon_id, *ammo_type),
            ClientCommand::SetEquippedWeapon {
                weapon_id,
                weapon_item_id,
                weapon_variant_id,
            } => self.apply_set_equipped_weapon(
                config,
                *weapon_id,
                *weapon_item_id,
                *weapon_variant_id,
            ),
            ClientCommand::SetEquippedClothing {
                item_id,
                equipped,
                container,
                stack_id,
                variant_id,
            } => self.apply_set_equipped_clothing_exact(
                config,
                *item_id,
                *equipped,
                container.as_deref(),
                stack_id.as_deref(),
                *variant_id,
            ),
            ClientCommand::SetPosture { posture } => self.apply_set_posture(config, posture),
            ClientCommand::EnterTransition { transition_id } => {
                self.apply_transition(config, transition_id)
            }
            ClientCommand::UseConsumable {
                item_id,
                item_numeric_id,
                variant_id,
            } => self.apply_consumable(config, item_id, *item_numeric_id, *variant_id),
            ClientCommand::RefillAmmo { item_id } => self.apply_ammo_refill(config, item_id),
            ClientCommand::ApplyServiceBuff { effect_id } => {
                self.apply_service_buff(config, effect_id)
            }
            ClientCommand::CloneRespawn { facility_id } => {
                self.apply_clone_respawn(config, facility_id.as_deref())
            }
            ClientCommand::ReviveActor { target_actor_id } => {
                self.apply_revive_actor(config, target_actor_id)
            }
            ClientCommand::BankStoreItem {
                source_stack_id,
                quantity,
            } => self.apply_bank_store_item(config, source_stack_id, *quantity),
            ClientCommand::BankRetrieveItem {
                bank_stack_id,
                quantity,
            } => self.apply_bank_retrieve_item(config, bank_stack_id, *quantity),
            ClientCommand::BankDepositCredits { amount } => {
                self.apply_bank_deposit_credits(config, *amount)
            }
            ClientCommand::BankWithdrawCredits { amount } => {
                self.apply_bank_withdraw_credits(config, *amount)
            }
            ClientCommand::CloneSaveSkillBackup {} => self.apply_clone_save_skill_backup(config),
            ClientCommand::CorpseTakeCredits { corpse_id } => {
                self.apply_corpse_take_credits(config, corpse_id)
            }
            ClientCommand::SampleResource { family, stop } => {
                self.apply_sample_resource(config, family, *stop)
            }
            ClientCommand::SurveyResource { family } => self.apply_survey_resource(config, family),
            ClientCommand::PlaceExtractor { family } => self.apply_place_extractor(config, family),
            ClientCommand::CrankExtractor { extractor_id } => {
                self.apply_crank_extractor(config, extractor_id)
            }
            ClientCommand::StopCrank {} => self.apply_stop_crank(config),
            ClientCommand::InsertBattery {
                extractor_id,
                container,
                stack_id,
                variant_id,
            } => self.apply_insert_battery(config, extractor_id, container, stack_id, *variant_id),
            ClientCommand::CollectExtractor { extractor_id } => {
                self.apply_collect_extractor(config, extractor_id)
            }
            ClientCommand::DestroyExtractor { extractor_id } => {
                self.apply_destroy_extractor(config, extractor_id)
            }
            ClientCommand::PlaceCamp {} => self.apply_place_camp(config),
            ClientCommand::PackUpCamp {} => self.apply_pack_up_camp(config),
            ClientCommand::DiscardStack {
                container,
                stack_id,
                item_id,
                variant_id,
            } => self.apply_discard_stack(config, container, stack_id, *item_id, *variant_id),
            ClientCommand::SplitStack {
                container,
                stack_id,
                item_id,
                variant_id,
                quantity,
            } => self.apply_split_stack(
                config,
                container,
                stack_id,
                *item_id,
                *variant_id,
                *quantity,
            ),
            ClientCommand::MergeStacks {
                container,
                source_stack_id,
                target_stack_id,
            } => self.apply_merge_stacks(config, container, source_stack_id, target_stack_id),
            ClientCommand::HarvestCorpse { target_actor_id } => {
                self.apply_harvest_corpse(config, target_actor_id)
            }
            ClientCommand::TakeLootItem {
                container,
                item_id,
                variant_id,
                quantity,
            } => self.apply_take_loot_item(config, container, *item_id, *variant_id, *quantity),
            ClientCommand::RedeemCreditChip {
                container,
                stack_id,
            } => self.apply_redeem_credit_chip(config, container, stack_id),
            ClientCommand::CraftItem {
                schematic_id,
                experiment_power,
                experiment_handling,
                experiment_reliability,
            } => self.apply_craft_item(
                config,
                schematic_id,
                *experiment_power,
                *experiment_handling,
                *experiment_reliability,
            ),
            ClientCommand::CraftBegin { recipe_id } => self.apply_craft_begin(config, recipe_id),
            ClientCommand::CraftAssignSlot {
                slot_index,
                container,
                stack_id,
                variant_id,
            } => {
                self.apply_craft_assign_slot(config, *slot_index, container, stack_id, *variant_id)
            }
            ClientCommand::CraftClearSlot { slot_index } => {
                self.apply_craft_clear_slot(config, *slot_index)
            }
            ClientCommand::CraftAssemble {} => self.apply_craft_assemble(config),
            ClientCommand::CraftExperiment { line_id, points } => {
                self.apply_craft_experiment(config, *line_id, *points)
            }
            ClientCommand::CraftFinalizePrototype { custom_name } => {
                self.apply_craft_finalize_prototype(config, custom_name)
            }
            ClientCommand::CraftFinalizePractice {} => self.apply_craft_finalize_practice(config),
            ClientCommand::CraftDraftSchematic { max_uses } => {
                self.apply_craft_draft_schematic(config, *max_uses)
            }
            ClientCommand::FactoryManufacture {
                factory_id,
                schematic_id,
            } => self.apply_factory_manufacture(config, factory_id, schematic_id),
            ClientCommand::CraftCancel {} => self.apply_craft_cancel(config),
            ClientCommand::RequestStarterTool { trainer_actor_id } => {
                self.apply_request_starter_tool(config, trainer_actor_id)
            }
            ClientCommand::PurchaseSkillBox {
                skill_box_id,
                trainer_actor_id,
            } => self.apply_purchase_skill_box(config, skill_box_id, trainer_actor_id),
            ClientCommand::UnlearnSkillBox {
                skill_box_id,
                trainer_actor_id,
            } => self.apply_unlearn_skill_box(config, skill_box_id, trainer_actor_id),
            ClientCommand::SetProfessionTitle { title_id } => {
                self.apply_set_profession_title(config, title_id.as_deref())
            }
            ClientCommand::SetCareerGoal {
                goal_id,
                trainer_actor_id,
            } => self.apply_set_career_goal(config, goal_id, trainer_actor_id),
            ClientCommand::StoreToExchange {
                item_id,
                variant_id,
                quantity,
            } => self.apply_store_to_exchange(config, *item_id, *variant_id, *quantity),
            ClientCommand::RetrieveFromExchange {
                item_id,
                variant_id,
                quantity,
            } => self.apply_retrieve_from_exchange(config, *item_id, *variant_id, *quantity),
            ClientCommand::ProposeTrade {
                partner_actor_id,
                offer,
                request,
            } => self.apply_propose_trade(config, partner_actor_id, offer, request),
            ClientCommand::AcceptTrade { proposal_id } => {
                self.apply_accept_trade(config, *proposal_id)
            }
            ClientCommand::DeclineTrade { proposal_id } => {
                self.apply_decline_trade(config, *proposal_id)
            }
            ClientCommand::AddTradeItem { proposal_id, item } => {
                self.apply_add_trade_item(config, *proposal_id, item)
            }
            ClientCommand::RemoveTradeItem { proposal_id, item } => {
                self.apply_remove_trade_item(config, *proposal_id, item)
            }
            ClientCommand::SetTradeCoin {
                proposal_id,
                amount,
            } => self.apply_set_trade_coin(config, *proposal_id, *amount),
            ClientCommand::ConfirmTrade { proposal_id } => {
                self.apply_confirm_trade(config, *proposal_id)
            }
            ClientCommand::DebugGiveItem {
                item_id,
                variant_id,
                quantity,
                equip,
            } => self.apply_debug_give_item(config, *item_id, *variant_id, *quantity, *equip),
            ClientCommand::DebugGrantSkillBoxes { skill_box_ids } => {
                self.apply_debug_grant_skill_boxes(config, skill_box_ids)
            }
            ClientCommand::GroupInvite { target_actor_id } => {
                self.apply_group_invite(config, target_actor_id)
            }
            ClientCommand::GroupAccept {} => self.apply_group_accept(config),
            ClientCommand::GroupDecline {} => self.apply_group_decline(config),
            ClientCommand::GroupLeave {} => self.apply_group_leave(config),
            ClientCommand::GroupDisband {} => self.apply_group_disband(config),
            ClientCommand::GroupKick { target_actor_id } => {
                self.apply_group_kick(config, target_actor_id)
            }
            ClientCommand::DuelChallenge { target_actor_id } => {
                self.apply_duel_challenge(config, target_actor_id)
            }
            ClientCommand::DuelAccept {} => self.apply_duel_accept(config),
            ClientCommand::DuelDecline {} => self.apply_duel_decline(config),
            ClientCommand::DuelYield {} => self.apply_duel_yield(config),
            ClientCommand::Deathblow { target_actor_id } => {
                self.apply_deathblow(config, target_actor_id)
            }
            ClientCommand::GeneSample { species } => self.apply_gene_sample(config, species),
            ClientCommand::ScanGenome {
                container,
                stack_id,
                variant_id,
            } => self.apply_scan_genome(config, container, stack_id, *variant_id),
            ClientCommand::SpliceBegin { species } => self.apply_splice_begin(config, species),
            ClientCommand::SpliceAssignSlot {
                slot_index,
                container,
                stack_id,
                variant_id,
            } => {
                self.apply_splice_assign_slot(config, *slot_index, container, stack_id, *variant_id)
            }
            ClientCommand::SpliceClearSlot { slot_index } => {
                self.apply_splice_clear_slot(config, *slot_index)
            }
            ClientCommand::SpliceChooseAllele {
                locus,
                from_parent,
                allele,
            } => self.apply_splice_choose_allele(config, *locus, *from_parent, *allele),
            ClientCommand::SpliceAssemble {} => self.apply_splice_assemble(config),
            ClientCommand::SpliceExperimentLocus { locus, points } => {
                self.apply_splice_experiment_locus(config, *locus, *points)
            }
            ClientCommand::SpliceMint { cultivar_name } => {
                self.apply_splice_mint(config, cultivar_name.as_deref())
            }
            ClientCommand::SpliceCancel {} => self.apply_splice_cancel(config),
            ClientCommand::ClaimParcel {
                planet_id,
                area_id,
                x,
                y,
                tier,
            } => self.apply_claim_parcel(config, planet_id, area_id, *x, *y, tier),
            ClientCommand::AbandonParcel { parcel_id } => {
                self.apply_abandon_parcel(config, parcel_id)
            }
            ClientCommand::RenameParcel { parcel_id, name } => {
                self.apply_rename_parcel(config, parcel_id, name)
            }
            ClientCommand::PayUpkeep { parcel_id } => self.apply_pay_upkeep(config, parcel_id),
            ClientCommand::TillTile {
                parcel_id,
                cell_x,
                cell_y,
            } => self.apply_till_tile(config, parcel_id, *cell_x, *cell_y),
            ClientCommand::PlantSeed {
                parcel_id,
                cell_x,
                cell_y,
                container,
                stack_id,
                variant_id,
            } => self.apply_plant_seed(
                config,
                parcel_id,
                *cell_x,
                *cell_y,
                container,
                stack_id,
                *variant_id,
            ),
            ClientCommand::ClearTile {
                parcel_id,
                cell_x,
                cell_y,
            } => self.apply_clear_tile(config, parcel_id, *cell_x, *cell_y),
            ClientCommand::WaterTile {
                parcel_id,
                cell_x,
                cell_y,
            } => self.apply_water_tile(config, parcel_id, *cell_x, *cell_y),
            ClientCommand::TendPlot { parcel_id, stop } => {
                self.apply_tend_plot(config, parcel_id, *stop)
            }
            ClientCommand::PlaceFarmStructure {
                parcel_id,
                structure_item_id,
                cell_x,
                cell_y,
            } => self.apply_place_farm_structure(
                config,
                parcel_id,
                *structure_item_id,
                *cell_x,
                *cell_y,
            ),
            ClientCommand::RemoveFarmStructure {
                parcel_id,
                structure_id,
            } => self.apply_remove_farm_structure(config, parcel_id, structure_id),
            ClientCommand::BuildPlace {
                catalog_id,
                parcel_id,
                cell_x,
                cell_y,
                rotation_quarters,
                palette,
            } => self.apply_build_place(
                config,
                catalog_id,
                parcel_id,
                *cell_x,
                *cell_y,
                *rotation_quarters,
                palette.as_ref(),
            ),
            ClientCommand::BuildRemove { component_id } => {
                self.apply_build_remove(config, component_id)
            }
            ClientCommand::BuildToggleDoor { component_id } => {
                self.apply_build_toggle_door(config, component_id)
            }
            ClientCommand::Fertilize {
                parcel_id,
                cell_x,
                cell_y,
                container,
                stack_id,
                variant_id,
            } => self.apply_fertilize(
                config,
                parcel_id,
                *cell_x,
                *cell_y,
                container,
                stack_id,
                *variant_id,
            ),
            ClientCommand::HarvestCrop {
                parcel_id,
                cell_x,
                cell_y,
            } => self.apply_harvest_crop(config, parcel_id, *cell_x, *cell_y),
            ClientCommand::GuildCreate {
                name,
                tag,
                terminal_prop_id,
            } => self.apply_guild_create(config, name, tag, terminal_prop_id),
            ClientCommand::GuildInvite { target_actor_id } => {
                self.apply_guild_invite(config, target_actor_id)
            }
            ClientCommand::GuildAcceptInvite { invite_id } => {
                self.apply_guild_accept_invite(config, invite_id)
            }
            ClientCommand::GuildDeclineInvite { invite_id } => {
                self.apply_guild_decline_invite(config, invite_id)
            }
            ClientCommand::GuildLeave {} => self.apply_guild_leave(config),
            ClientCommand::GuildKick { target_actor_id } => {
                self.apply_guild_kick(config, target_actor_id)
            }
            ClientCommand::GuildSetRole {
                target_actor_id,
                role,
            } => self.apply_guild_set_role(config, target_actor_id, role),
            ClientCommand::GuildSetPermissions {
                target_actor_id,
                permissions,
            } => self.apply_guild_set_permissions(config, target_actor_id, *permissions),
            ClientCommand::GuildTransferLeadership { target_actor_id } => {
                self.apply_guild_transfer_leadership(config, target_actor_id)
            }
            ClientCommand::GuildDeclareWar { opposing_guild_id } => {
                self.apply_guild_declare_war(config, opposing_guild_id)
            }
            ClientCommand::GuildAcceptWar { opposing_guild_id } => {
                self.apply_guild_accept_war(config, opposing_guild_id)
            }
            ClientCommand::GuildRescindWar { opposing_guild_id } => {
                self.apply_guild_rescind_war(config, opposing_guild_id)
            }
            ClientCommand::GuildDisband {} => self.apply_guild_disband(config),
            ClientCommand::PurchaseTravelTicket { .. }
            | ClientCommand::UseTravelTicket { .. }
            | ClientCommand::ToggleDoor { .. } => Err(AuthorityRejectReason::TargetUnavailable),
        }
    }

    pub(super) fn apply_set_posture(
        &mut self,
        config: &SliceAuthorityConfig,
        posture: &str,
    ) -> Result<(), AuthorityRejectReason> {
        enum PostureCommand {
            Kneel,
            Stand,
        }

        let command = match normalize_command_key(posture).as_str() {
            "kneel" | "kneeling" => PostureCommand::Kneel,
            "stand" | "standing" => PostureCommand::Stand,
            _ => return Err(AuthorityRejectReason::TargetUnavailable),
        };
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        let had_pending_resource_sample = actor.pending_resource_sample.take().is_some();
        let had_resource_sample_loop = actor.resource_sample_loop.take().is_some();
        let had_resource_sample = had_pending_resource_sample || had_resource_sample_loop;

        let mut cranked_extractor_id = None;
        let result = match (command, actor.posture) {
            (PostureCommand::Kneel, AuthorityActorPosture::Standing) => {
                actor.posture = AuthorityActorPosture::KneelingDown;
                actor.posture_until_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(POSTURE_KNEEL_DOWN_TICKS);
                Ok(())
            }
            (
                PostureCommand::Kneel,
                AuthorityActorPosture::KneelingDown | AuthorityActorPosture::Kneeling,
            ) if had_resource_sample => Ok(()),
            (
                PostureCommand::Stand,
                AuthorityActorPosture::KneelingDown | AuthorityActorPosture::Kneeling,
            ) => {
                actor.posture = AuthorityActorPosture::StandingUp;
                actor.posture_until_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(POSTURE_STAND_UP_TICKS);
                cranked_extractor_id = actor.cranking_extractor_id.take();
                Ok(())
            }
            _ => Err(AuthorityRejectReason::PostureLocked),
        };
        if let Some(extractor_id) = cranked_extractor_id {
            self.release_manual_extractor_if_unheld(&extractor_id);
        }
        result
    }

    pub(super) fn apply_debug_give_item(
        &mut self,
        config: &SliceAuthorityConfig,
        item_id: u32,
        variant_id: u32,
        quantity: u32,
        equip: bool,
    ) -> Result<(), AuthorityRejectReason> {
        if quantity == 0 {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let item_name = super::loot_tables::rolled_loot_item_name(item_id, variant_id)
            .or_else(|| inventory_item_name(item_id).map(str::to_owned))
            .ok_or(AuthorityRejectReason::UnknownItem)?;
        if !self
            .runtime
            .durable
            .actors
            .contains_key(&config.player_actor_id)
        {
            return Err(AuthorityRejectReason::UnknownActor);
        }
        let stack_cap = Self::inventory_stack_cap_for_item(item_id, quantity);
        self.add_actor_inventory_stack(
            &config.player_actor_id,
            item_id,
            variant_id,
            &item_name,
            quantity,
            stack_cap,
            "field-pack",
        );
        if equip {
            let weapon_id =
                weapon_id_for_inventory_item(item_id).ok_or(AuthorityRejectReason::UnknownItem)?;
            // Debug god-mode item injection bypasses the cert gate (QA setup).
            self.set_equipped_weapon_impl(config, Some(weapon_id), Some(item_id), None, false)?;
        }
        Ok(())
    }

    pub(super) fn apply_debug_grant_skill_boxes(
        &mut self,
        config: &SliceAuthorityConfig,
        skill_box_ids: &[String],
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        actor
            .professions
            .grant_skill_box_ids(skill_box_ids)
            .map_err(|_| AuthorityRejectReason::UnknownSkillBox)?;
        actor.capabilities = ActorCapabilityState::from_professions_and_grants(
            &actor.professions,
            &actor.capability_grants,
        );
        Ok(())
    }

    pub(super) fn apply_set_move_intent(
        &mut self,
        config: &SliceAuthorityConfig,
        dx: i32,
        dy: i32,
        facing: Option<CardinalDirection>,
        sprint_requested: bool,
    ) -> Result<(), AuthorityRejectReason> {
        if !matches!(dx, -1..=1) || !matches!(dy, -1..=1) {
            return Err(AuthorityRejectReason::InvalidMoveVector);
        }
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if dx == 0 && dy == 0 {
            actor.move_intent = None;
            if let Some(direction) = facing {
                actor.direction = cardinal_direction_delta(direction).2.to_owned();
            }
            return Ok(());
        }
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        if actor.posture != AuthorityActorPosture::Standing {
            return Err(AuthorityRejectReason::PostureLocked);
        }
        let expires_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(u64::from(self.runtime.durable.world.tick_rate_hz.max(1)));
        actor.pending_resource_sample = None;
        actor.resource_sample_loop = None;
        actor.move_intent = Some(MoveIntentAuthorityState {
            dx,
            dy,
            facing,
            sprint: sprint_requested,
            updated_tick: self.runtime.durable.tick,
            expires_tick,
        });
        actor.direction = facing
            .map(|direction| cardinal_direction_delta(direction).2)
            .unwrap_or_else(|| direction_for_delta(dx, dy))
            .to_owned();
        Ok(())
    }

    pub(super) fn apply_move(
        &mut self,
        config: &SliceAuthorityConfig,
        issued_at_tick: u64,
        dx: i32,
        dy: i32,
        duration_ticks: u16,
        facing: Option<CardinalDirection>,
        sprint_requested: bool,
    ) -> Result<(), AuthorityRejectReason> {
        if duration_ticks == 0 || duration_ticks > MAX_MOVE_DURATION_TICKS {
            return Err(AuthorityRejectReason::InvalidMoveDuration);
        }
        if !valid_move_vector(dx, dy) {
            return Err(AuthorityRejectReason::InvalidMoveVector);
        }

        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        if actor.posture != AuthorityActorPosture::Standing {
            return Err(AuthorityRejectReason::PostureLocked);
        }
        let movement_tick = if issued_at_tick > self.runtime.durable.tick
            && issued_at_tick.saturating_sub(self.runtime.durable.tick)
                <= MAX_MOVE_ISSUED_AT_FUTURE_TICKS
        {
            issued_at_tick
        } else {
            self.runtime.durable.tick
        };
        if movement_tick < actor.next_move_tick {
            return Err(AuthorityRejectReason::MoveCooldown);
        }
        let area = self
            .runtime
            .durable
            .world
            .areas
            .get(&actor.area_id)
            .ok_or(AuthorityRejectReason::UnknownArea)?;
        let sprint_cost_milli = actor_sprint_action_cost_milli(
            actor,
            duration_ticks,
            self.runtime.durable.world.tick_rate_hz,
        );
        let sprint_available_milli = actor
            .vitals
            .action
            .max(0)
            .saturating_mul(1_000)
            .saturating_sub(actor.sprint_action_drain_milli.max(0));
        let sprinting = sprint_requested
            && is_player_like_role(&actor.role)
            && !actor.sprint_recovery_locked
            && sprint_available_milli >= sprint_cost_milli;
        let movement_multiplier_milli = if sprinting {
            scaled_milli(
                movement_speed_multiplier_milli_for_actor(actor),
                scaled_milli(
                    SPRINT_SPEED_MULTIPLIER_MILLI,
                    sprint_speed_multiplier_milli_for_actor(actor),
                ),
            )
        } else {
            movement_speed_multiplier_milli_for_actor(actor)
        };
        let distance_milli = movement_distance_milli(
            duration_ticks,
            self.runtime.durable.world.tick_rate_hz,
            movement_multiplier_milli,
        );
        let requested_position = actor.position.offset(dx, dy, distance_milli);
        let target_position = self.clamped_unblocked_player_position(
            &actor.area_id,
            actor.position,
            requested_position,
            area,
        );
        if target_position == actor.position {
            if requested_position.clamp_to_area(area) == actor.position {
                return Err(AuthorityRejectReason::OutOfBounds);
            }
            return Err(AuthorityRejectReason::BlockedCell);
        }
        let target = target_position.cell();

        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let moved_milli = position_distance_milli(actor.position, target_position);
        actor.position = target_position;
        actor.cell = target;
        actor.stats.record_distance(
            movement_tick,
            self.runtime.durable.world.tick_rate_hz,
            moved_milli,
        );
        actor.last_moved_tick = Some(movement_tick);
        if sprinting {
            let sprint_action_cost = actor_sprint_action_cost_milli(
                actor,
                duration_ticks,
                self.runtime.durable.world.tick_rate_hz,
            );
            apply_sprint_action_cost(
                actor,
                duration_ticks,
                self.runtime.durable.world.tick_rate_hz,
            );
            if actor.vitals.action <= 0 {
                actor.sprint_recovery_locked = true;
                actor.sprint_recovery_regen_carry = 0;
                actor.passive_regen_milli.action = 0;
            }
            actor.sprint_regen_block_until_tick = actor.sprint_regen_block_until_tick.max(
                movement_tick
                    .saturating_add(u64::from(duration_ticks.max(1)))
                    .saturating_add(SPRINT_REGEN_BLOCK_GRACE_TICKS),
            );
            actor.mobility.record_sprint(
                movement_tick,
                duration_ticks,
                moved_milli,
                sprint_action_cost,
                false,
                "player_command",
            );
        }
        actor.next_move_tick = movement_tick.saturating_add(u64::from(duration_ticks));
        actor.move_intent = None;
        actor.pending_resource_sample = None;
        actor.resource_sample_loop = None;
        let cranked_extractor_id = actor.cranking_extractor_id.take();
        actor.direction = facing
            .map(|direction| cardinal_direction_delta(direction).2)
            .unwrap_or_else(|| direction_for_delta(dx, dy))
            .to_owned();
        if let Some(extractor_id) = cranked_extractor_id {
            self.release_manual_extractor_if_unheld(&extractor_id);
        }
        Ok(())
    }

    pub(super) fn apply_transition(
        &mut self,
        config: &SliceAuthorityConfig,
        transition_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        let transition = self
            .runtime
            .durable
            .world
            .transitions
            .get(transition_id)
            .ok_or(AuthorityRejectReason::UnknownTransition)?;
        if actor.area_id != transition.from_area_id {
            return Err(AuthorityRejectReason::WrongTransitionArea);
        }
        if !transition.contains_trigger(actor.position) {
            return Err(AuthorityRejectReason::NotAtTransitionTrigger);
        }
        if self
            .runtime
            .durable
            .world
            .blocked_cells
            .contains(&CellKey::new(
                &transition.to_area_id,
                transition.to_cell.x,
                transition.to_cell.y,
            ))
        {
            return Err(AuthorityRejectReason::BlockedCell);
        }

        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        actor.area_id = transition.to_area_id.clone();
        actor.cell = transition.to_cell;
        actor.position = AuthorityPosition::from_cell(transition.to_cell);
        actor.direction = transition.to_facing.clone();
        actor.pending_resource_sample = None;
        actor.resource_sample_loop = None;
        Ok(())
    }

    pub(super) fn apply_consumable(
        &mut self,
        config: &SliceAuthorityConfig,
        item_id: &str,
        item_numeric_id: Option<u32>,
        variant_id: Option<u32>,
    ) -> Result<(), AuthorityRejectReason> {
        let normalized_item_id = normalize_item_command_id(item_id);
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        let item = consumable_command_item(&normalized_item_id, item_numeric_id)?;
        // MEDIC WAVE (F-M1, owner-ratified): stim USE is OPEN to anyone — universal-use rule,
        // only CRAFTING is medic-gated. The prior medic-novice USE gate is removed on
        // purpose (it stranded non-medics' respawn stimpaks); a trained medic still
        // heals MORE via medicine_use_bonus. `actor` remains read for the life check.
        let _ = &actor;
        match item {
            ConsumableCommandItem::StimpakA => {
                self.apply_stimpak_a_variant(&config.player_actor_id, variant_id)
            }
            ConsumableCommandItem::AdvancedStimpak => {
                self.apply_advanced_stimpak_variant(&config.player_actor_id, variant_id)
            }
            ConsumableCommandItem::FieldBandage => {
                self.apply_field_bandage_variant(&config.player_actor_id, variant_id)
            }
            ConsumableCommandItem::BodyEnhancementPackA => self.apply_enhancement_pack_variant(
                &config.player_actor_id,
                MedicalSchematicKind::BodyEnhancementPackA,
                variant_id,
            ),
            ConsumableCommandItem::SpiritEnhancementPackA => self.apply_enhancement_pack_variant(
                &config.player_actor_id,
                MedicalSchematicKind::SpiritEnhancementPackA,
                variant_id,
            ),
            ConsumableCommandItem::AntiDizzyStim => self.apply_anti_state_stim_variant(
                &config.player_actor_id,
                MedicalSchematicKind::AntiDizzyStim,
                variant_id,
            ),
            ConsumableCommandItem::AntiBlindStim => self.apply_anti_state_stim_variant(
                &config.player_actor_id,
                MedicalSchematicKind::AntiBlindStim,
                variant_id,
            ),
        }
    }

    pub(super) fn apply_ammo_refill(
        &mut self,
        config: &SliceAuthorityConfig,
        item_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        let item = ammo_item_id_from_command(item_id).ok_or(AuthorityRejectReason::UnknownItem)?;
        self.refill_actor_ammo_from_stockpile(&config.player_actor_id, item)?;
        Ok(())
    }

    pub(super) fn apply_service_buff(
        &mut self,
        config: &SliceAuthorityConfig,
        effect_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let normalized_effect_id = normalize_item_command_id(effect_id);
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        let (canonical_effect_id, body_delta, spirit_delta) = match normalized_effect_id.as_str() {
            "medic_prep" => (MEDIC_PREP_EFFECT_ID, MEDIC_PREP_BODY_DELTA, 0),
            "entertainer_session" => (
                ENTERTAINER_SESSION_EFFECT_ID,
                0,
                ENTERTAINER_SESSION_SPIRIT_DELTA,
            ),
            _ => return Err(AuthorityRejectReason::UnknownEffect),
        };
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor
            .service_buffs
            .iter()
            .any(|buff| buff.effect_id == canonical_effect_id)
        {
            return Ok(());
        }
        actor.service_buffs.push(ServiceBuffAuthorityState {
            effect_id: canonical_effect_id.to_owned(),
            remaining_ticks: service_buff_duration_ticks(self.runtime.durable.world.tick_rate_hz),
            total_ticks: service_buff_duration_ticks(self.runtime.durable.world.tick_rate_hz),
            body_delta,
            spirit_delta,
            defense_vs_state_milli: 0,
        });
        refresh_actor_effective_stats(actor);
        Ok(())
    }
    pub(super) fn apply_clone_respawn(
        &mut self,
        config: &SliceAuthorityConfig,
        facility_id: Option<&str>,
    ) -> Result<(), AuthorityRejectReason> {
        self.clone_respawn_actor_id(&config.player_actor_id, facility_id)
    }

    pub(super) fn clone_respawn_actor_id(
        &mut self,
        actor_id: &str,
        facility_id: Option<&str>,
    ) -> Result<(), AuthorityRejectReason> {
        let facility = {
            let actor = self
                .runtime
                .durable
                .actors
                .get(actor_id)
                .ok_or(AuthorityRejectReason::UnknownActor)?;
            let lethal_clone_eligible = (actor.life_state == AuthorityLifeState::Downed
                && actor.body_vanish_tick > 0)
                || (actor.life_state == AuthorityLifeState::Respawning && actor.respawn_tick > 0);
            if !Self::uses_player_like_revivable_state(actor) || !lethal_clone_eligible {
                return Err(AuthorityRejectReason::InvalidCloneRespawn);
            }
            match facility_id {
                Some(facility_id) => self
                    .clone_facility_by_id(facility_id)
                    .ok_or(AuthorityRejectReason::UnknownCloneFacility)?,
                None => self
                    .nearest_clone_facility_for_actor(actor)
                    .ok_or(AuthorityRejectReason::NoCloneFacility)?,
            }
        };
        let player_like = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .is_some_and(|actor| is_player_like_role(&actor.role));
        if player_like {
            self.prepare_clone_corpse(actor_id);
        }
        let restore_field_pack = {
            let actor = self
                .runtime
                .durable
                .actors
                .get_mut(actor_id)
                .ok_or(AuthorityRejectReason::UnknownActor)?;
            if actor.life_state == AuthorityLifeState::Alive {
                return Err(AuthorityRejectReason::InvalidCloneRespawn);
            }
            let restore_field_pack = is_player_like_role(&actor.role);
            Self::respawn_actor(self.runtime.durable.tick, actor, Some(&facility));
            restore_field_pack
        };
        if restore_field_pack {
            self.reset_clone_inventory(actor_id)?;
            self.restore_skill_backup_after_clone(actor_id);
        } else {
            self.restore_player_like_respawn_supplies(actor_id)?;
        }
        Ok(())
    }

    fn clone_facility_by_id(&self, facility_id: &str) -> Option<CloneFacilityAuthorityState> {
        self.runtime
            .durable
            .world
            .clone_facilities
            .iter()
            .find(|facility| facility.id == facility_id)
            .cloned()
    }

    fn nearest_clone_facility_for_actor(
        &self,
        actor: &ActorAuthorityState,
    ) -> Option<CloneFacilityAuthorityState> {
        self.runtime
            .durable
            .world
            .clone_facilities
            .iter()
            .filter(|facility| facility.area_id == actor.area_id)
            .min_by_key(|facility| {
                (
                    position_distance_milli(
                        actor.position,
                        AuthorityPosition::from_cell(facility.respawn_cell),
                    ),
                    facility.id.clone(),
                )
            })
            .or_else(|| {
                self.runtime
                    .durable
                    .world
                    .clone_facilities
                    .iter()
                    .min_by_key(|facility| {
                        (
                            position_distance_milli(
                                actor.position,
                                AuthorityPosition::from_cell(facility.respawn_cell),
                            ),
                            facility.id.clone(),
                        )
                    })
            })
            .cloned()
    }

    pub(super) fn apply_revive_actor(
        &mut self,
        config: &SliceAuthorityConfig,
        target_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let medic = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if medic.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if medic.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        if !actor_has_capability(&medic, AUTHORITY_CAPABILITY_REVIVE_BASIC) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if self.actor_inventory_available_quantity(&medic.id, RESUSCITATION_KIT_ITEM_ID) == 0 {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let target = self
            .runtime
            .durable
            .actors
            .get(target_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        let target_revivable = (target.body_vanish_tick > 0
            && self.runtime.durable.tick < target.body_vanish_tick)
            || target.incap_expires_tick > self.runtime.durable.tick;
        if target.id == medic.id
            || !Self::uses_player_like_revivable_state(&target)
            || target.life_state != AuthorityLifeState::Downed
            || !target_revivable
        {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if target.area_id != medic.area_id
            || position_distance_milli(medic.position, target.position)
                > REVIVE_INTERACTION_RADIUS_MILLI_CELLS
        {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if self.revive_target_has_hostile_pressure(&medic, &target) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        self.ensure_actor_economy_action_ready(&medic.id)?;
        self.consume_actor_inventory_quantity(&medic.id, RESUSCITATION_KIT_ITEM_ID, 1)?;
        // Medic trauma track: revived vitals 25%->60%, revive cast -0..-50%, and the revived
        // target's residual clone-sickness is cleansed -0..-40% by a trauma-trained medic.
        let revive_vitals_percent = medic.professions.medic_trauma_revive_vitals_percent();
        let clone_sickness_reduction_milli = medic
            .professions
            .medic_trauma_clone_sickness_reduction_milli()
            .clamp(0, 1_000) as u64;
        let revive_cast_reduction_milli = medic
            .professions
            .medic_trauma_revive_cast_reduction_milli()
            .clamp(0, 900) as u64;
        let revive_ms =
            REVIVE_ACTION_MS.saturating_mul(1_000 - revive_cast_reduction_milli) / 1_000;
        let target_cell = {
            let target = self
                .runtime
                .durable
                .actors
                .get_mut(target_actor_id)
                .ok_or(AuthorityRejectReason::UnknownActor)?;
            Self::revive_actor_from_corpse(target, revive_vitals_percent);
            target.clone_sickness_ticks = target
                .clone_sickness_ticks
                .saturating_mul(1_000 - clone_sickness_reduction_milli)
                / 1_000;
            target.cell
        };
        self.set_actor_economy_action_cooldown(&medic.id, revive_ms)?;
        let total_xp = self.award_profession_track_xp(
            &medic.id,
            AuthorityProfessionKind::Medic,
            "trauma",
            90,
        )?;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} revived {} with a Resuscitation Kit (+90 Medic XP, total {total_xp})",
                medic.id, target_actor_id
            ),
            cell: Some(CellSnapshot::new(target_cell.x, target_cell.y)),
        });
        Ok(())
    }

    pub(super) fn revive_target_has_hostile_pressure(
        &self,
        medic: &ActorAuthorityState,
        target: &ActorAuthorityState,
    ) -> bool {
        self.runtime.durable.actors.values().any(|candidate| {
            let pressure_radius = if skirmisher_enemy_applies_ranged_pressure(candidate) {
                REVIVE_HOSTILE_PRESSURE_RADIUS_MILLI_CELLS
            } else {
                REVIVE_CLOSE_HOSTILE_PRESSURE_RADIUS_MILLI_CELLS
            };
            candidate.id != medic.id
                && candidate.id != target.id
                && candidate.area_id == medic.area_id
                && candidate.life_state == AuthorityLifeState::Alive
                && candidate.sleep.remaining_ticks == 0
                && self.can_actor_attack(candidate, medic)
                && (position_distance_milli(candidate.position, target.position) <= pressure_radius
                    || position_distance_milli(candidate.position, medic.position)
                        <= pressure_radius)
        })
    }

    fn apply_stimpak_a_variant(
        &mut self,
        actor_id: &str,
        variant_id: Option<u32>,
    ) -> Result<(), AuthorityRejectReason> {
        self.apply_stimpak_heal_variant(
            actor_id,
            MedicalSchematicKind::StimpakA,
            STIMPAK_A_ITEM_ID,
            "stimpak_a",
            "stimpak_a_heal",
            variant_id,
        )
    }

    fn apply_advanced_stimpak_variant(
        &mut self,
        actor_id: &str,
        variant_id: Option<u32>,
    ) -> Result<(), AuthorityRejectReason> {
        self.apply_stimpak_heal_variant(
            actor_id,
            MedicalSchematicKind::AdvancedStimpak,
            ADVANCED_STIMPAK_ITEM_ID,
            "advanced_stimpak",
            "advanced_stimpak_heal",
            variant_id,
        )
    }

    /// MEDIC WAVE: shared stimpak heal-over-time (basic + advanced). USE is open to
    /// anyone (F-M1); a trained medic still heals more (medicine_use_bonus) and
    /// longer between reuses (medicine_use_speed). Only ONE stimpak heal ticks at a
    /// time (basic OR advanced) — no double-stacking heals.
    fn apply_stimpak_heal_variant(
        &mut self,
        actor_id: &str,
        kind: MedicalSchematicKind,
        item_numeric_id: u32,
        item_id_str: &str,
        effect_id: &str,
        variant_id: Option<u32>,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.consumable_effects.iter().any(|effect| {
            effect.effect_id == "stimpak_a_heal" || effect.effect_id == "advanced_stimpak_heal"
        }) {
            return Ok(());
        }
        let medicine_use_bonus = actor.professions.medicine_use_bonus();
        let base_ticks = consumable_duration_ticks(
            STIMPAK_A_DURATION_MS,
            self.runtime.durable.world.tick_rate_hz,
        );
        let total_ticks = consumable_duration_ticks_for_speed(
            base_ticks,
            actor.professions.medicine_use_speed_milli(),
        );
        let consumed_variant =
            self.consume_consumable_variant_or_any(actor_id, item_numeric_id, variant_id)?;
        let crafted_stats = decode_medical_variant_or_default(kind, consumed_variant);
        let heal_remaining_milli = medical_stimpak_heal_milli(crafted_stats, medicine_use_bonus);
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        actor
            .consumable_effects
            .push(ConsumableEffectAuthorityState {
                item_id: item_id_str.to_owned(),
                effect_id: effect_id.to_owned(),
                remaining_ticks: total_ticks,
                total_ticks,
                heal_remaining_milli,
                accumulated_heal_milli: 0,
            });
        Ok(())
    }

    /// Anti-state stims apply the unified `defense_vs_state` buff. Crafted
    /// potency sets its permille value and the combat-state subsystem owns
    /// clearing and short per-kind immunity windows.
    fn apply_anti_state_stim_variant(
        &mut self,
        actor_id: &str,
        kind: MedicalSchematicKind,
        variant_id: Option<u32>,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        let consumed_variant =
            self.consume_consumable_variant_or_any(actor_id, kind.item_id(), variant_id)?;
        let crafted_stats = decode_medical_variant_or_default(kind, consumed_variant);
        let defense_milli = anti_state_defense_vs_state_milli(crafted_stats.potency);
        let total_ticks = ms_to_ticks_round(
            ANTI_STATE_DEFENSE_BUFF_DURATION_MS,
            self.runtime.durable.world.tick_rate_hz,
        )
        .max(1);
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        // ONE unified defense buff (owner law: no per-state defense stats). Both
        // anti-dizzy and anti-blind refresh the same buff; take the stronger magnitude.
        if let Some(existing) = actor
            .service_buffs
            .iter_mut()
            .find(|buff| buff.effect_id == STATE_DEFENSE_EFFECT_ID)
        {
            existing.defense_vs_state_milli = existing.defense_vs_state_milli.max(defense_milli);
            existing.remaining_ticks = total_ticks;
            existing.total_ticks = total_ticks;
        } else {
            actor.service_buffs.push(ServiceBuffAuthorityState {
                effect_id: STATE_DEFENSE_EFFECT_ID.to_owned(),
                remaining_ticks: total_ticks,
                total_ticks,
                body_delta: 0,
                spirit_delta: 0,
                defense_vs_state_milli: defense_milli,
            });
        }
        refresh_actor_effective_stats(actor);
        Ok(())
    }

    fn apply_field_bandage_variant(
        &mut self,
        actor_id: &str,
        variant_id: Option<u32>,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.bleed_stacks.is_empty() {
            return Ok(());
        }
        self.consume_consumable_variant_or_any(actor_id, FIELD_BANDAGE_ITEM_ID, variant_id)?;
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let stack_index = actor
            .bleed_stacks
            .iter()
            .enumerate()
            .max_by_key(|(_, stack)| stack.damage_milli_per_tick)
            .map(|(index, _)| index)
            .unwrap_or(0);
        actor.bleed_stacks.remove(stack_index);
        if actor.bleed_stacks.is_empty() {
            actor.downed_action_drain_milli = 0;
            actor.downed_spirit_drain_milli = 0;
        }
        Ok(())
    }

    fn apply_enhancement_pack_variant(
        &mut self,
        actor_id: &str,
        kind: MedicalSchematicKind,
        variant_id: Option<u32>,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        // MEDIC WAVE (F-M1): buff-pack USE is open to anyone (earlier sandbox design); crafting is gated.
        let (effect_id, body_pack) = match kind {
            MedicalSchematicKind::BodyEnhancementPackA => (MEDIC_PREP_EFFECT_ID, true),
            MedicalSchematicKind::SpiritEnhancementPackA => (ENTERTAINER_SESSION_EFFECT_ID, false),
            MedicalSchematicKind::StimpakA
            | MedicalSchematicKind::AdvancedStimpak
            | MedicalSchematicKind::AntiDizzyStim
            | MedicalSchematicKind::AntiBlindStim => {
                return Err(AuthorityRejectReason::UnknownItem)
            }
        };
        if actor
            .service_buffs
            .iter()
            .any(|buff| buff.effect_id == effect_id)
        {
            return Ok(());
        }
        let medicine_use_bonus = actor.professions.medicine_use_bonus();
        let consumed_variant =
            self.consume_consumable_variant_or_any(actor_id, kind.item_id(), variant_id)?;
        let crafted_stats = decode_medical_variant_or_default(kind, consumed_variant);
        let delta = medical_enhancement_delta(crafted_stats, medicine_use_bonus);
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        actor.service_buffs.push(ServiceBuffAuthorityState {
            effect_id: effect_id.to_owned(),
            remaining_ticks: service_buff_duration_ticks(self.runtime.durable.world.tick_rate_hz),
            total_ticks: service_buff_duration_ticks(self.runtime.durable.world.tick_rate_hz),
            body_delta: if body_pack { delta } else { 0 },
            spirit_delta: if body_pack { 0 } else { delta },
            defense_vs_state_milli: 0,
        });
        refresh_actor_effective_stats(actor);
        Ok(())
    }

    fn consume_consumable_variant_or_any(
        &mut self,
        actor_id: &str,
        item_id: u32,
        variant_id: Option<u32>,
    ) -> Result<u32, AuthorityRejectReason> {
        if let Some(variant_id) = variant_id {
            self.consume_actor_inventory_variant(actor_id, item_id, variant_id, 1)
                .map_err(|_| AuthorityRejectReason::ItemUnavailable)?;
            return Ok(variant_id);
        }
        let Some((row_index, consumed_variant)) = self
            .runtime
            .durable
            .inventory
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                row.item_id == item_id
                    && row.available > 0
                    && actor_owns_inventory_container(actor_id, &row.container)
            })
            .max_by_key(|(_, row)| (row.variant_id, row.available))
            .map(|(index, row)| (index, row.variant_id))
        else {
            return Err(AuthorityRejectReason::ItemUnavailable);
        };
        self.consume_inventory_row(row_index)?;
        Ok(consumed_variant)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConsumableCommandItem {
    StimpakA,
    AdvancedStimpak,
    FieldBandage,
    BodyEnhancementPackA,
    SpiritEnhancementPackA,
    AntiDizzyStim,
    AntiBlindStim,
}

fn consumable_command_item(
    normalized_item_id: &str,
    item_numeric_id: Option<u32>,
) -> Result<ConsumableCommandItem, AuthorityRejectReason> {
    if let Some(item_numeric_id) = item_numeric_id {
        return match item_numeric_id {
            STIMPAK_A_ITEM_ID => Ok(ConsumableCommandItem::StimpakA),
            ADVANCED_STIMPAK_ITEM_ID => Ok(ConsumableCommandItem::AdvancedStimpak),
            FIELD_BANDAGE_ITEM_ID => Ok(ConsumableCommandItem::FieldBandage),
            BODY_ENHANCEMENT_PACK_A_ITEM_ID => Ok(ConsumableCommandItem::BodyEnhancementPackA),
            SPIRIT_ENHANCEMENT_PACK_A_ITEM_ID => Ok(ConsumableCommandItem::SpiritEnhancementPackA),
            ANTI_DIZZY_STIM_ITEM_ID => Ok(ConsumableCommandItem::AntiDizzyStim),
            ANTI_BLIND_STIM_ITEM_ID => Ok(ConsumableCommandItem::AntiBlindStim),
            _ => Err(AuthorityRejectReason::UnknownItem),
        };
    }
    match normalized_item_id {
        "stimpak_a" => Ok(ConsumableCommandItem::StimpakA),
        "advanced_stimpak" | "stimpak_advanced" => Ok(ConsumableCommandItem::AdvancedStimpak),
        "field_bandage" => Ok(ConsumableCommandItem::FieldBandage),
        "body_enhancement_pack" | "body_enhancement_pack_a" | "body_pack" => {
            Ok(ConsumableCommandItem::BodyEnhancementPackA)
        }
        "spirit_enhancement_pack" | "spirit_enhancement_pack_a" | "spirit_pack" => {
            Ok(ConsumableCommandItem::SpiritEnhancementPackA)
        }
        "anti_dizzy_stim" | "anti_dizzy" => Ok(ConsumableCommandItem::AntiDizzyStim),
        "anti_blind_stim" | "anti_blind" => Ok(ConsumableCommandItem::AntiBlindStim),
        _ => Err(AuthorityRejectReason::UnknownItem),
    }
}

pub(super) fn normalize_command_key(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}
